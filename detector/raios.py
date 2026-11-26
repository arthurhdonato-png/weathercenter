"""Nowcasting de tempestades pelos raios vistos do espaço (GOES-19, sensor GLM).

O GLM fotografa a América do Sul inteira e publica um arquivo a cada 20 segundos (latência
de ~1 minuto). Isso cobre todo o Brasil, inclusive onde não há radar.

A cada execução:
1. lê os arquivos novos e guarda os raios (flashes) dos últimos 40 min;
2. agrupa os raios dos últimos 10 min em tempestades (áreas com muitos raios);
3. mede o deslocamento de cada tempestade comparando os raios de 10 em 10 minutos
   (e usa o vento dos modelos quando há poucos raios);
4. detecta o "salto de raios" (lightning jump), aumento brusco da taxa de raios que costuma
   anteceder granizo, vendaval e tornado em 10 a 30 minutos;
5. projeta a tempestade 60 min à frente e lista as cidades no caminho com o horário estimado.
"""
import io
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

import numpy as np
from scipy import ndimage

from comum import (UTC, INSTRUCOES, alerta, baixar, contornos, dbg, hora_local, iso, log, rumo_texto)
import modelos

BUCKET = 'https://noaa-goes19.s3.amazonaws.com'
N, S, O, L = 6.0, -35.0, -75.0, -33.0
G = 0.05                                    # grade de 0,05° (~5,5 km)
LATS = np.round(np.arange(N - G / 2, S, -G), 4)
LONS = np.round(np.arange(O + G / 2, L, G), 4)
JANELA = 10                                 # min: raios usados para achar as tempestades
GUARDAR = 40                                # min de raios guardados entre execuções
HORIZONTE = 60                              # min de projeção
_TRAVA = threading.Lock()
RE_INICIO = re.compile(r'_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)')


# ---------------------------------------------------------------- leitura
def _inicio_arquivo(chave):
    m = RE_INICIO.search(chave)
    if not m:
        return None
    a, d, h, mi, s, _ = (int(x) for x in m.groups())
    return datetime(a, 1, 1, h, mi, s, tzinfo=UTC) + timedelta(days=d - 1)


def listar(ref, minutos):
    """Chaves dos arquivos do GLM que começam nos últimos `minutos` antes de ref."""
    chaves = []
    horas = {(ref - timedelta(minutes=m)).replace(minute=0, second=0, microsecond=0) for m in (0, minutos)}
    for h in sorted(horas):
        prefixo = f'GLM-L2-LCFA/{h:%Y}/{h.timetuple().tm_yday:03d}/{h:%H}/'
        token = None
        while True:
            url = f'{BUCKET}/?list-type=2&prefix={prefixo}' + (f'&continuation-token={_q(token)}' if token else '')
            xml = baixar(url, timeout=30).decode()
            chaves += re.findall(r'<Key>([^<]+\.nc)</Key>', xml)
            m = re.search(r'<NextContinuationToken>([^<]+)</NextContinuationToken>', xml)
            if not m:
                break
            token = m.group(1)
    ini = ref - timedelta(minutes=minutos)
    return sorted(k for k in chaves if (t := _inicio_arquivo(k)) and ini <= t <= ref)


def _q(s):
    import urllib.parse
    return urllib.parse.quote(s, safe='')


def ler_arquivo(chave):
    """-> array (n, 3): tempo (s desde 1970), lat, lon dos raios no recorte do Brasil."""
    import netCDF4
    dados = baixar(f'{BUCKET}/{chave}', timeout=40, tentativas=3)
    with _TRAVA, netCDF4.Dataset('glm', memory=dados) as d:   # a biblioteca HDF5 não aceita leituras paralelas
        lat = np.asarray(d['flash_lat'][:], float)
        lon = np.asarray(d['flash_lon'][:], float)
        off = np.asarray(d['flash_time_offset_of_first_event'][:], float)
        q = np.asarray(d['flash_quality_flag'][:], int) if 'flash_quality_flag' in d.variables else np.zeros(len(lat), int)
        unid = d['flash_time_offset_of_first_event'].units  # "seconds since 2025-11-07 18:00:00.000"
    base = datetime.fromisoformat(unid.split('since')[1].strip().replace(' ', 'T')[:19]).replace(tzinfo=UTC)
    t = base.timestamp() + off
    ok = (q == 0) & (lat <= N) & (lat >= S) & (lon >= O) & (lon <= L)
    return np.column_stack([t[ok], lat[ok], lon[ok]])


