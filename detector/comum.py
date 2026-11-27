"""Peças comuns do detector WeatherCenter: rede, municípios, níveis de severidade,
geometria (máscara de grade -> polígonos) e o formato de alerta usado pelo app."""
import json
import math
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np

UA = 'WeatherCenter-detector/1.0 (alertas meteorologicos sem fins comerciais; github.com/arthurhdonato-png/weathercenter)'
UTC = timezone.utc
BRT = timezone(timedelta(hours=-3))
DEBUG = os.environ.get('DETECTOR_DEBUG') == '1'
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Mesmos níveis e cores dos alertas do INMET e da Defesa Civil já mostrados no app
NIVEIS = {
    1: ('Perigo Potencial', '#FFD400'),   # amarelo · risco moderado
    2: ('Perigo', '#FF8C00'),             # laranja · risco alto
    3: ('Grande Perigo', '#E60000'),      # vermelho · risco muito alto
    4: ('Alerta Extremo', '#8E24AA'),     # roxo · risco extremo (padrão do site; o detector usa até o nível 3)
}
NOME_NIVEL = {1: 'risco moderado', 2: 'risco alto', 3: 'risco muito alto', 4: 'risco extremo'}

UF_POR_CODIGO = {
    '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO',
    '21': 'MA', '22': 'PI', '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL', '28': 'SE', '29': 'BA',
    '31': 'MG', '32': 'ES', '33': 'RJ', '35': 'SP', '41': 'PR', '42': 'SC', '43': 'RS',
    '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF',
}


def log(*a):
    print(*a, flush=True)


def dbg(*a):
    if DEBUG:
        print('  [debug]', *a, flush=True)


def iso(d):
    return d.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%SZ') if d else None


def agora():
    """Hora "atual". Nos testes com casos antigos, DETECTOR_AGORA=2025-11-07T20:30Z."""
    v = os.environ.get('DETECTOR_AGORA')
    if v:
        return datetime.fromisoformat(v.replace('Z', '+00:00')).astimezone(UTC)
    return datetime.now(UTC)


# ---------------------------------------------------------------- rede
def baixar(url, timeout=60, tentativas=5, intervalo=None, cabecalhos=None):
    """GET com novas tentativas. intervalo=(inicio, fim) pede só um pedaço do arquivo (bytes)."""
    h = {'User-Agent': UA}
    if intervalo:
        h['Range'] = f'bytes={intervalo[0]}-{intervalo[1]}'
    h.update(cabecalhos or {})
    erro = None
    for i in range(tentativas):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            erro = e
            if e.code in (403, 404) or (e.code < 500 and e.code not in (429, 408)):
                break
        except Exception as e:  # timeout, conexão
            erro = e
        # 503 "SlowDown" do S3: espera mais
        time.sleep(2 * (i + 1) + (6 * (i + 1) if '503' in str(erro) else 0))
    raise RuntimeError(f'{url}: {erro}')


