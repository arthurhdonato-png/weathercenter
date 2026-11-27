"""Gera os contornos usados pelos mapas a partir da malha do IBGE em qualidade máxima.

Uso: pip install shapely && python ferramentas/contornos.py [ufs_maxima.json]
Sem argumento, baixa a malha dos estados do IBGE (qualidade máxima).

Saídas em dados/:
  contorno-brasil.json  Brasil inteiro (união dos estados), alargado ~1 km para fora para que nenhuma parte
                        do território (inclusive ilhas oceânicas) fique coberta pela máscara nem pelo recorte.
  contorno-ufs.json     Cada estado, simplificado com folga de ~400 m (linhas de divisa e recorte dos alertas).
  contorno-brasil-largo.json  Versão leve e bem mais larga (~15 km), só para saber onde calcular e pintar as
                        camadas de tempo (a máscara por cima corta tudo na fronteira certa).
  mascara-brasil.json   O que fica coberto nos mapas: o mundo menos o Brasil, menos uma faixa de mar junto
                        à costa e em volta das ilhas oceânicas.
"""
import json
import sys
import urllib.request
from pathlib import Path

from shapely.geometry import shape, mapping, Polygon, Point
from shapely.ops import unary_union

RAIZ = Path(__file__).resolve().parent.parent
URL = ('https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?formato=application/vnd.geo+json'
       '&qualidade=maxima&intrarregiao=UF')
UF_POR_CODIGO = {
    '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO', '21': 'MA', '22': 'PI',
    '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL', '28': 'SE', '29': 'BA', '31': 'MG', '32': 'ES',
    '33': 'RJ', '35': 'SP', '41': 'PR', '42': 'SC', '43': 'RS', '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF',
}
FOLGA_BRASIL = 0.012     # graus (~1,3 km) para fora do contorno oficial
SIMPLIF_BRASIL = 0.004   # menor que a folga: a linha simplificada nunca entra no território
SIMPLIF_UF = 0.004

# Faixa de mar ao longo da costa (lon, lat), parecida com a zona marítima brasileira. O lado de dentro
# passa por terra brasileira.
MAR = [(-51.6, 4.4), (-50.5, 6.5), (-48, 4.5), (-45.5, 1.2), (-42, -0.3), (-38.5, -1.4), (-34.2, -3.0), (-32, -3.0),
       (-31.8, -4.6), (-32.6, -5.6), (-32.6, -8.5), (-33.6, -11), (-36.5, -14), (-36.8, -18), (-37.8, -21.5),
       (-40.5, -25.2), (-45.5, -27), (-47.2, -29.8), (-49.8, -33.2), (-52.2, -35.4), (-53.37, -33.75), (-52.5, -32),
       (-50, -20), (-45, -10), (-50, 0), (-51.6, 4.4)]
# Ilhas oceânicas longe da faixa: Arquipélago de São Pedro e São Paulo, Trindade e Martim Vaz
ILHAS = [(-29.35, 0.92, 0.35), (-29.1, -20.5, 0.55)]
MUNDO = Polygon([(-150, -85), (30, -85), (30, 60), (-150, 60)])


def arred(geo, casas=4):
    def r(c):
        return [r(x) for x in c] if isinstance(c[0], (list, tuple)) else [round(c[0], casas), round(c[1], casas)]
    g = mapping(geo)
    return {'type': g['type'], 'coordinates': r(g['coordinates'])}


def salvar(nome, feats):
    caminho = RAIZ / 'dados' / nome
    caminho.write_text(json.dumps({'type': 'FeatureCollection', 'features': feats}, separators=(',', ':')))
    print(f'{nome}: {caminho.stat().st_size / 1024:.0f} KB')


def main():
    if len(sys.argv) > 1:
        bruto = json.loads(Path(sys.argv[1]).read_text())
    else:
        with urllib.request.urlopen(URL, timeout=120) as r:
            bruto = json.load(r)
    ufs = {}
    for f in bruto['features']:
        cod = str(f['properties'].get('codarea'))[:2]
        ufs[UF_POR_CODIGO[cod]] = shape(f['geometry']).buffer(0)
    oficial = unary_union(list(ufs.values()))

    brasil = oficial.buffer(FOLGA_BRASIL, quad_segs=4).simplify(SIMPLIF_BRASIL)
    sobra = oficial.difference(brasil).area * 111 * 111
    assert sobra < 0.01, f'o contorno simplificado cortaria {sobra:.3f} km² do território'
    salvar('contorno-brasil.json', [{'type': 'Feature', 'properties': {'codarea': 'BR'}, 'geometry': arred(brasil)}])

    largo = oficial.buffer(0.15, quad_segs=2).simplify(0.05)
    salvar('contorno-brasil-largo.json', [{'type': 'Feature', 'properties': {'codarea': 'BR'}, 'geometry': arred(largo, 3)}])

    feats = []
    for uf, g in sorted(ufs.items()):
        s = g.simplify(SIMPLIF_UF, preserve_topology=True)
        if s.geom_type == 'MultiPolygon':  # ilhotas menores que ~0,5 km² não mudam o desenho nem o recorte
            s = unary_union([p for p in s.geoms if p.area > 0.00004] or [max(s.geoms, key=lambda p: p.area)])
        feats.append({'type': 'Feature', 'properties': {'codarea': [k for k, v in UF_POR_CODIGO.items() if v == uf][0], 'uf': uf},
                      'geometry': arred(s, 3)})
    salvar('contorno-ufs.json', feats)

    mar = Polygon(MAR).buffer(0)
    ilhas = unary_union([Point(lon, lat).buffer(r, quad_segs=8) for lon, lat, r in ILHAS])
    mascara = MUNDO.difference(unary_union([brasil, mar, ilhas])).simplify(0.002)
    assert not mascara.intersects(oficial.buffer(-0.0005)), 'a máscara cobre parte do território'
    salvar('mascara-brasil.json', [{'type': 'Feature', 'properties': {}, 'geometry': arred(mascara)}])


if __name__ == '__main__':
    main()
