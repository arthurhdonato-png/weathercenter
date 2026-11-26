"""Previsão de eventos adversos a partir de dois modelos globais (GFS/NOAA e IFS/ECMWF).

Para cada modelo baixamos só os campos necessários (pedaços do arquivo GRIB2 publicado no
AWS Open Data), recortamos o Brasil, calculamos os "ingredientes" de tempo severo a cada 3 h
nas próximas 48 h e classificamos cada ponto (0,25°, ~27 km) em moderado/severo/extremo
para quatro tipos de evento: chuva, vento, tempestade e tornado. Depois juntamos os dois
modelos (consenso) e transformamos as áreas em alertas com polígono e lista de municípios.

Critérios completos em detector/CRITERIOS.md.
"""
import io
import json
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

import numpy as np
from scipy import ndimage

from comum import (UTC, INSTRUCOES, NOME_NIVEL, alerta, baixar, contornos, dbg, existe, iso, log)

# Recorte do Brasil (com margem)
LAT_N, LAT_S, LON_O, LON_L = 5.5, -34.5, -74.5, -32.5
PASSO = 0.25
LATS = np.round(np.arange(LAT_N, LAT_S - 1e-6, -PASSO), 3)
LONS = np.round(np.arange(LON_O, LON_L + 1e-6, PASSO), 3)
HORAS = list(range(0, 49, 3))
TIPOS = ['chuva', 'vento', 'tempestade', 'tornado']

_TRAVA = threading.Lock()
GFS = 'https://noaa-gfs-bdp-pds.s3.amazonaws.com'
ECMWF = 'https://ecmwf-forecasts.s3.amazonaws.com'
ECMWF_PORTAL = 'https://data.ecmwf.int/forecasts'

# (variável, nível) no índice .idx do GFS
CAMPOS_GFS = {
    'gust': ('GUST', 'surface'),
    'cape_sb': ('CAPE', 'surface'),
    'cape_mu': ('CAPE', '180-0 mb above ground'),
    'cin': ('CIN', 'surface'),
    'u10': ('UGRD', '10 m above ground'), 'v10': ('VGRD', '10 m above ground'),
    'u925': ('UGRD', '925 mb'), 'v925': ('VGRD', '925 mb'),
    'u850': ('UGRD', '850 mb'), 'v850': ('VGRD', '850 mb'),
    'u700': ('UGRD', '700 mb'), 'v700': ('VGRD', '700 mb'),
    'u500': ('UGRD', '500 mb'), 'v500': ('VGRD', '500 mb'),
    't2': ('TMP', '2 m above ground'), 'd2': ('DPT', '2 m above ground'),
    'sp': ('PRES', 'surface'),
    'fzl': ('HGT', '0C isotherm'),
    'refc': ('REFC', 'entire atmosphere'),
    'chuva_acum': ('APCP', 'surface'),   # acumulado desde o início da rodada
}
# param (e nível) no índice do ECMWF open data
CAMPOS_EC = {
    'gust': ('10fg', None), 'cape_mu': ('mucape', None), 'chuva_acum': ('tp', None),
    'u10': ('10u', None), 'v10': ('10v', None), 't2': ('2t', None), 'd2': ('2d', None), 'sp': ('sp', None),
    'u925': ('u', '925'), 'v925': ('v', '925'), 'u850': ('u', '850'), 'v850': ('v', '850'),
    'u700': ('u', '700'), 'v700': ('v', '700'), 'u500': ('u', '500'), 'v500': ('v', '500'),
}


# ---------------------------------------------------------------- download e leitura
def _decodificar(dados):
    """GRIB2 (uma ou mais mensagens) -> lista de campos já recortados no Brasil."""
    import eccodes
    res = []
    # eccodes não lê de BytesIO: usa mensagens a partir dos bytes
    pos = 0
    while True:
        i = dados.find(b'GRIB', pos)
        if i < 0:
            break
        tam = int.from_bytes(dados[i + 8:i + 16], 'big')
        with _TRAVA:
            res.append(_ler_msg(eccodes, dados[i:i + tam]))
        pos = i + tam
    return res


