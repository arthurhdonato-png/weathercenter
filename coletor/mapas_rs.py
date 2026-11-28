"""Leitura dos mapas de risco da Defesa Civil do Rio Grande do Sul.

A Defesa Civil RS publica no site oficial (defesacivil.rs.gov.br, robots.txt libera tudo) dois mapas
por aviso: "Áreas com risco meteorológico" e "Áreas com risco hidrológico". As áreas existem só na
imagem (não há arquivo de dados). Este módulo:

1. separa as cores da legenda (verde = normal, amarelo = atenção, laranja = alerta,
   vermelho = severo/inundação, roxo = extremo/inundação extrema);
2. encaixa o desenho do estado na malha oficial de municípios do IBGE (procura a escala e a
   posição que fazem o contorno da imagem coincidir com o contorno do RS);
3. mede, em cada município, quanto da área está em cada cor.

O município entra no nível mais alto que cobre pelo menos COBERTURA_MIN da sua área. Se o
encaixe não ficar bom (sobreposição < ENCAIXE_MIN), o mapa é descartado para não mostrar
áreas erradas.

Precisa de numpy, scipy e pillow (já instalados para o detector no GitHub Actions).
"""
import io
import math

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

COBERTURA_MIN = 0.25   # fração do município na cor para ele entrar naquele nível
ENCAIXE_MIN = 0.90     # sobreposição mínima (IoU) entre o desenho e a malha do IBGE
VERDE, AMARELO, LARANJA, VERMELHO, ROXO = 0, 1, 2, 3, 4


def classificar_cores(rgb):
    """Matriz com a classe de cada pixel: 0 verde, 1 amarelo, 2 laranja, 3 vermelho, 4 roxo, -1 outro."""
    r, g, b = (rgb[..., i].astype(int) for i in range(3))
    c = np.full(r.shape, -1, dtype=np.int8)
    c[(r < 70) & (g > 85) & (g < 180) & (b < 70) & (g > r + 50)] = VERDE
    c[(r > 215) & (g > 215) & (b < 90)] = AMARELO
    c[(r > 215) & (g > 110) & (g < 205) & (b < 70)] = LARANJA
    c[(r > 190) & (g < 70) & (b < 70)] = VERMELHO
    c[(r > 85) & (r < 190) & (g < 60) & (b > 85) & (b < 220) & (np.abs(r - b) < 90)] = ROXO
    return c


def mascara_estado(classes):
    """Maior mancha colorida da imagem (o estado), sem a legenda e os textos."""
    colorido = classes >= 0
    fechado = ndimage.binary_closing(colorido, structure=np.ones((5, 5)), iterations=2)
    rotulos, n = ndimage.label(fechado)
    if n == 0:
        return None
    tamanhos = ndimage.sum(fechado, rotulos, range(1, n + 1))
    maior = int(np.argmax(tamanhos)) + 1
    return ndimage.binary_fill_holes(rotulos == maior)


def _merc(lat):
    return math.degrees(math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


def _aneis(geom):
    if geom['type'] == 'Polygon':
        return [geom['coordinates'][0]]
    return [p[0] for p in geom['coordinates']]


def _rasterizar(municipios, proj, sx, ox, sy, oy, forma, fator=1):
    """Desenha os municípios: cada pixel recebe o índice do município + 1 (0 = fora)."""
    h, w = forma
    im = Image.new('I', (w * fator, h * fator), 0)
    d = ImageDraw.Draw(im)
    for k, (_, aneis) in enumerate(municipios):
        for anel in aneis:
            pts = [((lon * sx + ox) * fator, (proj(lat) * sy + oy) * fator) for lon, lat in anel]
            if len(pts) >= 3:
                d.polygon(pts, fill=k + 1)
    return np.asarray(im, dtype=np.int32)


def encaixar(mascara, municipios):
    """Procura escala e deslocamento (lon -> x, lat -> y) que alinham a malha com o desenho.
    Testa projeção simples (graus) e Mercator. Devolve (iou, proj, sx, ox, sy, oy)."""
    ys, xs = np.nonzero(mascara)
    lons = [p[0] for _, aneis in municipios for a in aneis for p in a]
    lats = [p[1] for _, aneis in municipios for a in aneis for p in a]
    melhor = None
    # Reduz a imagem para a busca ficar rápida; o resultado é refinado no tamanho real
    red = 3
    m_red = mascara[::red, ::red]
    for proj in (lambda v: v, _merc):
        y0, y1 = proj(max(lats)), proj(min(lats))
        sx = (xs.max() - xs.min()) / (max(lons) - min(lons))
        ox = xs.min() - min(lons) * sx
        sy = (ys.max() - ys.min()) / (y1 - y0)
        oy = ys.min() - y0 * sy
        params = [sx, ox, sy, oy]

        def iou(p, fator_red):
            forma = (mascara.shape[0] // fator_red + 1, mascara.shape[1] // fator_red + 1)
            r = _rasterizar(municipios, proj, p[0] / fator_red, p[1] / fator_red, p[2] / fator_red, p[3] / fator_red, forma) > 0
            m = m_red if fator_red == red else mascara
            r = r[:m.shape[0], :m.shape[1]]
            return (r & m).sum() / max(1, (r | m).sum())

        atual = iou(params, red)
        # Busca local simples (coordenadas uma a uma), passos cada vez menores
        for passo in (0.02, 0.01, 0.005, 0.0025):
            mudou = True
            while mudou:
                mudou = False
                for i in range(4):
                    escala = abs(params[0]) if i in (0, 1) else abs(params[2])
                    delta = passo * (escala if i in (0, 2) else escala * 2)
                    for sinal in (1, -1):
                        p = list(params)
                        p[i] += sinal * delta
                        v = iou(p, red)
                        if v > atual + 1e-4:
                            params, atual, mudou = p, v, True
        final = iou(params, 1)
        if melhor is None or final > melhor[0]:
            melhor = (final, proj, *params)
    return melhor


def niveis_por_municipio(png_bytes, municipios):
    """municipios: lista [(codigo_ibge, aneis[[ [lon,lat], ... ]])].
    Devolve ({codigo: nivel 1..4}, iou) com nível 1 = atenção ... 4 = extremo (só os que não são normais)."""
    rgb = np.asarray(Image.open(io.BytesIO(png_bytes)).convert('RGB'))
    classes = classificar_cores(rgb)
    mascara = mascara_estado(classes)
    if mascara is None:
        raise ValueError('mapa sem área colorida')
    iou, proj, sx, ox, sy, oy = encaixar(mascara, municipios)
    if iou < ENCAIXE_MIN:
        raise ValueError(f'o desenho do mapa não encaixou na malha do IBGE (sobreposição {iou:.2f})')
    rot = _rasterizar(municipios, proj, sx, ox, sy, oy, classes.shape)[:classes.shape[0], :classes.shape[1]]
    n = len(municipios)
    resultado = {}
    validos = classes >= 0
    total = np.bincount(rot[validos].ravel(), minlength=n + 1)
    for nivel in (ROXO, VERMELHO, LARANJA, AMARELO):
        sel = classes == nivel
        cont = np.bincount(rot[sel].ravel(), minlength=n + 1)
        for k in np.nonzero(cont[1:])[0]:
            cod = municipios[k][0]
            # cobertura acumulada: o município conta o que está neste nível ou acima
            if cod in resultado:
                continue
            acima = sum(np.bincount(rot[classes == nv].ravel(), minlength=n + 1)[k + 1] for nv in range(nivel, ROXO + 1))
            if total[k + 1] and acima / total[k + 1] >= COBERTURA_MIN:
                resultado[cod] = nivel
    return resultado, iou
