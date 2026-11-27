#!/usr/bin/env python3
"""Coletor de alertas do WeatherCenter.

Busca os alertas de todas as fontes que não podem ser lidas direto pelo
navegador, junta tudo num formato único (parecido com o CAP) e grava
`<pasta>/alertas.json`. Roda sozinho no GitHub Actions a cada ~5 minutos
(veja .github/workflows/coletar-alertas.yml) e o app lê o arquivo gerado.

Usa só a biblioteca padrão do Python 3 (nada para instalar).
Uso: python3 coletor/coletar.py [pasta_de_saida]
"""
import csv
import gzip
import html
import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

UA = 'WeatherCenter-coletor/1.0 (app de alertas sem fins comerciais)'
UTC = timezone.utc
BRT = timezone(timedelta(hours=-3))
AGORA = datetime.now(UTC)
DEBUG = os.environ.get('COLETOR_DEBUG') == '1'

UF_POR_CODIGO = {
    '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO',
    '21': 'MA', '22': 'PI', '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL', '28': 'SE', '29': 'BA',
    '31': 'MG', '32': 'ES', '33': 'RJ', '35': 'SP', '41': 'PR', '42': 'SC', '43': 'RS',
    '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF',
}
UFS = set(UF_POR_CODIGO.values())
NOMES_UF = {
    'acre': 'AC', 'alagoas': 'AL', 'amapa': 'AP', 'amazonas': 'AM', 'bahia': 'BA', 'ceara': 'CE',
    'distrito federal': 'DF', 'espirito santo': 'ES', 'goias': 'GO', 'maranhao': 'MA', 'mato grosso do sul': 'MS',
    'mato grosso': 'MT', 'minas gerais': 'MG', 'para': 'PA', 'paraiba': 'PB', 'parana': 'PR', 'pernambuco': 'PE',
    'piaui': 'PI', 'rio de janeiro': 'RJ', 'rio grande do norte': 'RN', 'rio grande do sul': 'RS', 'rondonia': 'RO',
    'roraima': 'RR', 'santa catarina': 'SC', 'sao paulo': 'SP', 'sergipe': 'SE', 'tocantins': 'TO',
}

AMARELO, LARANJA, VERMELHO, ROXO = '#FFD400', '#FF8C00', '#E60000', '#8E24AA'
# Padrão único de níveis do WeatherCenter (igual a js/niveis.js):
# 1 amarelo = Perigo Potencial / Risco Moderado; 2 laranja = Perigo / Risco Alto;
# 3 vermelho = Grande Perigo / Risco Muito Alto; 4 roxo = Alerta Extremo / Risco Extremo
NIVEIS = {1: ('Perigo Potencial', AMARELO), 2: ('Perigo', LARANJA), 3: ('Grande Perigo', VERMELHO), 4: ('Alerta Extremo', ROXO)}


def sem_acento(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s or '') if unicodedata.category(c) != 'Mn').lower().strip()


# ---------------------------------------------------------------- rede
_robots = {}


def robots_permite(url):
    """Respeita o robots.txt de cada site (lido uma vez por execução)."""
    p = urllib.parse.urlsplit(url)
    base = f'{p.scheme}://{p.netloc}'
    if base not in _robots:
        regras = []
        try:
            texto = _get(base + '/robots.txt', 20).decode('utf-8', 'replace')
            valer = False
            for linha in texto.splitlines():
                linha = linha.split('#', 1)[0].strip()
                if ':' not in linha:
                    continue
                chave, valor = (x.strip() for x in linha.split(':', 1))
                chave = chave.lower()
                if chave == 'user-agent':
                    valer = valor == '*' or valor.lower().startswith('weathercenter')
                elif valer and chave == 'disallow' and valor:
                    regras.append(valor)
        except Exception:
            pass  # sem robots.txt (ou fora do ar): permitido
        _robots[base] = regras
        if DEBUG:
            print(f'  [debug] robots de {base}: {regras}')
    caminho = p.path or '/'
    return not any(caminho.startswith(r.rstrip('*')) for r in _robots[base])