def atualizar_raios(estado, ref):
    """Lê os arquivos novos e devolve (flashes dos últimos GUARDAR min, estado novo, t_dados)."""
    antigos = set(estado.get('arquivos', []))
    chaves = listar(ref, GUARDAR)
    novas = [k for k in chaves if k not in antigos]
    lidos = []
    falhas = 0
    with ThreadPoolExecutor(8) as ex:
        for k, r in zip(novas, ex.map(_ler_seguro, novas)):
            if r is None:
                falhas += 1
            else:
                lidos.append(r)
    flashes = np.array(estado.get('flashes', []), float).reshape(-1, 3)
    if lidos:
        flashes = np.vstack([flashes] + lidos)
    limite = (ref - timedelta(minutes=GUARDAR)).timestamp()
    flashes = flashes[(flashes[:, 0] >= limite) & (flashes[:, 0] <= ref.timestamp() + 60)]
    ultimo = max((_inicio_arquivo(k) for k in chaves), default=None)
    log(f'  GLM: {len(novas)} arquivo(s) novo(s), {falhas} falha(s), {len(flashes)} raios nos últimos {GUARDAR} min'
        + (f', último arquivo {hora_local(ultimo)}' if ultimo else ''))
    novo = {
        'arquivos': [k for k in chaves if k in antigos or k in novas],
        'flashes': [[int(t), round(a, 3), round(b, 3)] for t, a, b in flashes],
    }
    t_dados = (ultimo + timedelta(seconds=20)) if ultimo else ref
    return flashes, novo, t_dados


def _ler_seguro(k):
    try:
        return ler_arquivo(k)
    except Exception as e:
        dbg(f'GLM {k}: {e}')
        return None


# ---------------------------------------------------------------- análise
def grade(flashes):
    i = np.clip(((N - flashes[:, 1]) / G).astype(int), 0, len(LATS) - 1)
    j = np.clip(((flashes[:, 2] - O) / G).astype(int), 0, len(LONS) - 1)
    g = np.zeros((len(LATS), len(LONS)), np.float32)
    np.add.at(g, (i, j), 1)
    return g


def _densidade(g):
    """Raios num quadrado de 5x5 células (~27 km de lado) ao redor de cada ponto."""
    return ndimage.uniform_filter(g, size=5, mode='constant') * 25


def _deslocamento(a, b, caixa, max_cel=5):
    """Melhor deslocamento (dy, dx) em células que leva o campo a até o campo b (correlação)."""
    y0, y1, x0, x1 = caixa
    A = ndimage.gaussian_filter(a[y0:y1, x0:x1], 1.5)
    B = ndimage.gaussian_filter(b[y0:y1, x0:x1], 1.5)
    if A.sum() < 3 or B.sum() < 3:
        return None, 0
    melhor, pico = None, -1
    na = np.sqrt((A * A).sum()) * np.sqrt((B * B).sum())
    for dy in range(-max_cel, max_cel + 1):
        for dx in range(-max_cel, max_cel + 1):
            c = (np.roll(np.roll(A, dy, 0), dx, 1) * B).sum() / na
            if c > pico:
                pico, melhor = c, (dy, dx)
    return melhor, pico