def _ler_msg(eccodes, msg):
    if True:
        gid = eccodes.codes_new_from_message(msg)
        try:
            ni, nj = eccodes.codes_get(gid, 'Ni'), eccodes.codes_get(gid, 'Nj')
            la1 = eccodes.codes_get(gid, 'latitudeOfFirstGridPointInDegrees')
            lo1 = eccodes.codes_get(gid, 'longitudeOfFirstGridPointInDegrees')
            dx = eccodes.codes_get(gid, 'iDirectionIncrementInDegrees')
            dy = eccodes.codes_get(gid, 'jDirectionIncrementInDegrees')
            neg = eccodes.codes_get(gid, 'jScansPositively') == 1
            v = eccodes.codes_get_values(gid).reshape(nj, ni)
            miss = eccodes.codes_get(gid, 'missingValue')
            v = np.where(v == miss, np.nan, v)
        finally:
            eccodes.codes_release(gid)
        return _recortar(v, la1, lo1, dx, dy, neg)


def _recortar(v, la1, lo1, dx, dy, lat_cresce):
    if lat_cresce:
        lats = la1 + np.arange(v.shape[0]) * dy
    else:
        lats = la1 - np.arange(v.shape[0]) * dy
    li = [int(np.argmin(np.abs(lats - la))) for la in LATS]
    lons = (lo1 + np.arange(v.shape[1]) * dx + 180) % 360 - 180
    lj = [int(np.argmin(np.abs(lons - lo))) for lo in LONS]
    return v[np.ix_(li, lj)].astype(np.float32)


def _baixar_trechos(url, trechos, folga=2_000_000):
    """trechos = [(nome, inicio, fim)] -> {nome: campo}. Junta trechos próximos (até `folga` bytes
    de distância) num só pedido: baixa um pouco a mais, mas faz bem menos pedidos ao servidor."""
    trechos = sorted(trechos, key=lambda t: t[1])
    grupos = []
    for t in trechos:
        if grupos and t[1] <= max(x[2] for x in grupos[-1]) + folga:
            grupos[-1].append(t)
        else:
            grupos.append([t])
    out = {}
    for g in grupos:
        ini, fim = g[0][1], max(t[2] for t in g)
        dados = baixar(url, timeout=90, intervalo=(ini, fim))
        for nome, a, b in g:
            campos = _decodificar(dados[a - ini:b - ini + 1])
            if campos:
                out[nome] = campos[0]
    return out


def _idx_gfs(texto, hora):
    linhas = [l.split(':') for l in texto.strip().splitlines()]
    offs = [int(l[1]) for l in linhas]
    trechos = []
    usados = set()
    for k, l in enumerate(linhas):
        var, nivel, fc = l[3], l[4], l[5]
        fim = offs[k + 1] - 1 if k + 1 < len(linhas) else offs[k] + 20_000_000
        for nome, (v, n) in CAMPOS_GFS.items():
            if nome in usados or var != v or nivel != n:
                continue
            if nome == 'chuva_acum':
                # só o acumulado desde a hora 0 ("0-N hour acc")
                if not re.match(rf'0-{hora} hour acc', fc):
                    continue
            elif 'ave' in fc or 'acc' in fc or 'max' in fc:
                continue
            trechos.append((nome, offs[k], fim))
            usados.add(nome)
    return trechos


def _idx_ec(texto):
    itens = [json.loads(l) for l in texto.splitlines() if l.strip().startswith('{')]
    trechos = []
    for nome, (p, nivel) in CAMPOS_EC.items():
        for it in itens:
            if it.get('param') == p and (nivel is None or it.get('levelist') == nivel):
                trechos.append((nome, it['_offset'], it['_offset'] + it['_length'] - 1))
                break
    return trechos


# Tempo até a rodada ficar disponível (usado só nos testes com casos antigos, para simular o tempo real)
ATRASO = {'gfs': 4, 'ecmwf': 7}


def ultima_rodada(modelo, ref, max_horas=30):
    """Rodada mais recente já publicada até a hora 48."""
    import os
    atraso = ATRASO[modelo] if os.environ.get('DETECTOR_AGORA') else 0
    for h in range(atraso, max_horas + 1, 6):
        r = ref - timedelta(hours=h)
        r = r.replace(hour=r.hour - r.hour % 6, minute=0, second=0, microsecond=0)
        if modelo == 'gfs':
            url = f'{GFS}/gfs.{r:%Y%m%d}/{r:%H}/atmos/gfs.t{r:%H}z.pgrb2.0p25.f048.idx'
        else:
            url = f'{ECMWF}/{r:%Y%m%d}/{r:%H}z/ifs/0p25/oper/{r:%Y%m%d%H}0000-48h-oper-fc.index'
        if r <= ref and existe(url):
            return r
    return None


