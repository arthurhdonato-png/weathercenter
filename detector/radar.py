"""Radar meteorológico (mosaico da RainViewer, que junta radares do Brasil e de outros países).

Usamos o radar de duas formas:
1. para reforçar as tempestades achadas pelos raios (refletividade máxima: 50 dBZ = chuva muito
   forte, 60 dBZ = granizo provável);
2. para achar núcleos de chuva forte sem raios (comum no litoral e em chuvas de inverno no Sul).

Limitações: a cobertura de radar no Brasil tem buracos (Norte e parte do Nordeste e do
Centro-Oeste); a RainViewer só publica a imagem (cores) e não o valor medido, então a
refletividade é estimada pela cor com precisão de ~2 dBZ; o zoom máximo gratuito é 7.
"""
import io
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

import numpy as np
from scipy import ndimage

from comum import (UTC, INSTRUCOES, alerta, baixar, contornos, dbg, hora_local, log, rumo_texto)
import raios
from raios import G, LATS, LONS

API = 'https://api.rainviewer.com/public/weather-maps.json'
Z = 6                       # zoom 6: ~2,4 km por pixel no Equador
TX = range(18, 26)          # tiles que cobrem o Brasil
TY = range(31, 39)


def _paleta():
    """Cor (RGBA) -> dBZ da paleta "Universal Blue" (a única servida hoje pela API gratuita).
    Ordem das cores conferida nas imagens; valores de dBZ estimados (±2 dBZ)."""
    p = {}
    # tons bege translúcidos: garoa e chuva fraca (abaixo de ~20 dBZ)
    alfas = [20, 25, 30, 36, 41, 46, 52, 57, 62, 68, 73, 78, 84, 89, 94, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190]
    for k, a in enumerate(alfas):
        p[('bege', a)] = -3 + k
    azuis = [(136, 221, 238), (108, 209, 235), (81, 197, 232), (54, 186, 229), (27, 174, 226), (0, 163, 224), (0, 154, 213),
             (0, 145, 202), (0, 136, 191), (0, 127, 180), (0, 119, 170), (0, 112, 163), (0, 105, 156), (0, 98, 149),
             (0, 91, 142), (0, 85, 136), (0, 81, 128), (0, 78, 120), (0, 74, 112), (0, 71, 104)]
    for k, c in enumerate(azuis):
        p[c] = 21 + k                       # 21..40 dBZ: chuva fraca a moderada/forte
    amarelos = [(255, 238, 0), (255, 224, 0), (255, 210, 0), (255, 197, 0), (255, 183, 0), (255, 170, 0), (255, 159, 0),
                (255, 149, 0), (255, 139, 0), (255, 129, 0)]
    for k, c in enumerate(amarelos):
        p[c] = 41 + k                       # 41..50: chuva forte
    vermelhos = [(255, 68, 0), (242, 54, 0), (230, 40, 0), (217, 27, 0), (205, 13, 0), (193, 0, 0), (168, 0, 0), (143, 0, 0),
                 (118, 0, 0), (93, 0, 0)]
    for k, c in enumerate(vermelhos):
        p[c] = 51 + k                       # 51..60: chuva muito forte, granizo possível
    rosas = [(255, 170, 255), (255, 159, 255), (255, 149, 255), (255, 139, 255), (255, 129, 255), (255, 119, 255),
             (255, 108, 255), (255, 98, 255), (255, 88, 255), (255, 78, 255)]
    for k, c in enumerate(rosas):
        p[c] = 61 + k                       # 61..70: granizo
    p[(255, 255, 255)] = 72
    return p


PALETA = _paleta()
_CORES = np.array([k for k in PALETA if k[0] != 'bege'], float)
_DBZ = np.array([PALETA[tuple(int(x) for x in k)] for k in _CORES], float)


def _tile_para_dbz(png):
    from PIL import Image
    im = np.asarray(Image.open(io.BytesIO(png)).convert('RGBA'))
    rgb, a = im[..., :3].astype(float), im[..., 3]
    out = np.full(a.shape, np.nan, np.float32)
    opaco = a == 255
    if opaco.any():
        cores = rgb[opaco]
        # cor mais próxima da paleta (tolerante a pequenas diferenças de compressão)
        d = ((cores[:, None, :] - _CORES[None, :, :]) ** 2).sum(-1)
        k = d.argmin(1)
        v = _DBZ[k]
        v[d[np.arange(len(k)), k] > 900] = np.nan
        out[opaco] = v
    bege = (a > 0) & (a < 255)
    out[bege] = 10.0
    return out


