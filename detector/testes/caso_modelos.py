"""Testa a parte de previsão com um caso antigo, como se fosse aquela hora.

Uso: python3 detector/testes/caso_modelos.py 2025-11-07T15:00Z [lat lon]
Mostra os alertas que teriam sido emitidos e se o ponto (lat, lon) estava dentro."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ['DETECTOR_AGORA'] = sys.argv[1]

from comum import Municipios, agora, ponto_no_anel  # noqa: E402
import modelos  # noqa: E402

ref = agora()
mun = Municipios()
alertas, amb, _ = modelos.avaliar({}, ref, mun, forcar=True)
alvo = (float(sys.argv[2]), float(sys.argv[3])) if len(sys.argv) > 3 else None
print(f'\n{len(alertas)} alertas de previsão em {ref:%d/%m/%Y %H:%M} UTC')
for a in sorted(alertas, key=lambda a: (a['tipo'], -a['nivel'])):
    dentro = ''
    if alvo:
        dentro = ' <== ALVO' if any(ponto_no_anel(alvo[0], alvo[1], r) for r in a['poligonos']) else ''
    print(f"- {a['tipo']:10s} {a['severidade']:8s} {a['inicio'][5:16]}→{a['fim'][5:16]} {len(a['geocodes']):4d} mun. {a['titulo'][:90]}{dentro}")
if alvo and amb:
    print('ambiente no alvo:', {k: round(v, 1) for k, v in modelos.ambiente_em(amb, alvo[0], alvo[1], ref).items()})