def baixar_modelo(modelo, rodada, horas=HORAS):
    """Devolve {campo: array (tempo, lat, lon)} e as horas válidas."""
    def uma(h):
        if modelo == 'gfs':
            base = f'{GFS}/gfs.{rodada:%Y%m%d}/{rodada:%H}/atmos/gfs.t{rodada:%H}z.pgrb2.0p25.f{h:03d}'
            trechos = _idx_gfs(baixar(base + '.idx', timeout=60).decode(), h)
            return h, _baixar_trechos(base, trechos)
        caminho = f'{rodada:%Y%m%d}/{rodada:%H}z/ifs/0p25/oper/{rodada:%Y%m%d%H}0000-{h}h-oper-fc'
        erro = None
        for espelho in (ECMWF, ECMWF_PORTAL):   # o portal da ECMWF guarda só os últimos dias
            try:
                trechos = _idx_ec(baixar(f'{espelho}/{caminho}.index', timeout=60).decode())
                return h, _baixar_trechos(f'{espelho}/{caminho}.grib2', trechos)
            except Exception as e:
                erro = e
        raise erro
    def segura(h):
        try:
            return uma(h)
        except Exception as e:
            log(f'  {modelo} +{h}h: falhou ({e})')
            return h, {}
    resultados = {}
    with ThreadPoolExecutor(6 if modelo == 'gfs' else 2) as ex:
        for h, campos in ex.map(segura, horas):
            resultados[h] = campos
    falhas = sum(1 for v in resultados.values() if not v)
    if falhas > len(horas) // 3:
        raise RuntimeError(f'{falhas} de {len(horas)} horários não baixaram')
    nomes = CAMPOS_GFS if modelo == 'gfs' else CAMPOS_EC
    forma = (len(LATS), len(LONS))
    saida = {}
    for n in nomes:
        saida[n] = np.stack([resultados[h].get(n, np.full(forma, np.nan, np.float32)) for h in horas])
    # unidades: chuva do ECMWF em metros -> mm; acumulado 0 na hora 0
    if modelo == 'ecmwf':
        saida['chuva_acum'] = saida['chuva_acum'] * 1000.0
    saida['chuva_acum'][0] = np.nan_to_num(saida['chuva_acum'][0])
    return saida


# ---------------------------------------------------------------- ingredientes
def _srh_e_cisalhamento(c):
    """Helicidade relativa à tempestade 0-3 km (supercélula ciclônica do hemisfério sul =
    movimento à esquerda de Bunkers) e cisalhamento 0-6 km, a partir dos ventos em níveis."""
    sp = np.nan_to_num(c['sp'], nan=101300.0)
    if np.nanmax(sp) < 2000:  # em hPa
        sp = sp * 100
    niveis = [('10', None), ('925', 92500), ('850', 85000), ('700', 70000)]
    u = [c['u10']] + [c[f'u{n}'] for n, _ in niveis[1:]]
    v = [c['v10']] + [c[f'v{n}'] for n, _ in niveis[1:]]
    acima = [np.ones_like(sp, bool)] + [(p < sp - 1000) for _, p in niveis[1:]]  # nível acima do chão
    u500, v500 = c['u500'], c['v500']
    shu, shv = u500 - c['u10'], v500 - c['v10']
    shear = np.hypot(shu, shv)
    # vento médio 0-6 km (aprox.) e desvio de 7,5 m/s
    us = [c['u10'], c['u925'], c['u850'], c['u700'], u500]
    vs = [c['v10'], c['v925'], c['v850'], c['v700'], v500]
    pesos = [np.ones_like(sp), acima[1], acima[2], np.ones_like(sp), np.ones_like(sp)]
    sw = sum(pesos)
    um = sum(np.nan_to_num(x) * w for x, w in zip(us, pesos)) / sw
    vm = sum(np.nan_to_num(x) * w for x, w in zip(vs, pesos)) / sw
    norma = np.maximum(shear, 0.1)
    # direita (HN): V + D*(shv, -shu)/|S| ; esquerda: V - D*(shv, -shu)/|S|
    lat = LATS[None, :, None] if shear.ndim == 3 else LATS[:, None]
    sul = lat < 0
    sinal = np.where(sul, -1.0, 1.0)
    cu = um + sinal * 7.5 * shv / norma
    cv = vm - sinal * 7.5 * shu / norma
    srh = np.zeros_like(sp)
    ua, va = u[0], v[0]
    for k in range(1, len(u)):
        ub = np.where(acima[k], u[k], ua)
        vb = np.where(acima[k], v[k], va)
        srh += (ub - cu) * (va - cv) - (ua - cu) * (vb - cv)
        ua, va = ub, vb
    srh = np.where(sul, -srh, srh)  # positivo = favorável nos dois hemisférios
    return np.nan_to_num(srh), np.nan_to_num(shear)