def _quadro(host, caminho):
    """Mosaico de um horário -> grade de dBZ (máximo em cada célula de 0,05°)."""
    def um(xy):
        x, y = xy
        try:
            png = baixar(f'{host}{caminho}/256/{Z}/{x}/{y}/2/0_0.png', timeout=20, tentativas=3)
            return x, y, _tile_para_dbz(png)
        except Exception as e:
            dbg(f'radar tile {x},{y}: {e}')
            return x, y, None
    tiles = [(x, y) for x in TX for y in TY]
    mosaico = np.full((len(TY) * 256, len(TX) * 256), np.nan, np.float32)
    falhas = 0
    with ThreadPoolExecutor(8) as ex:
        for x, y, t in ex.map(um, tiles):
            if t is None:
                falhas += 1
                continue
            mosaico[(y - TY[0]) * 256:(y - TY[0] + 1) * 256, (x - TX[0]) * 256:(x - TX[0] + 1) * 256] = t
    if falhas > len(tiles) // 2:
        raise RuntimeError(f'{falhas} de {len(tiles)} imagens do radar falharam')
    # pixel (Web Mercator) -> lat/lon -> célula da grade
    n = 2 ** Z * 256
    px = (np.arange(mosaico.shape[1]) + TX[0] * 256 + 0.5)
    py = (np.arange(mosaico.shape[0]) + TY[0] * 256 + 0.5)
    lon = px / n * 360 - 180
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * py / n))))
    j = ((lon - raios.O) / G).astype(int)
    i = ((raios.N - lat) / G).astype(int)
    okj = (j >= 0) & (j < len(LONS))
    oki = (i >= 0) & (i < len(LATS))
    sub = mosaico[np.ix_(oki, okj)]
    I = np.repeat(i[oki][:, None], okj.sum(), 1)
    J = np.repeat(j[okj][None, :], oki.sum(), 0)
    grade = np.full((len(LATS), len(LONS)), -99, np.float32)
    v = np.nan_to_num(sub, nan=-99)
    np.maximum.at(grade, (I.ravel(), J.ravel()), v.ravel())
    grade[grade == -99] = np.nan
    return grade


class Radar:
    def __init__(self, atual, anterior, t, t_ant, fixo=None, pronto=True):
        self.dbz, self.ant, self.t, self.t_ant = atual, anterior, t, t_ant
        # Ecos fixos (interferência de morros, prédios e do próprio radar): ignorados
        self.fixo = fixo if fixo is not None else np.zeros(atual.shape, bool)
        self.pronto = pronto      # já há histórico suficiente para separar os ecos fixos

    def max_dbz(self, area):
        v = self.dbz[area & ~self.fixo]
        v = v[np.isfinite(v)]
        return float(v.max()) if len(v) else None


def carregar(estado=None):
    """Baixa os dois últimos horários do radar. Devolve (Radar, estado novo).

    estado guarda, para cada célula, a fração recente de imagens com eco forte (média móvel).
    Eco forte em quase todas as imagens da última hora, sempre no mesmo lugar, é interferência."""
    estado = estado or {}
    d = json.loads(baixar(API, timeout=20))
    quadros = d.get('radar', {}).get('past', [])
    if len(quadros) < 2:
        raise RuntimeError('RainViewer sem quadros de radar')
    host = d.get('host', 'https://tilecache.rainviewer.com')
    q1, q0 = quadros[-1], quadros[-2]
    g1 = _quadro(host, q1['path'])
    g0 = _quadro(host, q0['path'])
    t1 = datetime.fromtimestamp(q1['time'], UTC)
    t0 = datetime.fromtimestamp(q0['time'], UTC)
    persist = estado.get('persistencia')
    n = int(estado.get('quadros', 0))
    if persist is None or np.shape(persist) != g1.shape:
        persist, n = np.zeros(g1.shape, np.float32), 0
    persist = np.asarray(persist, np.float32)
    if estado.get('ultimo') != q1['time']:
        persist = 0.85 * persist + 0.15 * (np.nan_to_num(g1, nan=0) >= 45)
        n += 1
    fixo = ndimage.binary_dilation(persist >= 0.6, iterations=1)
    eco = int(np.sum((g1 >= 40) & ~fixo))
    log(f'  Radar: imagem das {hora_local(t1)}, {eco} células com 40 dBZ ou mais, {int(fixo.sum())} com eco fixo ignorado')
    novo = {'persistencia': persist.astype(np.float16), 'quadros': n, 'ultimo': q1['time']}
    return Radar(g1, g0, t1, t0, fixo, pronto=n >= 6), novo