def tempestades(flashes, t_fim, ambiente, municipios, anteriores, radar=None):
    """Identifica, acompanha e classifica as tempestades. Devolve (alertas, tempestades)."""
    t1 = t_fim.timestamp()
    jan = [flashes[(flashes[:, 0] > t1 - (k + 1) * 600) & (flashes[:, 0] <= t1 - k * 600)] for k in range(3)]
    g0, g1, g2 = (grade(f) for f in jan)               # g0 = últimos 10 min
    dens = _densidade(g0)
    # Uma tempestade = área ligada com pelo menos 10 raios em 10 min num quadrado de ~27 km
    mascara = dens >= 10
    rot, total = ndimage.label(mascara, structure=np.ones((3, 3)))
    if total == 0:
        return [], []
    dt_min = JANELA
    resultado = []
    objs = ndimage.find_objects(rot)
    for r in range(1, total + 1):
        sl = objs[r - 1]
        area = rot == r
        regiao = ndimage.binary_dilation(area[sl], iterations=2)
        n_raios = float(g0[sl][regiao].sum())
        dens_max = float(dens[sl][area[sl]].max()) / dt_min           # raios/min em ~27 km
        if n_raios < 15:
            continue
        ys, xs = np.nonzero(area)
        pesos = g0[ys, xs] + 0.01
        lat_c = float(np.average(LATS[ys], weights=pesos))
        lon_c = float(np.average(LONS[xs], weights=pesos))
        # Deslocamento: correlação entre as janelas de 10 min
        m = 8
        caixa = (max(0, sl[0].start - m), min(len(LATS), sl[0].stop + m), max(0, sl[1].start - m), min(len(LONS), sl[1].stop + m))
        d1, c1 = _deslocamento(g1, g0, caixa)
        d2, c2 = _deslocamento(g2, g1, caixa)
        est = [d for d, c in ((d1, c1), (d2, c2)) if d is not None and c >= 0.35]
        amb = modelos.ambiente_em(ambiente, lat_c, lon_c, t_fim) if ambiente else {}
        km_lat = 111.2
        km_lon = 111.2 * np.cos(np.radians(lat_c))
        if est:
            dy = float(np.mean([e[0] for e in est]))
            dx = float(np.mean([e[1] for e in est]))
            # células/10 min -> km/h (dy positivo = para o sul)
            vn = -dy * G * km_lat * 6
            ve = dx * G * km_lon * 6
            fonte_mov = 'raios'
        else:
            vn = ve = None
            fonte_mov = None
        if amb.get('passo_u') is not None and np.isfinite(amb['passo_u']):
            # tempestades andam em média a ~80% do vento médio entre 850 e 500 hPa
            mu, mv = 0.8 * amb['passo_u'] * 3.6, 0.8 * amb['passo_v'] * 3.6
            if vn is None:
                ve, vn, fonte_mov = mu, mv, 'vento dos modelos'
            else:
                ve, vn = 0.7 * ve + 0.3 * mu, 0.7 * vn + 0.3 * mv
                fonte_mov = 'raios e vento dos modelos'
        if vn is None:
            ve = vn = 0.0
            fonte_mov = 'parada'
        # suaviza com o histórico da mesma tempestade
        ant = _casar(anteriores, lat_c, lon_c, t_fim)
        if ant and ant.get('ve') is not None:
            ve, vn = 0.6 * ve + 0.4 * ant['ve'], 0.6 * vn + 0.4 * ant['vn']
        vel = float(np.hypot(ve, vn))
        if vel > 110:  # deslocamento impossível: provavelmente erro de pareamento
            ve, vn = ve * 110 / vel, vn * 110 / vel
            vel = 110.0
        # Salto de raios: taxa em blocos de 2 min nos últimos 30 min, na área da tempestade
        jump, serie = _salto(flashes, t1, area, sl, ve, vn, lat_c)
        taxa = n_raios / dt_min
        # radar (se houver) dentro da área
        dbz = radar.max_dbz(area) if radar is not None else None
        nivel, motivos = _classificar(dens_max, taxa, jump, amb, dbz)
        pico_t = int(t1)
        if ant and ant.get('nivel', 0) > nivel and (t1 - ant.get('picoT', 0)) <= 15 * 60:
            # histerese: mantém o nível por 15 min depois do pico, para o alerta não piscar
            nivel, pico_t = ant['nivel'], ant['picoT']
            motivos.append('nível mantido: a tempestade estava mais forte há poucos minutos')
        ident = ant['id'] if ant else f"r{int(t1) // 60 % 1000000}{int(lat_c * -10) % 1000:03d}{int(lon_c * -10) % 1000:03d}"
        tem = {'id': ident, 'lat': round(lat_c, 3), 'lon': round(lon_c, 3), 've': round(ve, 1), 'vn': round(vn, 1), 't': int(t1),
               'nivel': nivel, 'picoT': pico_t, 'taxa': round(taxa, 1), 'densMax': round(dens_max, 1), 'salto': jump,
               'serie': serie, 'dbz': dbz, 'movimento': fonte_mov, 'ambiente': {k: round(v, 1) for k, v in amb.items()},
               'inicio': ant.get('inicio', int(t1)) if ant else int(t1)}
        resultado.append(tem)
        if nivel == 0:
            continue
        a = _alerta(tem, area, dens, sl, motivos, municipios, t_fim)
        if a:
            resultado[-1]['alerta'] = a['id']
            yield_ = a
            resultado[-1]['_alerta'] = yield_
    alertas = [t.pop('_alerta') for t in resultado if '_alerta' in t]
    return alertas, resultado