def vizinhanca_max(a, r):
    """Máximo num quadrado de (2r+1)x(2r+1) pontos em cada horário (tolerância de posição)."""
    if r <= 0:
        return a
    return ndimage.maximum_filter(a, size=(1, 2 * r + 1, 2 * r + 1), mode='nearest')


def ingredientes(c, modelo):
    """Calcula índices e devolve {tipo: nível (tempo, lat, lon)} e os índices para os textos."""
    nt = c['u10'].shape[0]
    chuva = np.nan_to_num(c['chuva_acum'])
    chuva = np.maximum.accumulate(chuva, axis=0)
    p3 = np.diff(chuva, axis=0, prepend=chuva[:1])           # mm nas 3 h que terminam em t
    p24 = np.stack([chuva[t] - chuva[max(0, t - 8)] for t in range(nt)])   # janela de 24 h
    p48 = chuva - chuva[0]
    gust = np.nan_to_num(c['gust']) * 3.6                    # km/h
    cape_mu = np.nan_to_num(c['cape_mu'])
    cape_sb = np.nan_to_num(c['cape_sb']) if 'cape_sb' in c else cape_mu * 0.8
    cape_mu = np.maximum(cape_mu, cape_sb)
    cin = np.nan_to_num(c['cin']) if 'cin' in c else np.zeros_like(cape_mu)
    t2, d2 = c['t2'], c['d2']
    lcl = np.nan_to_num(125.0 * np.maximum(t2 - d2, 0), nan=2000.0)
    srh, shear = _srh_e_cisalhamento(c)

    # Sinal de convecção do modelo: chuva convectiva ou refletividade simulada
    if 'refc' in c:
        conv = (np.nan_to_num(c['refc']) >= 40) | ((p3 >= 6) & (cape_mu >= 300))
    else:
        conv = (p3 >= 5) & (cape_mu >= 300)
    conv = vizinhanca_max(conv.astype(np.uint8), 2).astype(bool)   # ±50 km
    # SCP (supercélula) e STP (tornado), versões de camada fixa
    f_sh = np.where(shear < 10, 0, np.clip(shear / 20, 0, 1.5))
    scp = (cape_mu / 1000) * (srh / 50) * f_sh
    f_lcl = np.clip((2000 - lcl) / 1000, 0, 1)
    f_cin = np.clip((200 + cin) / 150, 0, 1)
    f_sh2 = np.where(shear < 12.5, 0, np.clip(shear / 20, 0, 1.5))
    stp = (cape_sb / 1500) * f_lcl * (srh / 200) * f_sh2 * f_cin   # 0-3 km SRH, por isso /200

    n = {}
    # Chuva (INMET: 20-30 mm/h ou até 50 mm/dia | 30-60 mm/h ou 50-100 | >60 mm/h ou >100)
    # O modelo representa a média de uma área de ~27 km: os limiares ficam no meio das faixas do INMET.
    n['chuva'] = np.select([(p24 >= 120) | (p48 >= 180) | (p3 >= 60), (p24 >= 80) | (p3 >= 40), (p24 >= 50) | (p3 >= 25)], [3, 2, 1], 0)
    # Vento (INMET: 40-60 | 60-100 | >100 km/h). Rajadas de 40-60 km/h são comuns e os modelos as exageram
    # em tempestades: o nível moderado começa em 60 km/h.
    n['vento'] = np.select([gust >= 100, gust >= 80, gust >= 60], [3, 2, 1], 0)
    # Tempestade (temporal): ingredientes + convecção prevista
    t3 = conv & (cape_mu >= 2000) & (shear >= 20) & (scp >= 4)
    t2_ = conv & (((cape_mu >= 1500) & (shear >= 15) & (scp >= 1)) | ((cape_mu >= 2500) & (shear >= 12)))
    t1 = conv & (cape_mu >= 800) & (shear >= 10)
    n['tempestade'] = np.select([t3, t2_, t1], [3, 2, 1], 0)
    # Tornado (ambiente favorável), inclui o caso de pouca instabilidade e muito cisalhamento (comum no Sul)
    hslc = conv & (cape_sb >= 250) & (shear >= 25) & (srh >= 150) & (lcl <= 1000)
    n['tornado'] = np.select([conv & (stp >= 3) & (scp >= 6), conv & (stp >= 1) & (scp >= 2),
                              (conv & (stp >= 0.5)) | hslc], [3, 2, 1], 0)
    granizo = conv & (cape_mu >= 1500) & (shear >= 15)
    if 'fzl' in c:
        granizo &= np.nan_to_num(c['fzl'], nan=5000) <= 4300
    indices = {'p3': p3, 'p24': p24, 'p48': p48, 'gust': gust, 'cape_mu': cape_mu, 'cape_sb': cape_sb, 'shear': shear,
               'srh': srh, 'scp': scp, 'stp': stp, 'lcl': lcl, 'granizo': granizo}
    # Vento médio 850-500 hPa (deslocamento das tempestades), usado pelo nowcasting de raios
    indices['passo_u'] = np.nanmean([c['u850'], c['u700'], c['u500']], axis=0)
    indices['passo_v'] = np.nanmean([c['v850'], c['v700'], c['v500']], axis=0)
    return {k: v.astype(np.uint8) for k, v in n.items()}, indices