def alertas_radar(radar, tempestades_raios, ambiente, municipios):
    """Núcleos de chuva muito forte (50 dBZ ou mais) que não estão junto de tempestades com raios."""
    if radar is None or not radar.pronto:
        return []
    forte = (np.nan_to_num(radar.dbz, nan=0) >= 50) & ~radar.fixo
    forte_ant = np.nan_to_num(radar.ant, nan=0) >= 50
    rot, n = ndimage.label(ndimage.binary_dilation(forte, iterations=1), structure=np.ones((3, 3)))
    saida = []
    objs = ndimage.find_objects(rot)
    perto_raios = [(t['lat'], t['lon']) for t in tempestades_raios if t.get('nivel', 0) >= 1]
    for r in range(1, n + 1):
        sl = objs[r - 1]
        area = (rot == r) & forte
        cel = int(area.sum())
        if cel < 4:                       # menos de ~120 km²: ignora
            continue
        ys, xs = np.nonzero(area)
        lat_c, lon_c = float(LATS[ys].mean()), float(LONS[xs].mean())
        if any(abs(lat_c - a) < 0.3 and abs(lon_c - b) < 0.3 for a, b in perto_raios):
            continue                      # já coberto pelo alerta de raios
        # Eco parado e idêntico nos dois horários costuma ser interferência (montanha, prédio, antena)
        sobre = (area & forte_ant).sum() / max(1, area.sum())
        if sobre > 0.95 and np.allclose(np.nan_to_num(radar.dbz[sl]), np.nan_to_num(radar.ant[sl]), atol=0.5):
            continue
        # deslocamento: correlação entre os dois horários ou vento dos modelos
        m = 8
        caixa = (max(0, sl[0].start - m), min(len(LATS), sl[0].stop + m), max(0, sl[1].start - m), min(len(LONS), sl[1].stop + m))
        a0 = np.nan_to_num(radar.ant, nan=0).clip(30, 70) - 30
        a1 = np.nan_to_num(radar.dbz, nan=0).clip(30, 70) - 30
        desloc, pico = raios._deslocamento(a0, a1, caixa)
        minutos = max(5.0, (radar.t - radar.t_ant).total_seconds() / 60)
        amb = raios.modelos.ambiente_em(ambiente, lat_c, lon_c, radar.t) if ambiente else {}
        if not desloc or desloc == (0, 0):
            continue   # núcleo forte parado, sem raios: geralmente não é chuva de verdade
        if desloc and pico >= 0.5:
            vn = -desloc[0] * G * 111.2 * 60 / minutos
            ve = desloc[1] * G * 111.2 * np.cos(np.radians(lat_c)) * 60 / minutos
        elif amb.get('passo_u') is not None:
            ve, vn = 0.8 * amb['passo_u'] * 3.6, 0.8 * amb['passo_v'] * 3.6
        else:
            ve = vn = 0.0
        vel = float(np.hypot(ve, vn))
        if vel > 110:
            ve, vn, vel = ve * 110 / vel, vn * 110 / vel, 110.0
        dbz = float(np.nanmax(radar.dbz[area]))
        nivel = 2 if (dbz >= 58 and cel >= 8) else 1
        mg = raios.margem(ve, vn, lat_c)
        y0, y1 = max(0, sl[0].start - mg), min(len(LATS), sl[0].stop + mg)
        x0, x1 = max(0, sl[1].start - mg), min(len(LONS), sl[1].stop + mg)
        caminho, chegada = raios.projetar(area[y0:y1, x0:x1], y0, x0, ve, vn, lat_c, municipios)
        if not chegada:
            continue
        idx = list(chegada)
        aneis = contornos(caminho, LATS[y0], LONS[x0], G, suavizar=3)
        principais = sorted(idx, key=lambda k: -municipios.pop[k])[:6]
        horarios = [f"{municipios.nome[k]}/{municipios.uf[k]}: {'agora' if chegada[k] == 0 else f'~{chegada[k]} min'}"
                    for k in sorted(principais, key=lambda k: chegada[k])]
        rumo = (np.degrees(np.arctan2(ve, vn)) + 360) % 360
        riscos = ['Chuva muito forte nos próximos minutos (núcleo intenso no radar). Risco de alagamentos rápidos.'
                  + (' Granizo possível.' if dbz >= 58 else '')]
        if vel >= 8:
            riscos.append(f'Deslocamento para {rumo_texto(rumo)} a ~{vel:.0f} km/h.')
        riscos.append('Chegada estimada: ' + '; '.join(horarios) + '.')
        riscos.append(f'Detectado por radar: {dbz:.0f} dBZ às {hora_local(radar.t)}, sem raios associados.')
        alvo = ', '.join(municipios.nome[k] for k in sorted(idx, key=lambda k: (chegada[k] > 0, -municipios.pop[k]))[:2])
        saida.append(alerta(
            ident=f'radar-{int(lat_c * -100)}{int(lon_c * -100)}-{radar.t:%H%M}', tipo='chuva', metodo='radar', nivel=nivel,
            titulo=f'Chuva muito forte se aproximando – {alvo}', evento='Chuva muito forte (radar)',
            inicio=radar.t, fim=radar.t + timedelta(minutes=raios.HORIZONTE), riscos=riscos, instrucoes=INSTRUCOES['chuva'],
            municipios=municipios, idx_mun=idx, poligonos=aneis, atualizado=radar.t,
            confianca='média (radar, refletividade estimada pela cor)',
            detalhes={'centro': [round(lat_c, 3), round(lon_c, 3)], 'velocidadeKmh': round(vel), 'rumoGraus': round(float(rumo)),
                      'dbz': round(dbz), 'chegadaMin': {municipios.ibge[k]: chegada[k] for k in idx}},
        ))
    return saida
