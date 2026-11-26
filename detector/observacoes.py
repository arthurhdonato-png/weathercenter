"""Observações reais das últimas horas nas estações dos aeroportos (METAR/SPECI).

São ~150 estações no Brasil, com boletim a cada hora e boletins extras (SPECI) quando o tempo
muda de repente. Aproveitamos o que confirma tempo severo acontecendo: rajadas fortes,
granizo (GR), linha de instabilidade (SQ), nuvem funil/tornado (FC) e trovoada forte (+TS).
Fonte: aviationweather.gov (NOAA), sem chave.
"""
import json
import re
from datetime import datetime, timedelta

from comum import UTC, INSTRUCOES, alerta, baixar, hora_local, log

URL = 'https://aviationweather.gov/api/data/metar?bbox=-34.5,-74.5,5.5,-32&hours=3&format=json'
RAIO_KM = 30
VALIDADE = 90  # min depois da observação


def _rajada_kmh(o):
    g = o.get('wgst')
    if g in (None, '', 'VRB'):
        m = re.search(r'\b\d{3}\d{2,3}G(\d{2,3})(KT|MPS)\b', o.get('rawOb', ''))
        if not m:
            return None
        g = int(m.group(1)) * (1.94384 if m.group(2) == 'MPS' else 1)
    try:
        return float(g) * 1.852
    except (TypeError, ValueError):
        return None


def _quando(o):
    t = o.get('obsTime')
    if isinstance(t, (int, float)):
        return datetime.fromtimestamp(t, UTC)
    for k in ('reportTime', 'receiptTime'):
        if o.get(k):
            try:
                return datetime.fromisoformat(str(o[k]).replace('Z', '+00:00').replace(' ', 'T')).astimezone(UTC)
            except ValueError:
                pass
    return None


def avaliar(ref, municipios):
    dados = json.loads(baixar(URL, timeout=40, cabecalhos={'Accept': 'application/json'}))
    if isinstance(dados, dict):
        dados = dados.get('data') or dados.get('features') or []
    log(f'  METAR: {len(dados)} boletins nas últimas 3 h')
    por_estacao = {}
    for o in dados:
        q = _quando(o)
        if not q or q < ref - timedelta(hours=2) or q > ref + timedelta(minutes=10):
            continue
        wx = (o.get('wxString') or '') + ' ' + ' '.join(re.findall(r'\s([+-]?(?:VC)?(?:TS|SH|FZ)?(?:RA|GR|GS|FC|SQ|DZ)+)\b', o.get('rawOb', '')))
        rj = _rajada_kmh(o)
        nivel, tipo, motivo = 0, None, None
        if 'FC' in wx:
            nivel, tipo, motivo = 3, 'tornado', 'nuvem funil ou tornado observado (FC)'
        elif re.search(r'(?<![A-Z])\+?(TS)?GR', wx) or 'GR' in wx:
            nivel, tipo, motivo = 2, 'granizo', 'granizo observado (GR)'
        if rj and rj >= 60:
            n = 3 if rj >= 100 else 2 if rj >= 80 else 1
            if n > nivel:
                nivel, tipo, motivo = n, 'vento', f'rajada de {rj:.0f} km/h'
        if 'SQ' in wx and nivel < 2:
            nivel, tipo, motivo = 2, 'vento', 'linha de instabilidade (SQ) com vento forte repentino'
        if '+TS' in wx and nivel < 1:
            nivel, tipo, motivo = 1, 'tempestade', 'trovoada forte com chuva intensa (+TS)'
        if not nivel:
            continue
        est = o.get('icaoId') or o.get('stationId') or '?'
        atual = por_estacao.get(est)
        if not atual or nivel > atual['nivel'] or (nivel == atual['nivel'] and q > atual['quando']):
            por_estacao[est] = {'nivel': nivel, 'tipo': tipo, 'motivo': motivo, 'quando': q, 'obs': o}
    alertas = []
    for est, e in por_estacao.items():
        o = e['obs']
        try:
            lat, lon = float(o['lat']), float(o['lon'])
        except (KeyError, TypeError, ValueError):
            continue
        idx = list(municipios.perto(lat, lon, RAIO_KM))
        if not idx:
            continue
        fim = e['quando'] + timedelta(minutes=VALIDADE)
        if fim < ref:
            continue
        perto = min(idx, key=lambda k: (municipios.lat[k] - lat) ** 2 + (municipios.lon[k] - lon) ** 2)
        local = f'{municipios.nome[perto]}/{municipios.uf[perto]}'
        evento = {'tornado': 'Tornado ou nuvem funil observado', 'granizo': 'Granizo observado',
                  'vento': 'Vento forte observado', 'tempestade': 'Tempestade forte observada'}[e['tipo']]
        from comum import circulo, casco_convexo
        alertas.append(alerta(
            ident=f'obs-{est}-{e["quando"]:%d%H%M}', tipo=e['tipo'], metodo='observacao', nivel=e['nivel'],
            titulo=f'{evento} – {local}', evento=evento, inicio=e['quando'], fim=fim,
            riscos=[f"Observado na estação do aeroporto {o.get('name') or est} ({est}) às {hora_local(e['quando'])}: {e['motivo']}.",
                    'O mesmo pode estar acontecendo em cidades vizinhas. Fique atento ao céu e aos avisos oficiais.',
                    f"Boletim: {o.get('rawOb', '')[:160]}"],
            instrucoes=INSTRUCOES['tornado' if e['tipo'] == 'tornado' else 'vento' if e['tipo'] == 'vento' else 'tempestade'],
            municipios=municipios, idx_mun=idx, poligonos=[casco_convexo(circulo(lat, lon, RAIO_KM))], atualizado=e['quando'],
            confianca='alta (observado)', detalhes={'estacao': est, 'centro': [lat, lon]},
        ))
    return alertas