def consenso(niveis_por_modelo):
    """Junta os níveis dos modelos. Com dois modelos: vale o menor nível, ou o maior menos um
    (o que for mais alto). Assim um evento extremo num modelo e nada no outro vira severo,
    e um moderado que só um modelo vê é descartado."""
    ms = [m for m in niveis_por_modelo if m is not None]
    if len(ms) == 1:
        return ms[0]
    a, b = ms[0].astype(int), ms[1].astype(int)
    return np.maximum(np.minimum(a, b), np.maximum(a, b) - 1).astype(np.uint8)


# ---------------------------------------------------------------- áreas -> alertas
TITULOS = {'chuva': 'Chuvas intensas', 'vento': 'Ventos fortes (vendaval)', 'tempestade': 'Tempestades (temporais)',
           'tornado': 'Condições favoráveis a tornado'}
RISCOS = {
    'chuva': {1: 'Chuva entre 20 e 30 mm/h ou até 50 mm no dia. Baixo risco de alagamentos e pequenos deslizamentos.',
              2: 'Chuva entre 30 e 60 mm/h ou de 50 a 100 mm no dia. Risco de alagamentos, deslizamentos e transbordamento de rios.',
              3: 'Chuva acima de 60 mm/h ou acima de 100 mm no dia. Grande risco de inundações, enxurradas e deslizamentos.'},
    'vento': {1: 'Rajadas de vento de 60 a 80 km/h. Risco de queda de galhos e de cortes de energia.',
              2: 'Rajadas de vento de 80 a 100 km/h. Risco de queda de árvores, destelhamentos e cortes de energia.',
              3: 'Rajadas de vento acima de 100 km/h. Grande risco de danos em casas, queda de árvores e postes.'},
    'tempestade': {1: 'Tempestades com chuva forte, raios, rajadas de 40 a 60 km/h e granizo não descartado.',
                   2: 'Tempestades fortes: chuva de 30 a 60 mm/h, rajadas de 60 a 100 km/h, muitos raios e possível granizo.',
                   3: 'Tempestades muito fortes (supercélulas): chuva acima de 60 mm/h, rajadas acima de 100 km/h e granizo grande.'},
    'tornado': {1: 'A atmosfera terá ingredientes que favorecem tornados (vento mudando de direção e força com a altura, ar instável e úmido). O risco é baixo, mas acima do normal.',
                2: 'Ambiente favorável a supercélulas capazes de gerar tornados. Risco significativo.',
                3: 'Ambiente muito favorável a tornados fortes. Risco alto para a região.'},
}