def _get(url, timeout):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Encoding': 'gzip', 'Accept': '*/*'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        dados = r.read()
        if r.headers.get('Content-Encoding') == 'gzip':
            dados = gzip.decompress(dados)
        return dados


def baixar(url, timeout=60, tentativas=3):
    if not robots_permite(url):
        raise RuntimeError(f'robots.txt de {urllib.parse.urlsplit(url).netloc} não permite coletar {url}')
    erro = None
    for i in range(tentativas):
        try:
            return _get(url, timeout)
        except urllib.error.HTTPError as e:
            erro = e
            if e.code < 500 and e.code != 429:
                break
        except Exception as e:  # timeout, conexão
            erro = e
        time.sleep(3 * (i + 1))
    raise RuntimeError(f'{url}: {erro}')


# ---------------------------------------------------------------- CAP
def nome(el):
    return el.tag.rsplit('}', 1)[-1]


def filhos(el, n):
    return [c for c in el if nome(c) == n]


def txt(el, n):
    for c in el:
        if nome(c) == n:
            return (c.text or '').strip()
    return ''


def data_iso(s):
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.strip().replace('Z', '+00:00'))
        if d.tzinfo is None:
            d = d.replace(tzinfo=BRT)
        return d.astimezone(UTC)
    except ValueError:
        return None


def iso(d):
    return d.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%SZ') if d else None


def simplificar(pontos, tolerancia):
    """Douglas-Peucker: tira pontos que quase não mudam o desenho."""
    if len(pontos) < 4:
        return pontos
    manter = [False] * len(pontos)
    manter[0] = manter[-1] = True
    pilha = [(0, len(pontos) - 1)]
    while pilha:
        i, j = pilha.pop()
        (y1, x1), (y2, x2) = pontos[i], pontos[j]
        dy, dx = y2 - y1, x2 - x1
        norma = (dx * dx + dy * dy) ** 0.5
        maior, k = 0, None
        for n in range(i + 1, j):
            y, x = pontos[n]
            # anel fechado (1º ponto = último): mede a distância até o ponto
            d = abs(dy * (x - x1) - dx * (y - y1)) / norma if norma > 1e-12 else ((y - y1) ** 2 + (x - x1) ** 2) ** 0.5
            if d > maior:
                maior, k = d, n
        if k is not None and maior > tolerancia:
            manter[k] = True
            pilha += [(i, k), (k, j)]
    return [p for p, m in zip(pontos, manter) if m]


def poligono_cap(texto):
    pontos = []
    for par in (texto or '').split():
        try:
            lat, lon = (float(x) for x in par.split(',')[:2])
        except ValueError:
            continue
        pontos.append([lat, lon])
    return pontos if len(pontos) >= 3 else None


def reduzir_poligonos(aneis, max_pontos=500):
    """Deixa os polígonos leves para o celular: no máximo ~500 pontos por alerta."""
    tol = 0.002  # ~200 m
    while True:
        res = [s for s in (simplificar(a, tol) for a in aneis) if len(s) >= 4]
        if sum(len(a) for a in res) <= max_pontos or tol > 0.2:
            break
        tol *= 2
    return [[[round(lat, 3), round(lon, 3)] for lat, lon in a] for a in res]


SEVERIDADE_CAP = {'extreme': 4, 'severe': 2, 'moderate': 1, 'minor': 1}


def nivel_no_texto(texto):
    """Nível que a própria Defesa Civil escreveu no texto ("ALERTA RISCO ALTO", "Alerta VERMELHO"...)."""
    t = sem_acento(texto or '')
    if re.search(r'alerta extremo|risco extremo|alerta roxo', t):
        return 4
    if re.search(r'risco muito alto|grande perigo|alerta vermelho', t):
        return 3
    if re.search(r'risco alto|alerta laranja', t):
        return 2
    if re.search(r'risco moderado|perigo potencial|alerta amarelo', t):
        return 1
    return 0


def linhas(t):
    return [x.strip(' -•\t') for x in re.split(r'\n+|(?<=[.;])\s+(?=[A-ZÁÉÍÓÚ])', t or '') if x.strip(' -•\t')]


def normalizar_cap(alerta, fonte_id, fonte_nome, link_padrao):
    """Converte um <alert> CAP 1.2 para o formato do app. Devolve (alerta|None, ids_cancelados)."""
    status = txt(alerta, 'status')
    tipo = txt(alerta, 'msgType')
    identificador = txt(alerta, 'identifier')
    if status and status != 'Actual':
        return None, []
    cancelados = []
    for ref in txt(alerta, 'references').split():
        partes = ref.split(',')
        if len(partes) >= 2:
            cancelados.append(f'{fonte_id}-{partes[1]}')
    if tipo == 'Cancel':
        return None, cancelados
    infos = filhos(alerta, 'info')
    if not infos:
        return None, cancelados
    info = next((i for i in infos if txt(i, 'language').lower().startswith('pt')), infos[0])
    expira = data_iso(txt(info, 'expires'))
    if expira and expira < AGORA:
        return None, cancelados
    inicio = data_iso(txt(info, 'onset')) or data_iso(txt(info, 'effective')) or data_iso(txt(alerta, 'sent'))
    nivel_cap = SEVERIDADE_CAP.get(txt(info, 'severity').lower(), 1)
    poligonos, geocodes, areas = [], [], []
    for area in filhos(info, 'area'):
        if txt(area, 'areaDesc'):
            areas.append(txt(area, 'areaDesc'))
        for p in filhos(area, 'polygon'):
            pol = poligono_cap(p.text)
            if pol:
                poligonos.append(pol)
        for g in filhos(area, 'geocode'):
            for v in re.findall(r'\d{6,7}', txt(g, 'value')):
                if v[:2] in UF_POR_CODIGO and v not in geocodes:
                    geocodes.append(v)
    # Com código IBGE o app desenha o contorno oficial do município; sem ele, usa o polígono (simplificado)
    poligonos = [] if geocodes else reduzir_poligonos(poligonos)
    estados = []
    for g in geocodes:
        uf = UF_POR_CODIGO[g[:2]]
        if uf not in estados:
            estados.append(uf)
    emissor = txt(info, 'senderName') or txt(alerta, 'sender')
    texto_uf = ' '.join(areas + [emissor])
    for uf in re.findall(r'(?:[-/(]\s*|\b)([A-Z]{2})\b', texto_uf):
        if uf in UFS and uf not in estados:
            estados.append(uf)
    sem = sem_acento(emissor)
    for n, uf in NOMES_UF.items():
        if f'do {n}' in sem or f'de {n}' in sem or f'da {n}' in sem:
            if uf not in estados:
                estados.append(uf)
            break
    headline = txt(info, 'headline')
    descricao = txt(info, 'description')
    titulo = headline or txt(info, 'event') or 'Alerta'
    if len(titulo) > 140:
        titulo = (txt(info, 'event') or titulo[:137] + '…')
    partes = [x for x in descricao.split('\n') if x.strip()]
    if len(partes) > 1 and re.match(r'defesa\W*civil\W*:', sem_acento(partes[0])):
        descricao = '\n'.join(partes[1:])  # a 1ª linha costuma ser a versão SMS (sem acentos) do mesmo texto
    riscos = linhas(descricao) if descricao and descricao.strip() != headline.strip() else []
    if len(riscos) > 1:
        riscos = [r for r in riscos if not re.match(r'defesa\W*civil\W*:', sem_acento(r))] or riscos
    if headline and len(headline) > 140:
        riscos.insert(0, headline)
    if titulo.isupper():
        titulo = titulo.capitalize()
    if areas and len(titulo) < 40:
        titulo = f"{titulo} – {', '.join(areas)}"[:140]
    web = txt(info, 'web')
    nivel = nivel_no_texto(f"{titulo} {riscos[0] if riscos else ''}") or nivel_cap
    sev, cor = NIVEIS[nivel]
    return {
        'id': f'{fonte_id}-{identificador}',
        'fonteId': fonte_id,
        'fonte': fonte_nome,
        'emissor': emissor,
        'titulo': titulo,
        'evento': txt(info, 'event'),
        'severidade': sev,
        'nivel': nivel,
        'cor': cor,
        'inicio': iso(inicio),
        'fim': iso(expira),
        'riscos': riscos[:8],
        'instrucoes': linhas(txt(info, 'instruction'))[:8],
        'geocodes': geocodes,
        'estados': estados,
        'poligonos': poligonos,
        'areaTexto': ', '.join(areas),
        'link': web if web.startswith('http') else link_padrao,
    }, cancelados


def ler_feed_cap(url, fonte_id, fonte_nome, link_padrao, max_links=150):
    """Lê um feed Atom/RSS de CAP. O CAP pode vir dentro do item ou num link separado."""
    raiz = ET.fromstring(baixar(url, timeout=120))
    if nome(raiz) == 'alert':
        itens = [raiz]
    else:
        itens = [e for e in raiz.iter() if nome(e) in ('entry', 'item')]
    alertas, cancelados, links = {}, set(), 0
    for item in itens:
        cap = item if nome(item) == 'alert' else next((e for e in item.iter() if nome(e) == 'alert'), None)
        if cap is None:
            conteudo = next((e for e in item if nome(e) in ('content', 'description', 'summary')), None)
            texto = html.unescape(conteudo.text or '') if conteudo is not None else ''
            if '<alert' in texto:
                try:
                    cap = ET.fromstring(texto[texto.index('<alert'):].encode('utf-8'))
                except ET.ParseError:
                    cap = None
        if cap is None and links < max_links:
            link = next((e.get('href') or (e.text or '').strip() for e in item if nome(e) == 'link'), '')
            if link.startswith('http'):
                links += 1
                try:
                    cap = ET.fromstring(baixar(link, timeout=30, tentativas=1))
                except Exception as e:
                    print(f'  aviso: não consegui ler {link}: {e}')
        if cap is None:
            continue
        a, canc = normalizar_cap(cap, fonte_id, fonte_nome, link_padrao)
        cancelados.update(canc)
        if a:
            alertas[a['id']] = a  # o mais recente (mesmo id) substitui
    for c in cancelados:
        alertas.pop(c, None)
    return list(alertas.values())


# ---------------------------------------------------------------- fontes
def fonte_defesa_civil():
    """Defesa Civil (nacional, estaduais e municipais) pela IDAP, em CAP 1.2."""
    alertas = ler_feed_cap('https://idapfile.mdr.gov.br/idap/api/rss/cap', 'defesa-civil', 'Defesa Civil',
                           'https://www.gov.br/mdr/pt-br/assuntos/protecao-e-defesa-civil/alertas-de-desastres-1')
    if DEBUG and alertas:
        for a in alertas[:2]:
            print('  [debug] exemplo:', json.dumps({**a, 'poligonos': f"{len(a['poligonos'])} anéis"}, ensure_ascii=False)[:1500])
        aneis = sum(len(a['poligonos']) for a in alertas)
        pts = sum(len(p) for a in alertas for p in a['poligonos'])
        com_geo = sum(1 for a in alertas if a['geocodes'])
        print(f'  [debug] {aneis} anéis, {pts} pontos, {com_geo} com geocode, '
              f"tamanho sem polígonos {len(json.dumps([{**a, 'poligonos': []} for a in alertas])) // 1024} KB")
    return alertas


# Cemaden: o painel (painelalertas.cemaden.gov.br/wsAlertas2) tem dados em JSON, mas o robots.txt
# do site proíbe coleta automática (Disallow: /). Por isso não é lido. Os alertas do Cemaden chegam
# às Defesas Civis e, quando viram aviso à população, entram pela IDAP.


# Áreas marítimas da METAREA V (Marinha) e os estados do litoral de cada uma
AREAS_MARINHA = {
    'ALFA': ('Arroio Chuí a Cabo de Santa Marta', ['RS', 'SC']),
    'BRAVO': ('Cabo de Santa Marta a Cabo Frio', ['SC', 'PR', 'SP', 'RJ']),
    'CHARLIE': ('Cabo Frio a Caravelas', ['RJ', 'ES', 'BA']),
    'DELTA': ('Caravelas a Salvador', ['BA']),
    'ECHO': ('Salvador a Natal', ['BA', 'SE', 'AL', 'PE', 'PB', 'RN']),
    'FOXTROT': ('Natal a São Luís', ['RN', 'CE', 'PI', 'MA']),
    'GOLF': ('São Luís a Cabo Orange', ['MA', 'PA', 'AP']),
    'HOTEL': ('Área oceânica norte', []),
    'SUL OCEÂNICA': ('Área oceânica sul', []),
    'NORTE OCEÂNICA': ('Área oceânica norte', []),
}
RE_AREA = re.compile(r'[ÁA]REA\s+(ALFA|BRAVO|CHARLIE|DELTA|ECHO|FOXTROT|GOLF|HOTEL|SUL OCE[ÂA]NICA|NORTE OCE[ÂA]NICA)')
MESES = {m: i + 1 for i, m in enumerate(['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'])}
MESES.update({'FEB': 2, 'APR': 4, 'MAY': 5, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'DEC': 12})


def html_para_texto(h):
    h = re.sub(r'(?is)<(script|style)\b.*?</\1>', ' ', h)
    h = re.sub(r'(?i)<br\s*/?>|</(p|div|li|tr|h\d)>', '\n', h)
    h = html.unescape(re.sub(r'<[^>]+>', ' ', h))
    return re.sub(r'[ \t\xa0]+', ' ', h)