def existe(url):
    try:
        req = urllib.request.Request(url, method='HEAD', headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status == 200
    except Exception:
        return False


# ---------------------------------------------------------------- municípios
class Municipios:
    """Os 5.570 municípios (sede): nome, UF, coordenadas, população e código IBGE."""

    def __init__(self, caminho=None):
        caminho = caminho or os.path.join(RAIZ, 'dados', 'cidades.json')
        with open(caminho, encoding='utf-8') as f:
            d = json.load(f)
        c = d['cidades']
        campos = d['campos']
        i = {n: campos.index(n) for n in campos}
        self.nome = [x[i['nome']] for x in c]
        self.uf = [x[i['uf']] for x in c]
        self.lat = np.array([x[i['lat']] for x in c], dtype=float)
        self.lon = np.array([x[i['lon']] for x in c], dtype=float)
        self.pop = np.array([x[i['populacao']] for x in c], dtype=float)
        self.ibge = [str(x[i['ibge']]) if 'ibge' in i else '' for x in c]

    def na_grade(self, mascara, lat0, lon0, passo):
        """Índices dos municípios cuja sede cai numa célula verdadeira da máscara (grade regular,
        lat0/lon0 = centro da célula [0,0], latitude decrescente por linha)."""
        ny, nx = mascara.shape
        li = np.rint((lat0 - self.lat) / passo).astype(int)
        lj = np.rint((self.lon - lon0) / passo).astype(int)
        ok = (li >= 0) & (li < ny) & (lj >= 0) & (lj < nx)
        sel = np.zeros(len(self.lat), bool)
        sel[ok] = mascara[li[ok], lj[ok]]
        return np.nonzero(sel)[0]

    def perto(self, lat, lon, raio_km):
        return np.nonzero(distancia_km(lat, lon, self.lat, self.lon) <= raio_km)[0]

    def no_poligono(self, anel):
        a = np.asarray(anel)
        sel = (self.lat >= a[:, 0].min()) & (self.lat <= a[:, 0].max()) & (self.lon >= a[:, 1].min()) & (self.lon <= a[:, 1].max())
        idx = np.nonzero(sel)[0]
        return [k for k in idx if ponto_no_anel(self.lat[k], self.lon[k], a)]

    def descrever(self, idx, maximo=6):
        """Texto curto com as maiores cidades: "Cascavel, Toledo e mais 12 cidades (PR, SC)"."""
        idx = sorted(idx, key=lambda k: -self.pop[k])
        nomes = [self.nome[k] for k in idx[:maximo]]
        ufs = []
        for k in idx:
            if self.uf[k] not in ufs:
                ufs.append(self.uf[k])
        resto = len(idx) - len(nomes)
        if not nomes:
            return '', []
        if resto > 0:
            texto = ', '.join(nomes) + f' e mais {resto} cidade' + ('s' if resto > 1 else '')
        elif len(nomes) > 1:
            texto = ', '.join(nomes[:-1]) + ' e ' + nomes[-1]
        else:
            texto = nomes[0]
        return f"{texto} ({', '.join(ufs[:6])}{'…' if len(ufs) > 6 else ''})", ufs


def distancia_km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = np.sin((lat2 - lat1) * p / 2) ** 2 + np.cos(lat1 * p) * np.cos(lat2 * p) * np.sin((lon2 - lon1) * p / 2) ** 2
    return 12742 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def ponto_no_anel(lat, lon, anel):
    dentro = False
    n = len(anel)
    j = n - 1
    for i in range(n):
        yi, xi = anel[i][0], anel[i][1]
        yj, xj = anel[j][0], anel[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            dentro = not dentro
        j = i
    return dentro


# ---------------------------------------------------------------- geometria
def contornos(mascara, lat0, lon0, passo, suavizar=2):
    """Transforma uma máscara de grade em anéis [[lat, lon], ...] (contorno externo e buracos).

    Segue as bordas das células verdadeiras e depois suaviza os degraus (Chaikin), para o
    desenho ficar parecido com o de um aviso feito à mão. Com a regra par-ímpar de
    preenchimento (padrão do Leaflet) os buracos aparecem corretamente.
    """
    m = np.pad(np.asarray(mascara, bool), 1)
    ny, nx = m.shape
    # Arestas orientadas (sentido horário na tela), em coordenadas de canto (linha, coluna)
    prox = {}
    ys, xs = np.nonzero(m)
    for y, x in zip(ys, xs):
        if not m[y - 1, x]:
            prox.setdefault((y, x), []).append((y, x + 1))
        if not m[y, x + 1]:
            prox.setdefault((y, x + 1), []).append((y + 1, x + 1))
        if not m[y + 1, x]:
            prox.setdefault((y + 1, x + 1), []).append((y + 1, x))
        if not m[y, x - 1]:
            prox.setdefault((y + 1, x), []).append((y, x))
    aneis = []
    while prox:
        inicio = next(iter(prox))
        anel = [inicio]
        atual = inicio
        anterior = None
        while True:
            saidas = prox.get(atual)
            if not saidas:
                break
            if len(saidas) > 1 and anterior is not None:
                # Canto em diagonal: vira à direita para não cruzar o contorno
                dy, dx = atual[0] - anterior[0], atual[1] - anterior[1]
                direita = (atual[0] + dx, atual[1] - dy)
                escolha = direita if direita in saidas else saidas[0]
            else:
                escolha = saidas[0]
            saidas.remove(escolha)
            if not saidas:
                del prox[atual]
            anterior, atual = atual, escolha
            if atual == inicio:
                break
            anel.append(atual)
        if len(anel) >= 4:
            aneis.append(anel)
    res = []
    for anel in aneis:
        # tira pontos no meio de retas
        pts = []
        n = len(anel)
        for i in range(n):
            a, b, c = anel[i - 1], anel[i], anel[(i + 1) % n]
            if (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) != 0:
                pts.append(b)
        if len(pts) < 3:
            continue
        pts = [(float(y), float(x)) for y, x in pts]
        for _ in range(suavizar):
            novo = []
            for i in range(len(pts)):
                (y1, x1), (y2, x2) = pts[i], pts[(i + 1) % len(pts)]
                novo += [(0.75 * y1 + 0.25 * y2, 0.75 * x1 + 0.25 * x2), (0.25 * y1 + 0.75 * y2, 0.25 * x1 + 0.75 * x2)]
            pts = novo
        # canto (linha, coluna) -> lat/lon. O canto (1,1) do pad é a borda noroeste da célula [0,0]
        anel_ll = [[round(lat0 + passo / 2 - (y - 1) * passo, 3), round(lon0 - passo / 2 + (x - 1) * passo, 3)] for y, x in pts]
        anel_ll.append(anel_ll[0])
        res.append(simplificar(anel_ll, passo * 0.15))
    return res


def simplificar(anel, tol):
    """Douglas-Peucker: tira pontos que quase não mudam o desenho (tol em graus)."""
    if len(anel) < 6:
        return anel
    pts = anel
    manter = [False] * len(pts)
    manter[0] = manter[-1] = True
    pilha = [(0, len(pts) - 1)]
    while pilha:
        i, j = pilha.pop()
        (y1, x1), (y2, x2) = pts[i], pts[j]
        dy, dx = y2 - y1, x2 - x1
        norma = (dx * dx + dy * dy) ** 0.5
        maior, k = 0, None
        for n in range(i + 1, j):
            y, x = pts[n]
            d = abs(dy * (x - x1) - dx * (y - y1)) / norma if norma > 1e-12 else ((y - y1) ** 2 + (x - x1) ** 2) ** 0.5
            if d > maior:
                maior, k = d, n
        if k is not None and maior > tol:
            manter[k] = True
            pilha += [(i, k), (k, j)]
    res = [p for p, m in zip(pts, manter) if m]
    return res if len(res) >= 4 else anel


def casco_convexo(pontos):
    """Monotone chain. pontos = [(lat, lon)] -> anel fechado."""
    p = sorted(set((round(a, 4), round(b, 4)) for a, b in pontos), key=lambda q: (q[1], q[0]))
    if len(p) < 3:
        return [list(x) for x in p]

    def giro(o, a, b):
        return (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1])
    baixo, cima = [], []
    for q in p:
        while len(baixo) >= 2 and giro(baixo[-2], baixo[-1], q) <= 0:
            baixo.pop()
        baixo.append(q)
    for q in reversed(p):
        while len(cima) >= 2 and giro(cima[-2], cima[-1], q) <= 0:
            cima.pop()
        cima.append(q)
    h = baixo[:-1] + cima[:-1]
    return [[round(a, 3), round(b, 3)] for a, b in h] + [[round(h[0][0], 3), round(h[0][1], 3)]]


def circulo(lat, lon, raio_km, n=24):
    dlat = raio_km / 111.2
    dlon = raio_km / (111.2 * max(0.2, math.cos(math.radians(lat))))
    return [(lat + dlat * math.sin(2 * math.pi * k / n), lon + dlon * math.cos(2 * math.pi * k / n)) for k in range(n)]


def rumo_texto(graus):
    nomes = ['norte', 'nordeste', 'leste', 'sudeste', 'sul', 'sudoeste', 'oeste', 'noroeste']
    return nomes[int(((graus % 360) + 22.5) // 45) % 8]


def hora_local(d):
    return d.astimezone(BRT).strftime('%H:%M')


# ---------------------------------------------------------------- alerta no formato do app
AVISO_NAO_OFICIAL = ('Alerta automático do WeatherCenter, gerado por computador a partir de dados de satélite, '
                     'radar, estações e modelos de previsão. Não é um aviso oficial: siga sempre as orientações '
                     'da Defesa Civil (199) e do INMET.')


def alerta(*, ident, tipo, metodo, nivel, titulo, evento, inicio, fim, riscos, instrucoes, municipios, idx_mun,
           poligonos, detalhes=None, confianca=None, atualizado=None):
    sev, cor = NIVEIS[nivel]
    area_txt, ufs = municipios.descrever(idx_mun)
    geocodes = sorted({municipios.ibge[k] for k in idx_mun if municipios.ibge[k] not in ('', '0')})
    return {
        'id': f'weathercenter-{ident}',
        'fonteId': 'weathercenter',
        'fonte': 'WeatherCenter',
        'emissor': 'Detecção automática (não oficial)',
        'titulo': titulo,
        'evento': evento,
        'tipo': tipo,            # chuva | vento | tempestade | granizo | tornado
        'metodo': metodo,        # previsao | raios | radar | observacao
        'severidade': sev,
        'nivel': nivel,
        'cor': cor,
        'inicio': iso(inicio),
        'fim': iso(fim),
        'riscos': [r for r in riscos if r][:8],
        'instrucoes': instrucoes[:8],
        'geocodes': geocodes,
        'estados': ufs,
        'poligonos': poligonos,
        'areaTexto': area_txt,
        'link': 'https://github.com/arthurhdonato-png/weathercenter/blob/main/detector/CRITERIOS.md',
        'oficial': False,
        'automatico': True,
        'confianca': confianca,
        'atualizadoEm': iso(atualizado or agora()),
        'detalhes': detalhes or {},
    }


INSTRUCOES = {
    'chuva': ['Evite áreas alagadas, rios e córregos; não atravesse ruas inundadas a pé ou de carro.',
              'Em encostas, observe rachaduras, inclinação de árvores e postes e água barrenta: saia do local se perceber.',
              'Desligue a energia elétrica se a água entrar em casa.',
              'Em emergência ligue para a Defesa Civil (199) ou o Corpo de Bombeiros (193).'],
    'vento': ['Não se abrigue debaixo de árvores, placas ou estruturas metálicas.',
              'Recolha objetos soltos no quintal e na varanda; feche portas e janelas.',
              'Evite estacionar perto de árvores e redes elétricas.',
              'Em emergência ligue para a Defesa Civil (199) ou o Corpo de Bombeiros (193).'],
    'tempestade': ['Procure abrigo em local fechado e seguro; evite áreas abertas.',
                   'Não se abrigue debaixo de árvores e fique longe de redes elétricas e objetos metálicos.',
                   'Retire aparelhos elétricos da tomada e proteja carros do granizo, se puder.',
                   'Acompanhe os avisos oficiais. Em emergência ligue 199 (Defesa Civil) ou 193 (Bombeiros).'],
    'tornado': ['Saiba agora onde fica o abrigo mais seguro: cômodo interno, sem janelas, no andar mais baixo.',
                'Se o tempo piorar de repente (vento muito forte, granizo, ronco contínuo), vá para esse abrigo e proteja a cabeça.',
                'Fique longe de janelas e não tente fotografar ou fugir de carro em cima da hora.',
                'Acompanhe a Defesa Civil (199) e o INMET.'],
}