def _casar(anteriores, lat, lon, t_fim):
    melhor, dmin = None, 1e9
    for a in anteriores or []:
        dt_h = (t_fim.timestamp() - a['t']) / 3600
        if dt_h < 0 or dt_h > 0.5:
            continue
        plat = a['lat'] + (a.get('vn') or 0) * dt_h / 111.2
        plon = a['lon'] + (a.get('ve') or 0) * dt_h / (111.2 * np.cos(np.radians(a['lat'])))
        d = float(np.hypot((plat - lat) * 111.2, (plon - lon) * 111.2 * np.cos(np.radians(lat))))
        if d < dmin:
            melhor, dmin = a, d
    return melhor if dmin <= 40 else None


def _salto(flashes, t1, area, sl, ve, vn, lat_c):
    """Lightning jump (Schultz et al., 2009, algoritmo 2σ) com blocos de 2 min."""
    blocos = 15
    reg = ndimage.binary_dilation(area[sl], iterations=3)
    y0, x0 = sl[0].start, sl[1].start
    taxas = []
    for k in range(blocos):
        a, b = t1 - (blocos - k) * 120, t1 - (blocos - k - 1) * 120
        f = flashes[(flashes[:, 0] > a) & (flashes[:, 0] <= b)]
        if not len(f):
            taxas.append(0.0)
            continue
        # leva os raios antigos para a posição atual da tempestade
        dt_h = (t1 - b) / 3600
        lat = f[:, 1] + vn * dt_h / 111.2
        lon = f[:, 2] + ve * dt_h / (111.2 * np.cos(np.radians(lat_c)))
        i = ((N - lat) / G).astype(int) - y0
        j = ((lon - O) / G).astype(int) - x0
        ok = (i >= 0) & (i < reg.shape[0]) & (j >= 0) & (j < reg.shape[1])
        taxas.append(float(reg[i[ok], j[ok]].sum()) / 2.0)  # raios/min
    taxas = np.array(taxas)
    d = np.diff(taxas) / 2.0                                  # variação (raios/min por min)
    jump = False
    if len(d) >= 8:
        hist = d[-8:-2]
        sigma = float(np.std(hist))
        recente = float(np.mean(d[-2:]))
        jump = bool(recente > max(2 * sigma, 1.0) and taxas[-1] >= 10)
    return jump, [round(float(x), 1) for x in taxas]


# Limiares de densidade de raios (raios por minuto num quadrado de ~27 km), calibrados com o
# surto de tempestades de 07/11/2025 no Sul (tornado de Rio Bonito do Iguaçu) e dias comuns de verão.
LIMIAR = {1: 6, 2: 15, 3: 30}