RE_RESUMO = re.compile(
    r'AVISO\s+(\d+)\s*-\s*([^\n]+?)\s*\n\s*VALIDO DE\s+(\d{1,2})/(\w{3})\s+(\d{2}):(\d{2})\s+A\s+(\d{1,2})/(\w{3})\s+(\d{2}):(\d{2})\s+UTC'
    r'(.*?)(?=\n[ \t]*\n|\s+AVISO\s+\d|\s+WARNING|$)', re.S)


def data_marinha(dia, mes, hh, mm):
    m = MESES.get(mes.upper()[:3], AGORA.month)
    ano = AGORA.year + (1 if m == 1 and AGORA.month == 12 else -1 if m == 12 and AGORA.month == 1 else 0)
    try:
        return datetime(ano, m, int(dia), int(hh), int(mm), tzinfo=UTC)
    except ValueError:
        return None


def fonte_marinha():
    """Avisos de mau tempo da Marinha (CHM) para o litoral e alto-mar. Página HTML, sem feed."""
    url = 'https://www.marinha.mil.br/chm/dados-do-smm-avisos-de-mau-tempo/avisos-de-mau-tempo'
    texto = html_para_texto(baixar(url, timeout=60).decode('utf-8', 'replace'))
    if DEBUG:
        i = texto.find('AVISO NR')
        print('  [debug] marinha texto completo:', repr(texto[max(0, i - 300): i + 1500]) if i >= 0 else 'sem "AVISO NR"')
    alertas, vistos = [], set()
    for m in RE_RESUMO.finditer(texto):
        numero = m[1]
        if numero in vistos:
            continue
        vistos.add(numero)
        tipo = re.sub(r'\s+', ' ', m[2]).strip()
        inicio, fim = data_marinha(m[3], m[4], m[5], m[6]), data_marinha(m[7], m[8], m[9], m[10])
        if fim and fim < AGORA:
            continue
        detalhe = re.sub(r'\s+', ' ', m[11]).strip()
        # A área (Alfa, Bravo...) aparece no texto completo do aviso, quando a página o traz
        areas_achadas = []
        for completo in re.finditer(rf'AVISO\s+NR\s+0*{numero}\s*/\s*\d{{4}}', texto):
            corpo = texto[completo.end(): completo.end() + 2500]
            ate = re.search(r'V[ÁA]LIDO AT[ÉE]\s+\d{6}Z', corpo)
            corpo = corpo[:ate.end()] if ate else corpo
            for a in RE_AREA.findall(corpo) or RE_AREA.findall(texto[:completo.start()])[-1:]:
                if a not in areas_achadas:
                    areas_achadas.append(a)
            detalhe_completo = re.sub(r'\s+', ' ', corpo).strip()
            if len(detalhe_completo) > len(detalhe):
                detalhe = detalhe_completo[:600]
        estados, regioes = [], []
        for a in areas_achadas:
            a = a.replace('OCEANICA', 'OCEÂNICA')
            desc, ufs = AREAS_MARINHA.get(a, ('', []))
            regioes.append(f'Área {a.title()}' + (f' ({desc})' if desc else ''))
            estados += [u for u in ufs if u not in estados]
        for uf in re.findall(r'[A-ZÀ-Ú]{3,}/([A-Z]{2})\b', detalhe):  # "ILHABELA/SP" (não "S/SE", que é direção)
            if uf in UFS and uf not in estados:
                estados.append(uf)
        t = sem_acento(tipo)
        nivel = 3 if re.search(r'tempestade|furacao|ciclone|violento|muito alto|alto/', t) else \
            2 if 'muito' in t or t.endswith('alto') else 1
        cor = NIVEIS[nivel][1]
        alertas.append({
            'id': f'marinha-{numero}',
            'fonteId': 'marinha',
            'fonte': 'Marinha',
            'emissor': 'Centro de Hidrografia da Marinha',
            'titulo': f'Aviso de {tipo.lower()} no mar',
            'evento': tipo.title(),
            'severidade': NIVEIS[nivel][0],
            'nivel': nivel,
            'cor': cor,
            'inicio': iso(inicio),
            'fim': iso(fim),
            'riscos': [detalhe] if detalhe else [],
            'instrucoes': ['Aviso para navegação, pesca e atividades no mar e na orla.'],
            'geocodes': [],
            'estados': estados,
            'poligonos': [],
            'areaTexto': '',
            'regiao': '; '.join(regioes),
            'maritimo': True,
            'link': url,
        })
    if not alertas and 'AVISO' in texto and 'NÃO HÁ AVISOS' not in texto.upper():
        raise RuntimeError('A página da Marinha mudou de formato: há avisos, mas nenhum foi reconhecido')
    return alertas


