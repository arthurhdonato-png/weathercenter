"""Repete o nowcasting de raios num período antigo, como se rodasse a cada 5 minutos.

Uso: python3 detector/testes/caso_raios.py 2025-11-07T19:00Z 2025-11-07T22:00Z [lat lon]
Usa os arquivos reais do GLM (GOES-19) daquele dia. Mostra, a cada execução, as tempestades
com alerta e, se for dado um ponto, quando ele passou a estar dentro de um alerta."""
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from comum import UTC, Municipios, ponto_no_anel, hora_local  # noqa: E402
import raios  # noqa: E402
import modelos  # noqa: E402


def data(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).astimezone(UTC)


ini, fim = data(sys.argv[1]), data(sys.argv[2])
alvo = (float(sys.argv[3]), float(sys.argv[4])) if len(sys.argv) > 4 else None
passo = int(os.environ.get('PASSO_MIN', '5'))
mun = Municipios()
ambiente = None
if os.environ.get('COM_MODELOS') == '1':
    os.environ['DETECTOR_AGORA'] = sys.argv[1]
    _, ambiente, _ = modelos.avaliar({}, ini, mun, forcar=True)
estado, anteriores = {}, []
t = ini
primeiro = None
while t <= fim:
    flashes, estado, t_dados = raios.atualizar_raios(estado, t)
    alertas, anteriores = raios.tempestades(flashes, t_dados, ambiente, mun, anteriores)
    linha = []
    so_alvo = os.environ.get('SO_ALVO') == '1'
    for a in sorted(alertas, key=lambda a: -a['nivel'])[:(999 if so_alvo else 6)]:
        d = a['detalhes']
        dentro = alvo and any(ponto_no_anel(alvo[0], alvo[1], r) for r in a['poligonos'])
        if dentro and primeiro is None:
            primeiro = (t, a)
        if so_alvo and not dentro:
            continue
        linha.append(f"   {'>>' if dentro else '  '} {a['severidade']:8s} {a['evento'][:40]:40s} {d['densidadeMax']:5.1f} r/min "
                     f"salto={'S' if d['salto'] else 'n'} {d['velocidadeKmh']:3d} km/h {a['areaTexto'][:70]}")
    cont = {n: sum(1 for a in alertas if a['nivel'] == n) for n in (1, 2, 3)}
    print(f'{hora_local(t)} BRT: {len(anteriores)} tempestades, alertas moderado/severo/extremo = {cont[1]}/{cont[2]}/{cont[3]}')
    print('\n'.join(linha))
    t += timedelta(minutes=passo)
if alvo:
    if primeiro:
        t0, a = primeiro
        print(f'\nALVO dentro de alerta desde {hora_local(t0)} BRT: {a["severidade"]} - {a["titulo"]}')
        for r in a['riscos']:
            print('   ', r)
    else:
        print('\nALVO nunca ficou dentro de um alerta')