def _classificar(dens_max, taxa, jump, amb, dbz):
    """Nível da tempestade pelos raios, com reforço do ambiente do modelo e do radar."""
    motivos = [f'{dens_max:.0f} raios/min no núcleo (~27 km), {taxa:.0f}/min na tempestade toda']
    nivel = 0
    if dens_max >= LIMIAR[1]:
        nivel = 1
    if dens_max >= LIMIAR[2] or (jump and dens_max >= 0.6 * LIMIAR[2]):
        nivel = 2
    scp, stp, shear = amb.get('scp', 0), amb.get('stp', 0), amb.get('shear', 0)
    organizado = (shear >= 15) or scp >= 2
    if dens_max >= LIMIAR[3] and (organizado or jump or (not amb and dens_max >= 40)):
        nivel = 3
    if jump:
        motivos.append('salto brusco na taxa de raios (sinal de intensificação)')
    if nivel == 2 and (scp >= 4 or stp >= 1):
        motivos.append('ambiente favorável a supercélulas')
        nivel = 3
    elif nivel == 1 and jump and scp >= 2:
        nivel = 2
    if amb and organizado and nivel >= 2:
        motivos.append(f"cisalhamento do vento de {amb.get('shear', 0) * 3.6:.0f} km/h e CAPE de {amb.get('cape_mu', 0):.0f} J/kg")
    if dbz is not None:
        if dbz >= 60:
            motivos.append(f'radar: {dbz:.0f} dBZ (provável granizo)')
            nivel = min(3, max(nivel, 1) + 1)
        elif dbz >= 50:
            motivos.append(f'radar: {dbz:.0f} dBZ (chuva muito forte)')
            nivel = max(nivel, 1)
    return min(nivel, 3), motivos


def margem(ve, vn, lat_c):
    """Células de folga para caber o caminho de 60 min mais a incerteza."""
    return 4 + int(np.ceil(1.3 * max(abs(ve), abs(vn)) * HORIZONTE / 60 / (G * 111.2 * np.cos(np.radians(lat_c)))))


def projetar(nucleo, y0, x0, ve, vn, lat_c, municipios):
    """Arrasta a área da tempestade pelos próximos 60 min (de 5 em 5) com incerteza crescente.
    Devolve a máscara do caminho e {município: minutos até a chegada}."""
    km_lon = 111.2 * np.cos(np.radians(lat_c))
    base = ndimage.binary_dilation(nucleo, iterations=2)
    caminho = np.zeros_like(base)
    chegada = {}
    for minuto in range(0, HORIZONTE + 1, 5):
        h = minuto / 60
        dy = -vn * h / (111.2 * G)
        dx = ve * h / (km_lon * G)
        mov = ndimage.shift(base.astype(np.uint8), (dy, dx), order=0, mode='constant').astype(bool)
        cresc = int(round((2 + 0.25 * np.hypot(ve, vn) * h) / (G * 111.2)))   # incerteza: +25% da distância
        if cresc > 0:
            mov = ndimage.binary_dilation(mov, iterations=cresc)
        novo = mov & ~caminho
        if novo.any():
            for k in municipios.na_grade(novo, LATS[y0], LONS[x0], G):
                chegada.setdefault(int(k), minuto)
        caminho |= mov
    return caminho, chegada