def _texto_janela(inicio, fim):
    from comum import BRT
    dias = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']
    a, b = inicio.astimezone(BRT), fim.astimezone(BRT)
    fa = f'{dias[a.weekday()]} {a:%d/%m} {a:%H}h'
    fb = f'{b:%H}h' if a.date() == b.date() else f'{dias[b.weekday()]} {b:%d/%m} {b:%H}h'
    return f'{fa} a {fb} (horário de Brasília)'


def areas_para_alertas(niveis, indices, tempos, municipios, agora, modelos_usados, rodadas):
    """niveis = {tipo: (tempo, lat, lon)} -> lista de alertas.

    Para cada tipo e nível, as áreas com nível >= N são separadas em eventos (blocos ligados no
    espaço e no tempo). Cada município entra só no alerta do maior nível que o atinge, mas o
    desenho de um nível inclui as áreas dos níveis acima (como os avisos do INMET).
    """
    alertas = []
    estrutura = np.ones((3, 3, 3), bool)
    futuro = np.array([t + timedelta(hours=1.5) >= agora for t in tempos])
    conf = 'alta (GFS e ECMWF concordam)' if len(modelos_usados) > 1 else f'média (só {modelos_usados[0].upper()})'
    for tipo in TIPOS:
        nv = niveis[tipo].copy()
        nv[~futuro] = 0
        if not nv.any():
            continue
        # tira pontos isolados (ruído) e une áreas muito próximas
        for nivel in (3, 2, 1):
            m3 = nv >= nivel
            m3 = ndimage.binary_closing(m3, structure=np.ones((1, 3, 3)), iterations=1) & (nv >= max(1, nivel - 1)) | m3
            # Períodos de 12 h (9h-21h e 21h-9h de Brasília): um alerta não passa de 12 h, como os do INMET
            periodo = np.array([(t - timedelta(hours=12)).toordinal() * 2 + ((t.hour - 12) % 24) // 12 for t in tempos])
            rotulos = np.zeros(m3.shape, np.int32)
            total = 0
            for p_ in np.unique(periodo):
                sub = m3 & (periodo == p_)[:, None, None]
                r_, n_ = ndimage.label(sub, structure=estrutura)
                rotulos[sub] = r_[sub] + total
                total += n_
            for r in range(1, total + 1):
                bloco = rotulos == r
                proj = bloco.any(axis=0)
                if proj.sum() < (2 if nivel >= 2 else 4):
                    continue
                ts = np.nonzero(bloco.any(axis=(1, 2)))[0]
                inicio = max(agora, tempos[ts[0]] - timedelta(hours=1.5))
                fim = tempos[ts[-1]] + timedelta(hours=1.5)
                # maior nível de cada ponto dentro do bloco: o município fica só no seu nível
                nv_bloco = np.where(bloco, nv, 0).max(axis=0)
                proprio = proj & (nv_bloco == nivel)
                proprio = ndimage.binary_dilation(proprio, iterations=1) & proj
                idx = municipios.na_grade(proprio, LATS[0], LONS[0], PASSO)
                if len(idx) == 0:
                    continue  # só mar ou fora do Brasil
                aneis = contornos(ndimage.binary_dilation(proj, iterations=1) if proj.sum() < 6 else proj, LATS[0], LONS[0], PASSO)
                if not aneis:
                    continue
                riscos = [RISCOS[tipo][nivel]]
                sel = bloco
                if tipo == 'chuva':
                    riscos.append(f"Previsão dos modelos: até {np.max(np.where(sel, indices['p24'], 0)):.0f} mm em 24 h "
                                  f"e até {np.max(np.where(sel, indices['p3'], 0)):.0f} mm em 3 h na área (média de áreas de ~27 km; "
                                  'em pontos isolados pode chover mais).')
                elif tipo == 'vento':
                    riscos.append(f"Rajadas previstas de até {np.max(np.where(sel, indices['gust'], 0)):.0f} km/h.")
                elif tipo in ('tempestade', 'tornado'):
                    cape = np.max(np.where(sel, indices['cape_mu'], 0))
                    sh = np.max(np.where(sel, indices['shear'], 0)) * 3.6
                    riscos.append(f'Instabilidade (CAPE) de até {cape:.0f} J/kg e cisalhamento do vento de até {sh:.0f} km/h entre a superfície e 6 km.')
                    if tipo == 'tempestade' and np.any(sel & indices['granizo']):
                        riscos.append('Ingredientes para granizo.')
                    if tipo == 'tornado':
                        riscos.append(f"Índice de tornado (STP) de até {np.max(np.where(sel, indices['stp'], 0)):.1f} e de supercélula (SCP) de até {np.max(np.where(sel, indices['scp'], 0)):.1f}.")
                riscos.append(f'Período: {_texto_janela(inicio, fim)}.')
                riscos.append(f'Confiança: {conf}.')
                area_txt, _ = municipios.descrever(idx, 3)
                ident = f"prev-{tipo}-{nivel}-{inicio:%Y%m%d%H}-{int(LATS[np.nonzero(proj)[0].mean().astype(int)] * 10)}{int(LONS[np.nonzero(proj)[1].mean().astype(int)] * 10)}"
                alertas.append(alerta(
                    ident=ident, tipo=tipo, metodo='previsao', nivel=nivel,
                    titulo=f'{TITULOS[tipo]} – {area_txt.split(" (")[0]}',
                    evento=TITULOS[tipo], inicio=inicio, fim=fim, riscos=riscos,
                    instrucoes=INSTRUCOES['tornado' if tipo == 'tornado' else tipo], municipios=municipios, idx_mun=list(idx),
                    poligonos=aneis, confianca=conf,
                    detalhes={'modelos': modelos_usados, 'rodadas': rodadas, 'nivelTexto': NOME_NIVEL[nivel]},
                ))
    return alertas

CAMPOS_AMBIENTE = ('cape_mu', 'shear', 'srh', 'stp', 'scp', 'passo_u', 'passo_v')


def avaliar(cache, ref, municipios, forcar=False):
    """Devolve (alertas, ambiente, cache_novo).

    Só baixa os modelos quando sai uma rodada nova de algum deles (4 vezes por dia cada);
    nas outras execuções reaproveita os alertas e o "ambiente" (índices por horário) do cache.
    cache = {'rodadas': {...}, 'alertas': [...], 'ambiente': {'tempos': [...], campo: array}}"""
    cache = dict(cache or {})
    rodadas = {}
    import os
    for modelo in os.environ.get('DETECTOR_MODELOS', 'gfs,ecmwf').split(','):
        try:
            r = ultima_rodada(modelo, ref)
        except Exception as e:
            r = None
            log(f'  {modelo}: erro ao procurar rodada: {e}')
        if r:
            rodadas[modelo] = r
    antigas = cache.get('rodadas') or {}
    novas = {m: iso(r) for m, r in rodadas.items()}
    if not forcar and (not rodadas or novas == antigas or (antigas and set(novas) < set(antigas))):
        log('  modelos: sem rodada nova (' + (', '.join(f'{m} {v[8:10]}/{v[5:7]} {v[11:13]}z' for m, v in antigas.items()) or 'nenhuma') + ')')
        return _filtrar(cache.get('alertas', []), ref), cache.get('ambiente'), cache
    resultados = {}
    import time as _t
    for modelo, rodada in rodadas.items():
        try:
            t0 = _t.time()
            campos = baixar_modelo(modelo, rodada)
            niveis, ind = ingredientes(campos, modelo)
            tempos = [rodada + timedelta(hours=h) for h in HORAS]
            resultados[modelo] = {'rodada': iso(rodada), 'tempos': [iso(t) for t in tempos], 'niveis': niveis, 'indices': ind}
            log(f'  {modelo}: rodada {rodada:%d/%m %Hz} processada em {_t.time() - t0:.0f}s')
        except Exception as e:
            log(f'  {modelo}: ERRO {e}')
    if not resultados:
        return _filtrar(cache.get('alertas', []), ref), cache.get('ambiente'), cache
    alertas, ambiente = combinar(resultados, ref, municipios)
    novo = {'rodadas': {m: r['rodada'] for m, r in resultados.items()}, 'alertas': alertas, 'ambiente': ambiente}
    return alertas, ambiente, novo


def _filtrar(alertas, ref):
    out = []
    for a in alertas:
        fim = datetime.fromisoformat(a['fim'].replace('Z', '+00:00'))
        if fim < ref:
            continue
        ini = datetime.fromisoformat(a['inicio'].replace('Z', '+00:00'))
        if ini < ref:
            a = {**a, 'inicio': iso(ref)}
        out.append(a)
    return out


def combinar(resultados, ref, municipios):
    """Junta os modelos (consenso), gera os alertas e o ambiente para o nowcasting."""
    todos = sorted({t for r in resultados.values() for t in r['tempos']})
    limite = iso(ref - timedelta(hours=3))
    todos = [t for t in todos if t >= limite]
    forma = (len(todos), len(LATS), len(LONS))
    niveis = {}
    for tipo in TIPOS:
        camadas = []
        for r in resultados.values():
            arr = np.full(forma, 255, np.uint8)
            for k, t in enumerate(todos):
                if t in r['tempos']:
                    arr[k] = r['niveis'][tipo][r['tempos'].index(t)]
            camadas.append(arr)
        if len(camadas) == 2:
            a, b = camadas
            a2 = np.where(a == 255, b, a)
            b2 = np.where(b == 255, a, b)
            niveis[tipo] = np.where(a2 == 255, 0, consenso([a2, b2])).astype(np.uint8)
        else:
            niveis[tipo] = np.where(camadas[0] == 255, 0, camadas[0]).astype(np.uint8)
    indices = {}
    for nome in ('p3', 'p24', 'p48', 'gust', 'cape_mu', 'cape_sb', 'shear', 'srh', 'scp', 'stp', 'lcl', 'granizo', 'passo_u', 'passo_v'):
        soma, n = np.zeros(forma, np.float32), np.zeros(forma, np.float32)
        mx = np.zeros(forma, np.float32)
        for r in resultados.values():
            for k, t in enumerate(todos):
                if t in r['tempos']:
                    v = np.nan_to_num(r['indices'][nome][r['tempos'].index(t)].astype(np.float32))
                    soma[k] += v
                    n[k] += 1
                    mx[k] = np.maximum(mx[k], v)
        # vento de deslocamento: média dos modelos; os outros: o maior (para os textos)
        indices[nome] = soma / np.maximum(n, 1) if nome.startswith('passo') else (mx > 0 if nome == 'granizo' else mx)
    tempos = [datetime.fromisoformat(t.replace('Z', '+00:00')) for t in todos]
    rodadas = {m: r['rodada'] for m, r in resultados.items()}
    alertas = areas_para_alertas(niveis, indices, tempos, municipios, ref, list(resultados), rodadas)
    ambiente = {'tempos': todos}
    for k in CAMPOS_AMBIENTE:
        ambiente[k] = indices[k].astype(np.float16)
    return alertas, ambiente


def ambiente_em(ambiente, lat, lon, quando):
    """Índices do modelo perto de um ponto, no horário mais próximo (máximo num raio de ~50 km)."""
    if not ambiente or not len(ambiente.get('tempos', [])):
        return {}
    ts = [abs((datetime.fromisoformat(t.replace('Z', '+00:00')) - quando).total_seconds()) for t in ambiente['tempos']]
    k = int(np.argmin(ts))
    if ts[k] > 6 * 3600:
        return {}
    i = int(np.clip(round((LATS[0] - lat) / PASSO), 0, len(LATS) - 1))
    j = int(np.clip(round((lon - LONS[0]) / PASSO), 0, len(LONS) - 1))
    sl = (k, slice(max(0, i - 2), i + 3), slice(max(0, j - 2), j + 3))
    out = {}
    for c in CAMPOS_AMBIENTE:
        v = np.asarray(ambiente[c][sl], np.float32)
        out[c] = float(np.nanmean(v)) if c.startswith('passo') else float(np.nanmax(v))
    return out