def fonte_inmet_bruto():
    """Cópia dos avisos do INMET, usada pelo app só quando o INMET não responde direto ao navegador."""
    dados = json.loads(baixar('https://apiprevmet3.inmet.gov.br/avisos/ativos', timeout=60))
    return dados


# ---------------------------------------------------------------- incêndios
INPE_10MIN = 'https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/10min/'
CELULA = 0.02  # graus (~2 km): focos próximos viram uma só área no mapa


def _coluna(cab, *nomes):
    for n in nomes:
        for c in cab:
            if c.strip().lower() == n:
                return c
    return None


def fonte_focos(anterior_caminho):
    """Focos de incêndio por satélite do INPE (Programa Queimadas), últimas 24 horas.

    O INPE publica um arquivo CSV a cada 10 minutos. Para não baixar tudo de novo a cada
    execução, o coletor guarda as áreas já somadas em focos.json e só lê os arquivos novos.
    Devolve o conteúdo de focos.json.
    """
    anterior = {}
    try:
        with open(anterior_caminho, encoding='utf-8') as f:
            anterior = json.load(f)
    except Exception:
        pass
    limite = AGORA - timedelta(hours=24)
    lim_min = int(limite.timestamp() // 60)
    celulas = {}
    for lat, lon, n, ult in anterior.get('celulas', []):
        if ult >= lim_min:
            celulas[(round(lat / CELULA), round(lon / CELULA))] = [ult, n]
    processados = set(anterior.get('arquivos', []))
    indice = baixar(INPE_10MIN, timeout=60).decode('utf-8', 'replace')
    nomes = sorted(set(re.findall(r'focos_10min_\d{8}_\d{4}\.csv', indice)))
    if not nomes:
        if DEBUG:
            print('  [debug] índice do INPE:', repr(indice[:1500]))
        raise RuntimeError('Nenhum arquivo de focos encontrado no índice do INPE')

    def quando(nome):
        d, h = re.findall(r'(\d{8})_(\d{4})', nome)[0]
        return datetime.strptime(d + h, '%Y%m%d%H%M').replace(tzinfo=UTC)

    recentes = [n for n in nomes if quando(n) >= limite]
    novos = [n for n in recentes if n not in processados][-160:]
    lidos, falhas = 0, 0
    for nome in novos:
        try:
            texto = baixar(INPE_10MIN + nome, timeout=30, tentativas=2).decode('utf-8', 'replace')
        except Exception as e:
            falhas += 1
            print(f'  aviso: {nome}: {e}')
            continue
        leitor = csv.DictReader(io.StringIO(texto))
        cab = leitor.fieldnames or []
        c_lat, c_lon = _coluna(cab, 'lat', 'latitude'), _coluna(cab, 'lon', 'longitude')
        c_data = _coluna(cab, 'data_hora_gmt', 'datahora', 'data_hora', 'data')
        c_pais = _coluna(cab, 'pais', 'país')
        if DEBUG and lidos == 0:
            print(f'  [debug] {nome} colunas: {cab}')
        if not c_lat or not c_lon:
            continue
        for r in leitor:
            if c_pais and r.get(c_pais) and sem_acento(r[c_pais]) not in ('brasil', 'brazil'):
                continue
            try:
                lat, lon = float(r[c_lat]), float(r[c_lon])
            except (TypeError, ValueError):
                continue
            d = data_iso((r.get(c_data) or '').replace('/', '-').replace(' ', 'T') + ('' if 'Z' in (r.get(c_data) or '') else 'Z')) if c_data else None
            minuto = int((d or quando(nome)).timestamp() // 60)
            if minuto < lim_min:
                continue
            chave = (round(lat / CELULA), round(lon / CELULA))
            c = celulas.setdefault(chave, [minuto, 0])
            c[0] = max(c[0], minuto)
            c[1] += 1
        processados.add(nome)
        lidos += 1
    print(f'  INPE: {len(novos)} arquivo(s) novo(s), {lidos} lido(s), {falhas} falha(s), {len(celulas)} área(s) com fogo')
    return {
        'versao': 1,
        'gerado_em': iso(AGORA),
        'fonte': 'INPE - Programa Queimadas (focos de calor por satélite)',
        'celula_graus': CELULA,
        'arquivos': sorted(n for n in processados if n in set(recentes)),
        # [lat, lon, detecções, última detecção em minutos desde 1970 (UTC)]
        'celulas': sorted(([round(i * CELULA, 3), round(j * CELULA, 3), n, ult] for (i, j), (ult, n) in celulas.items()),
                          key=lambda c: -c[3]),
    }


FONTES = [
    ('defesa-civil', 'Defesa Civil (IDAP)', fonte_defesa_civil),
    ('marinha', 'Marinha (CHM)', fonte_marinha),
]


def main():
    pasta = sys.argv[1] if len(sys.argv) > 1 else 'saida'
    os.makedirs(pasta, exist_ok=True)
    resultado = {'versao': 1, 'gerado_em': iso(AGORA), 'fontes': {}, 'alertas': [], 'inmet_bruto': None}
    for fid, fnome, fn in FONTES:
        t0 = time.time()
        try:
            alertas = fn()
            resultado['alertas'] += alertas
            resultado['fontes'][fid] = {'nome': fnome, 'ok': True, 'quantidade': len(alertas)}
            print(f'{fnome}: {len(alertas)} alerta(s) em {time.time() - t0:.1f}s')
        except Exception as e:
            resultado['fontes'][fid] = {'nome': fnome, 'ok': False, 'quantidade': 0, 'erro': str(e)[:300]}
            print(f'{fnome}: ERRO {e}')
        resultado['fontes'][fid]['segundos'] = round(time.time() - t0, 1)
    t0 = time.time()
    try:
        resultado['inmet_bruto'] = fonte_inmet_bruto()
        resultado['fontes']['inmet'] = {'nome': 'INMET (cópia)', 'ok': True}
        print(f'INMET (cópia): ok em {time.time() - t0:.1f}s')
    except Exception as e:
        resultado['fontes']['inmet'] = {'nome': 'INMET (cópia)', 'ok': False, 'erro': str(e)[:300]}
        print(f'INMET (cópia): ERRO {e}')
    t0 = time.time()
    try:
        focos = fonte_focos(os.environ.get('FOCOS_ANTERIOR', 'anterior/focos.json'))
        with open(os.path.join(pasta, 'focos.json'), 'w', encoding='utf-8') as f:
            json.dump(focos, f, separators=(',', ':'))
        resultado['fontes']['queimadas'] = {'nome': 'Focos de incêndio (INPE)', 'ok': True, 'quantidade': len(focos['celulas'])}
        print(f'Focos de incêndio (INPE): {len(focos["celulas"])} área(s) em {time.time() - t0:.1f}s')
    except Exception as e:
        resultado['fontes']['queimadas'] = {'nome': 'Focos de incêndio (INPE)', 'ok': False, 'erro': str(e)[:300]}
        print(f'Focos de incêndio (INPE): ERRO {e}')
        # mantém a última versão para não apagar o mapa por causa de uma falha passageira
        try:
            import shutil
            shutil.copy(os.environ.get('FOCOS_ANTERIOR', 'anterior/focos.json'), os.path.join(pasta, 'focos.json'))
        except Exception:
            pass
    resultado['alertas'].sort(key=lambda a: -a['nivel'])
    # A cópia do INMET vai num arquivo à parte: o app só baixa quando o INMET não responde
    inmet = resultado.pop('inmet_bruto')
    if inmet is not None:
        with open(os.path.join(pasta, 'inmet.json'), 'w', encoding='utf-8') as f:
            json.dump(inmet, f, ensure_ascii=False, separators=(',', ':'))
    caminho = os.path.join(pasta, 'alertas.json')
    with open(caminho, 'w', encoding='utf-8') as f:
        json.dump(resultado, f, ensure_ascii=False, separators=(',', ':'))
    print(f'Gravado {caminho}: {len(resultado["alertas"])} alertas, {os.path.getsize(caminho) // 1024} KB')
    if not any(f['ok'] for f in resultado['fontes'].values()):
        sys.exit(1)


if __name__ == '__main__':
    main()