def _alerta(tem, area, dens, sl, motivos, municipios, t_fim):
    """Área de 60 min à frente (com incerteza crescente) e cidades no caminho com horário."""
    ve, vn = tem['ve'], tem['vn']
    lat_c = tem['lat']
    km_lon = 111.2 * np.cos(np.radians(lat_c))
    m = margem(ve, vn, lat_c)
    y0, y1 = max(0, sl[0].start - m - 6), min(len(LATS), sl[0].stop + m + 6)
    x0, x1 = max(0, sl[1].start - m - 6), min(len(LONS), sl[1].stop + m + 6)
    # Só a parte ativa da tempestade (núcleos com pelo menos 1/4 do limiar do nível)
    nucleo = area[y0:y1, x0:x1] & (dens[y0:y1, x0:x1] >= max(10, 2.5 * LIMIAR[tem['nivel']]))
    if not nucleo.any():
        nucleo = area[y0:y1, x0:x1]
    caminho, chegada = projetar(nucleo, y0, x0, ve, vn, lat_c, municipios)
    if not chegada:
        return None
    idx = list(chegada)
    aneis = contornos(caminho, LATS[y0], LONS[x0], G, suavizar=3)
    nivel = tem['nivel']
    vel = float(np.hypot(ve, vn))
    rumo = (np.degrees(np.arctan2(ve, vn)) + 360) % 360
    andando = vel >= 8
    ordem = sorted(idx, key=lambda k: (chegada[k] > 0, -municipios.pop[k]))
    # Cidades principais com horário de chegada
    principais = sorted(idx, key=lambda k: -municipios.pop[k])[:8]
    horarios = []
    for k in sorted(principais, key=lambda k: chegada[k]):
        mnt = chegada[k]
        quando = 'agora' if mnt == 0 else f'~{mnt} min ({hora_local(t_fim + timedelta(minutes=mnt))})'
        horarios.append(f'{municipios.nome[k]}/{municipios.uf[k]}: {quando}')
    tipo = 'tempestade'
    amb = tem['ambiente']
    evento = 'Tempestade com muitos raios' if nivel == 1 else 'Tempestade severa' if nivel == 2 else 'Tempestade muito severa'
    if nivel >= 2 and (amb.get('stp', 0) >= 1 or (amb.get('scp', 0) >= 4 and tem['salto'])):
        tipo = 'tornado'
        evento = 'Tempestade severa com risco de tornado'
    alvo = ', '.join(municipios.nome[k] for k in ordem[:2])
    titulo = (f'{evento} se aproximando – {alvo}' if andando else f'{evento} – {alvo}')
    riscos = []
    if nivel == 1:
        riscos.append('Raios frequentes, chuva forte, rajadas de vento e granizo não descartado.')
    elif nivel == 2:
        riscos.append('Muitos raios, chuva muito forte, rajadas que podem passar de 60 km/h e possível granizo.')
    else:
        riscos.append('Tempestade muito intensa: vendaval (rajadas acima de 80 km/h), granizo e chuva torrencial.')
    if tipo == 'tornado':
        riscos.append('A tempestade está num ambiente favorável a tornados. Fique pronto para buscar abrigo.')
    if andando:
        riscos.append(f'Deslocamento para {rumo_texto(rumo)} a ~{vel:.0f} km/h ({tem["movimento"]}).')
    else:
        riscos.append('Tempestade quase parada: a chuva pode se acumular no mesmo lugar.')
    if horarios:
        riscos.append('Chegada estimada: ' + '; '.join(horarios) + '.')
    riscos.append('Detectado por: ' + '; '.join(motivos) + '.')
    riscos.append(f'Dados de satélite das {hora_local(t_fim)}. A área mostra o caminho previsto para os próximos {HORIZONTE} min.')
    return alerta(
        ident=f"raios-{tem['id']}", tipo=tipo, metodo='raios', nivel=nivel, titulo=titulo, evento=evento,
        inicio=t_fim, fim=t_fim + timedelta(minutes=HORIZONTE), riscos=riscos,
        instrucoes=INSTRUCOES['tornado' if tipo == 'tornado' else 'tempestade'],
        municipios=municipios, idx_mun=idx, poligonos=aneis, atualizado=t_fim,
        confianca='alta (raios observados por satélite agora)' if nivel else None,
        detalhes={'centro': [tem['lat'], tem['lon']], 'velocidadeKmh': round(vel), 'rumoGraus': round(float(rumo)),
                  'raiosPorMin': tem['taxa'], 'densidadeMax': tem['densMax'], 'salto': tem['salto'],
                  'chegadaMin': {municipios.ibge[k]: chegada[k] for k in idx}},
    )
