#!/usr/bin/env python3
"""Detector WeatherCenter: sistema próprio de detecção e previsão de eventos adversos.

Dois modos:

  python3 detector/detectar.py modelos SAIDA [ANTERIOR]
      Previsão 0-48 h (GFS + ECMWF). Só baixa os modelos quando sai rodada nova.
      Grava SAIDA/modelo.json (alertas de previsão) e SAIDA/ambiente.npz (índices por horário,
      usados pelo nowcasting). Roda no workflow "Prever eventos" a cada 30 min.

  python3 detector/detectar.py agora SAIDA [ANTERIOR]
      Nowcasting (raios do satélite, radar e aeroportos) + alertas de previsão já calculados.
      Junta tudo em SAIDA/weathercenter.json e acrescenta os alertas em SAIDA/alertas.json
      (o arquivo do coletor), com a fonte "WeatherCenter". Roda junto com o coletor a cada 5 min.

ANTERIOR é a pasta com os arquivos da execução passada (estado e cache).
"""
import gzip
import json
import os
import sys
import time
import traceback

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from comum import AVISO_NAO_OFICIAL, Municipios, agora, iso, log  # noqa: E402


def ler_json(caminho, padrao=None):
    try:
        if caminho.endswith('.gz'):
            with gzip.open(caminho, 'rt', encoding='utf-8') as f:
                return json.load(f)
        with open(caminho, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return padrao


def gravar_json(caminho, dados, comprimir=False):
    if comprimir:
        with gzip.open(caminho, 'wt', encoding='utf-8') as f:
            json.dump(dados, f, ensure_ascii=False, separators=(',', ':'))
    else:
        with open(caminho, 'w', encoding='utf-8') as f:
            json.dump(dados, f, ensure_ascii=False, separators=(',', ':'))


def ler_ambiente(caminho):
    try:
        with np.load(caminho, allow_pickle=False) as z:
            amb = {k: z[k] for k in z.files if k != 'tempos'}
            amb['tempos'] = [str(t) for t in z['tempos']]
            return amb
    except Exception:
        return None


def gravar_ambiente(caminho, amb):
    if not amb:
        return
    arrays = {k: np.asarray(v) for k, v in amb.items() if k != 'tempos'}
    np.savez_compressed(caminho, tempos=np.array(amb['tempos']), **arrays)


# ---------------------------------------------------------------- modo "modelos"
def rodar_modelos(saida, anterior):
    import modelos
    ref = agora()
    mun = Municipios()
    cache = ler_json(os.path.join(anterior, 'modelo.json'), {}) or {}
    cache['ambiente'] = ler_ambiente(os.path.join(anterior, 'ambiente.npz'))
    if cache.get('ambiente') is None:
        cache = {}   # sem o ambiente salvo, recalcula tudo
    t0 = time.time()
    alertas, ambiente, novo = modelos.avaliar(cache, ref, mun, forcar=os.environ.get('DETECTOR_FORCAR') == '1')
    gravar_json(os.path.join(saida, 'modelo.json'), {
        'versao': 1, 'gerado_em': iso(ref), 'rodadas': novo.get('rodadas', {}), 'alertas': alertas})
    gravar_ambiente(os.path.join(saida, 'ambiente.npz'), ambiente)
    cont = {n: sum(1 for a in alertas if a['nivel'] == n) for n in (1, 2, 3)}
    log(f'Previsão: {len(alertas)} alertas (moderado {cont[1]}, severo {cont[2]}, extremo {cont[3]}) em {time.time() - t0:.0f}s')


# ---------------------------------------------------------------- modo "agora"
def rodar_agora(saida, anterior):
    import modelos
    import raios
    ref = agora()
    mun = Municipios()
    estado = ler_json(os.path.join(anterior, 'estado-detector.json.gz'), {}) or {}
    fontes = {}
    alertas = []
    tempestades = []

    # Previsão (calculada pelo workflow "Prever eventos")
    mod = ler_json(os.path.join(anterior, 'modelo.json'), {}) or {}
    ambiente = ler_ambiente(os.path.join(anterior, 'ambiente.npz'))
    prev = modelos._filtrar(mod.get('alertas', []), ref)
    alertas += prev
    fontes['previsao'] = {'nome': 'Previsão por modelos (GFS + ECMWF)', 'ok': bool(mod), 'quantidade': len(prev),
                          'rodadas': mod.get('rodadas', {})}

    # Radar
    rad = None
    t0 = time.time()
    try:
        import radar
        est_rad = dict(estado.get('radar', {}))
        try:
            with np.load(os.path.join(anterior, 'radar-persistencia.npz')) as z:
                est_rad['persistencia'] = z['p']
        except Exception:
            est_rad = {}
        rad, novo_rad = radar.carregar(est_rad)
        np.savez_compressed(os.path.join(saida, 'radar-persistencia.npz'), p=novo_rad.pop('persistencia'))
        estado['radar'] = novo_rad
        fontes['radar'] = {'nome': 'Radar (RainViewer)', 'ok': True, 'imagem': iso(rad.t)}
    except Exception as e:
        log(f'  Radar: ERRO {e}')
        fontes['radar'] = {'nome': 'Radar (RainViewer)', 'ok': False, 'erro': str(e)[:200]}
    fontes['radar']['segundos'] = round(time.time() - t0, 1)

    # Raios (GOES-19/GLM)
    t0 = time.time()
    try:
        flashes, est_raios, t_dados = raios.atualizar_raios(estado.get('raios', {}), ref)
        estado['raios'] = est_raios
        al, tempestades = raios.tempestades(flashes, t_dados, ambiente, mun, estado.get('tempestades', []), rad)
        alertas += al
        estado['tempestades'] = [{k: v for k, v in t.items() if k not in ('serie',)} for t in tempestades]
        fontes['raios'] = {'nome': 'Raios por satélite (GOES-19 GLM)', 'ok': True, 'quantidade': len(al),
                           'dados': iso(t_dados), 'raios10min': int(np.sum(flashes[:, 0] > t_dados.timestamp() - 600)) if len(flashes) else 0}
    except Exception as e:
        traceback.print_exc()
        fontes['raios'] = {'nome': 'Raios por satélite (GOES-19 GLM)', 'ok': False, 'erro': str(e)[:200]}
    fontes['raios']['segundos'] = round(time.time() - t0, 1)

    if rad is not None:
        try:
            import radar
            al, celulas = radar.alertas_radar(rad, tempestades, ambiente, mun, estado.get('celulasRadar', []))
            estado['celulasRadar'] = celulas
            alertas += al
            fontes['radar']['quantidade'] = len(al)
        except Exception as e:
            traceback.print_exc()
            fontes['radar']['erro'] = str(e)[:200]

    # Aeroportos (METAR)
    t0 = time.time()
    try:
        import observacoes
        al = observacoes.avaliar(ref, mun)
        alertas += al
        fontes['observacoes'] = {'nome': 'Estações dos aeroportos (METAR)', 'ok': True, 'quantidade': len(al)}
    except Exception as e:
        log(f'  METAR: ERRO {e}')
        fontes['observacoes'] = {'nome': 'Estações dos aeroportos (METAR)', 'ok': False, 'erro': str(e)[:200]}
    fontes['observacoes']['segundos'] = round(time.time() - t0, 1)

    alertas.sort(key=lambda a: (-a['nivel'], a['metodo'] != 'raios', a['inicio'] or ''))
    for a in alertas:
        a['aviso'] = AVISO_NAO_OFICIAL
    cont = {n: sum(1 for a in alertas if a['nivel'] == n) for n in (1, 2, 3)}
    log(f'WeatherCenter: {len(alertas)} alertas (moderado {cont[1]}, severo {cont[2]}, extremo {cont[3]})')

    publico = {
        'versao': 1, 'gerado_em': iso(ref), 'aviso': AVISO_NAO_OFICIAL, 'fontes': fontes, 'alertas': alertas,
        # Tempestades acompanhadas agora (para desenhar a trajetória no mapa)
        'tempestades': [{k: t[k] for k in ('id', 'lat', 'lon', 've', 'vn', 'nivel', 'taxa', 'densMax', 'salto', 'dbz') if k in t}
                        for t in tempestades if t.get('nivel', 0) >= 1],
    }
    gravar_json(os.path.join(saida, 'weathercenter.json'), publico)
    gravar_json(os.path.join(saida, 'estado-detector.json.gz'), estado, comprimir=True)
    # Junta no alertas.json do coletor (mesmo formato das outras fontes)
    caminho = os.path.join(saida, 'alertas.json')
    col = ler_json(caminho)
    if col is not None:
        col['alertas'] = [a for a in col.get('alertas', []) if a.get('fonteId') != 'weathercenter'] + alertas
        col['alertas'].sort(key=lambda a: -a.get('nivel', 0))
        col.setdefault('fontes', {})['weathercenter'] = {
            'nome': 'WeatherCenter (detecção automática)', 'ok': any(f.get('ok') for f in fontes.values()),
            'quantidade': len(alertas)}
        gravar_json(caminho, col)
        log(f'alertas.json: {len(col["alertas"])} alertas no total, {os.path.getsize(caminho) // 1024} KB')


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ('modelos', 'agora'):
        sys.exit(__doc__)
    modo, saida = sys.argv[1], sys.argv[2]
    anterior = sys.argv[3] if len(sys.argv) > 3 else 'anterior'
    os.makedirs(saida, exist_ok=True)
    os.makedirs(anterior, exist_ok=True)
    (rodar_modelos if modo == 'modelos' else rodar_agora)(saida, anterior)


if __name__ == '__main__':
    main()
