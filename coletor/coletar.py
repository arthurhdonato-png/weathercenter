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


# ---------------------------------------------------------------- municípios (nome -> código IBGE)
_MUNICIPIOS = {}
NOME_MUNICIPIO = {}  # código IBGE -> nome oficial


def municipios():
    """{(nome sem acento, UF): código IBGE} a partir de dados/cidades.json (todas as 5.570 cidades)."""
    if not _MUNICIPIOS:
        base = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dados', 'cidades.json')
        with open(base, encoding='utf-8') as f:
            d = json.load(f)
        i_nome, i_uf, i_ibge = (d['campos'].index(c) for c in ('nome', 'uf', 'ibge'))
        for c in d['cidades']:
            _MUNICIPIOS[(chave_nome(c[i_nome]), c[i_uf])] = str(c[i_ibge])
            NOME_MUNICIPIO[str(c[i_ibge])] = c[i_nome]
    return _MUNICIPIOS


def chave_nome(n):
    n = sem_acento(n).replace("'", ' ').replace('-', ' ')
    return re.sub(r'\s+', ' ', re.sub(r"[^a-z0-9 ]", ' ', n)).strip()


# grafias diferentes entre os boletins e o IBGE
APELIDOS = {('santana do livramento', 'RS'): 'sant ana do livramento', ('s j dos ausentes', 'RS'): 'sao jose dos ausentes'}


def geocode_municipio(nome, uf):
    k = (chave_nome(nome), uf)
    k = (APELIDOS.get(k, k[0]), uf)
    try:
        return municipios().get(k)
    except Exception:
        return None


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
    if not geocodes:
        # Sem código IBGE, mas com o município escrito na área ("Itaqui/RS"): usa o contorno oficial do
        # município, para o alerta aparecer no mapa inteiro da cidade e na linha do tempo dela
        for ar in areas:
            m = re.fullmatch(r'\s*(.+?)\s*[/-]\s*([A-Z]{2})\s*', ar)
            g = geocode_municipio(m[1], m[2]) if m and m[2] in UFS else None
            if g and g not in geocodes:
                geocodes.append(g)
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


CANCELADOS = set()  # ids de alertas cancelados vistos nesta execução (guardados para as próximas)


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
    CANCELADOS.update(cancelados)
    return list(alertas.values())


# ---------------------------------------------------------------- memória entre coletas
ANTERIOR = {'alertas': [], 'cancelados': {}}


def ler_anterior(caminho):
    """Coleta anterior (ramo dados). Serve para não perder alertas que ainda valem."""
    try:
        with open(caminho, encoding='utf-8') as f:
            d = json.load(f)
        ANTERIOR['alertas'] = d.get('alertas') or []
        ANTERIOR['cancelados'] = d.get('cancelados') or {}
    except Exception:
        pass


def manter_vigentes(fonte_id, novos, horas_sem_fim=24, grupos_vistos=()):
    """O feed da IDAP só traz as últimas ~12 horas de envios: um alerta de 24 h (ex.: "Risco MUITO ALTO
    de inundação em São Borja, válido até 06h15 de amanhã") some do feed antes de acabar. Por isso o
    coletor guarda o que já viu e só tira o alerta do ar quando ele vence ou é cancelado."""
    ids = {a['id'] for a in novos}
    # Um mapa novo substitui o anterior do mesmo tipo, mesmo que agora esteja tudo normal
    grupos = {a['grupo'] for a in novos if a.get('grupo')} | set(grupos_vistos)
    cancelados = CANCELADOS | set(ANTERIOR['cancelados'])
    mantidos = []
    for a in ANTERIOR['alertas']:
        if a.get('fonteId') != fonte_id or a['id'] in ids or a['id'] in cancelados or a.get('grupo') in grupos:
            continue
        fim = data_iso(a.get('fim'))
        if fim is None:
            ini = data_iso(a.get('inicio'))
            fim = ini + timedelta(hours=horas_sem_fim) if ini else None
        if fim and fim > AGORA:
            mantidos.append({**a, 'mantido': True})
    if mantidos:
        print(f'  {fonte_id}: {len(mantidos)} alerta(s) ainda vigente(s) que já saíram do feed')
    return novos + mantidos


# ---------------------------------------------------------------- fontes
def fonte_defesa_civil():
    """Defesa Civil (nacional, estaduais e municipais) pela IDAP, em CAP 1.2."""
    alertas = ler_feed_cap('https://idapfile.mdr.gov.br/idap/api/rss/cap', 'defesa-civil', 'Defesa Civil',
                           'https://www.gov.br/mdr/pt-br/assuntos/protecao-e-defesa-civil/alertas-de-desastres-1')
    alertas = manter_vigentes('defesa-civil', alertas)
    if DEBUG and alertas:
        for a in alertas[:2]:
            print('  [debug] exemplo:', json.dumps({**a, 'poligonos': f"{len(a['poligonos'])} anéis"}, ensure_ascii=False)[:1500])
        aneis = sum(len(a['poligonos']) for a in alertas)
        pts = sum(len(p) for a in alertas for p in a['poligonos'])
        com_geo = sum(1 for a in alertas if a['geocodes'])
        print(f'  [debug] {aneis} anéis, {pts} pontos, {com_geo} com geocode, '
              f"tamanho sem polígonos {len(json.dumps([{**a, 'poligonos': []} for a in alertas])) // 1024} KB")
    return alertas


# ---------------------------------------------------------------- Defesa Civil RS (site oficial)
DC_RS = 'https://www.defesacivil.rs.gov.br'
DC_RS_LISTA = DC_RS + '/avisos-e-alertas-6ad7aa4f35d41'
# Nomes dos níveis nos mapas da Defesa Civil RS -> padrão do WeatherCenter (normal = sem alerta)
NIVEIS_MAPA_RS = {
    'met': {1: 'Atenção', 2: 'Alerta', 3: 'Severo', 4: 'Extremo'},
    'hidro': {1: 'Atenção', 2: 'Alerta', 3: 'Inundação', 4: 'Inundação extrema'},
}
DIAS_SEMANA = r'(?:segunda|terça|terca|quarta|quinta|sexta|sábado|sabado|domingo)(?:-feira)?'
_MALHA_RS = []


def malha_municipios_rs():
    """Contornos oficiais dos 497 municípios do RS (IBGE, a mesma malha que o app desenha)."""
    if not _MALHA_RS:
        url = ('https://servicodados.ibge.gov.br/api/v3/malhas/estados/43?formato=application/vnd.geo%2Bjson'
               '&qualidade=intermediaria&intrarregiao=municipio')
        geo = json.loads(baixar(url, timeout=90))
        import mapas_rs
        for f in geo['features']:
            _MALHA_RS.append((str(f['properties']['codarea']), mapas_rs._aneis(f['geometry'])))
    return _MALHA_RS


def _data_post(h):
    m = re.search(r'article:published_time"\s+content="([^"]+)"', h)
    if m:
        try:
            return datetime.strptime(m[1], '%Y-%m-%dT%H:%M:%S%z').astimezone(UTC)
        except ValueError:
            pass
    m = re.search(r'Publica(?:ção|&ccedil;&atilde;o):\s*(?:<[^>]+>\s*)*(\d{2})/(\d{2})/(\d{4}) às (\d{1,2})h(\d{2})', h)
    if m:
        return datetime(int(m[3]), int(m[2]), int(m[1]), int(m[4]), int(m[5]), tzinfo=BRT).astimezone(UTC)
    return None


def _corpo_post(h):
    """Título, imagem principal e texto do post (o que vem depois de "Publicação:")."""
    h = html.unescape(h)
    titulo = re.search(r'<title>(.*?)</title>', h, re.S)[1].split(' - Defesa Civil')[0].strip()
    i = h.find('Publicação:')
    fim = h.find('Avisos e alertas', i)
    trecho = h[i:fim if fim > i else i + 20000] if i >= 0 else ''
    img = re.search(r'<img[^>]+src="(/upload/recortes/[^"]+_GD\.(?:png|jpe?g))"[^>]*alt="([^"]*)"', trecho)
    texto = html_para_texto(trecho)
    texto = re.sub(r'^\s*Publicação:\s*\S+ às \S+\s*', '', texto)
    paragrafos = [re.sub(r'\s+', ' ', x).strip() for x in texto.split('\n')]
    paragrafos = [x for x in paragrafos if len(x) > 3 and not x.startswith('Procure informações junto')]
    return titulo, (img[1] if img else None), (img[2] if img else ''), paragrafos


def _ultimo_dia_citado(texto, publicado):
    """O texto do prognóstico cita os dias ("No domingo (29)"); o aviso vale até o fim do último dia citado."""
    pub = publicado.astimezone(BRT)
    ultimo = None
    for d in re.findall(rf'{DIAS_SEMANA}\s*\((\d{{1,2}})\)', texto, re.I):
        d = int(d)
        data = pub.replace(day=1, hour=23, minute=59, second=0, microsecond=0)
        mes, ano = pub.month, pub.year
        if d < pub.day - 7:  # virou o mês
            mes, ano = (1, ano + 1) if mes == 12 else (mes + 1, ano)
        try:
            data = data.replace(year=ano, month=mes, day=d)
        except ValueError:
            continue
        if ultimo is None or data > ultimo:
            ultimo = data
    return ultimo.astimezone(UTC) if ultimo else None


def _valido_ate(texto, publicado):
    """"Válido até as 6h15 do dia 28/11" ou "Val. 24h"."""
    m = re.search(r'v[aá]lid[oa] at[eé] (?:[àa]s )?(\d{1,2})h(\d{2})? (?:do dia |de )?(\d{1,2})/(\d{1,2})', texto, re.I)
    if m:
        pub = publicado.astimezone(BRT)
        ano = pub.year + (1 if int(m[4]) < pub.month - 6 else 0)
        try:
            return datetime(ano, int(m[4]), int(m[3]), int(m[1]), int(m[2] or 0), tzinfo=BRT).astimezone(UTC)
        except ValueError:
            pass
    m = re.search(r'val(?:idade|\.)?\s*(\d{1,3})\s*h', texto, re.I)
    if m:
        return publicado + timedelta(hours=int(m[1]))
    return None


def _municipios_no_texto(frase):
    """Municípios do RS citados na frase do alerta ("Risco MUITO ALTO em São Borja", "entre Barra do Guarita e Porto Mauá")."""
    alvo = ' ' + chave_nome(re.sub(r'(?i)rio grande do sul', ' ', frase)) + ' '
    achados = []
    nomes = sorted(((n, c) for (n, uf), c in municipios().items() if uf == 'RS'), key=lambda x: -len(x[0]))
    for n, c in nomes:
        if f' {n} ' in alvo:
            alvo = alvo.replace(f' {n} ', ' # ')
            achados.append(c)
    return achados


def _alerta_rs(post_id, url, publicado, fim, nivel, nome_fonte, titulo, riscos, geocodes, grupo, regiao=''):
    return {
        'id': f'defesa-civil-rs-{post_id}-{nivel}',
        'fonteId': 'defesa-civil-rs',
        'fonte': 'Defesa Civil',
        'emissor': 'Defesa Civil do Rio Grande do Sul',
        'titulo': titulo,
        'evento': titulo.split(' – ')[0],
        'severidade': NIVEIS[nivel][0],
        'severidadeFonte': nome_fonte,
        'nivel': nivel,
        'cor': NIVEIS[nivel][1],
        'inicio': iso(publicado),
        'fim': iso(fim),
        'riscos': riscos[:8],
        'instrucoes': ['Siga as orientações da Defesa Civil do seu município.', 'Em caso de emergência, ligue 199 (Defesa Civil) ou 193 (Bombeiros).'],
        'geocodes': geocodes,
        'estados': ['RS'],
        'poligonos': [],
        'areaTexto': '',
        'regiao': regiao,
        'grupo': grupo,
        'postId': post_id,
        'link': url,
    }


def fonte_defesa_civil_rs():
    """Avisos publicados no site oficial da Defesa Civil RS (os mesmos das redes sociais):
    - mapas "Áreas com risco meteorológico" e "Áreas com risco hidrológico" (níveis por área, lidos da imagem);
    - alertas por cidade ("Risco MUITO ALTO de inundação em São Borja", com validade no texto)."""
    lista = baixar(DC_RS_LISTA, timeout=60).decode('utf-8', 'replace')
    posts = []
    for h in re.findall(r'href="(/[a-z0-9-]+-([0-9a-f]{12,13}))"', lista):
        if h not in posts and 'avisos-e-alertas' not in h[0] and re.search(r'alerta|risco|progn|aviso|inundac|temporal|chuva', h[0]):
            posts.append(h)
    anteriores = {}
    for a in ANTERIOR['alertas']:
        if a.get('fonteId') == 'defesa-civil-rs' and a.get('postId'):
            anteriores.setdefault(a['postId'], []).append(a)
    alertas, erros, grupos_vistos, publicado_grupo = [], [], set(), {}
    for caminho, post_id in posts[:10]:
        if post_id in anteriores:  # já lido numa coleta anterior: não baixa de novo
            grupo = anteriores[post_id][0].get('grupo', '')
            if grupo.startswith('rs-mapa-'):
                if grupo in grupos_vistos:
                    continue
                grupos_vistos.add(grupo)
            alertas += [x for x in anteriores[post_id] if data_iso(x.get('fim')) and data_iso(x['fim']) > AGORA]
            continue
        url = DC_RS + caminho
        try:
            h = baixar(url, timeout=60).decode('utf-8', 'replace')
            publicado = _data_post(h)
            if not publicado or publicado < AGORA - timedelta(days=4):
                continue
            titulo, img, alt, paragrafos = _corpo_post(h)
            texto = ' '.join(paragrafos)
            t = sem_acento(f'{titulo} {alt}')
            tipo = 'met' if 'prognostico meteorologico' in t or 'mapa met' in t else \
                'hidro' if 'prognostico hidrologico' in t or 'mapa hidro' in t else None
            if tipo and img:
                # Só o mapa mais recente de cada tipo vale (a lista vem do mais novo para o mais velho)
                if f'rs-mapa-{tipo}' in grupos_vistos:
                    continue
                grupos_vistos.add(f'rs-mapa-{tipo}')
                fim = _ultimo_dia_citado(texto, publicado) or publicado + timedelta(hours=48)
                if fim < AGORA:
                    continue
                import mapas_rs
                niveis, encaixe = mapas_rs.niveis_por_municipio(baixar(DC_RS + img, timeout=60), malha_municipios_rs())
                print(f'  mapa {tipo} {post_id}: {len(niveis)} município(s) com risco (encaixe {encaixe:.2f})')
                nome_mapa = 'Risco meteorológico' if tipo == 'met' else 'Risco hidrológico'
                for nivel in (4, 3, 2, 1):
                    cods = sorted(c for c, n in niveis.items() if n == nivel)
                    if not cods:
                        continue
                    nome_nivel = NIVEIS_MAPA_RS[tipo][nivel]
                    alertas.append(_alerta_rs(
                        post_id, url, publicado, fim, nivel, nome_nivel, f'{nome_mapa} – {nome_nivel}', paragrafos,
                        cods, f'rs-mapa-{tipo}',
                        f'Mapa de {nome_mapa.lower()} da Defesa Civil RS: nível {nome_nivel.upper()} em {len(cods)} município(s). '
                        'Áreas lidas do mapa oficial e ajustadas aos limites dos municípios.'))
                continue
            # Alerta para cidades citadas no texto
            frase = next((p for p in paragrafos if re.search(r'(?i)risco|alerta', p)), '')
            nivel = nivel_no_texto(f'{titulo} {frase}')
            fim = _valido_ate(frase, publicado)
            cods = _municipios_no_texto(frase or titulo)
            if not nivel or not cods or not fim or fim < AGORA:
                continue
            evento = re.search(r'(?i)(inunda[çc][ãa]o|enxurrada|alagamento|temporal|tempestade|chuva[s]? intensa[s]?|granizo|vendaval|deslizamento|eleva[çc][ãa]o)', frase)
            ev = evento[1].capitalize() if evento else 'Alerta'
            cidades = ', '.join(NOME_MUNICIPIO[c] for c in cods)
            alertas.append(_alerta_rs(post_id, url, publicado, fim, nivel, ('Risco Moderado', 'Risco Alto', 'Risco Muito Alto', 'Risco Extremo')[nivel - 1],
                                      f'{ev} – {cidades[:100]}/RS',
                                      [frase] + [p for p in paragrafos if p != frase], cods, f'rs-cidade-{post_id}'))
        except Exception as e:
            erros.append(f'{url}: {e}')
            print(f'  aviso: {url}: {e}')
    if erros and not alertas and len(erros) >= len(posts[:10]):
        raise RuntimeError('; '.join(erros)[:300])
    for a in alertas:
        if a.get('grupo', '').startswith('rs-mapa-'):
            grupos_vistos.add(a['grupo'])
    return manter_vigentes('defesa-civil-rs', alertas, grupos_vistos=grupos_vistos)


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
    ('defesa-civil-rs', 'Defesa Civil RS (site oficial)', fonte_defesa_civil_rs),
    ('marinha', 'Marinha (CHM)', fonte_marinha),
]


def sem_repetidos(alertas):
    """O mesmo alerta de cidade pode vir pela IDAP (SMS) e pelo site da Defesa Civil RS: fica o da IDAP."""
    idap = [(set(a['geocodes']), a['nivel']) for a in alertas if a.get('fonteId') == 'defesa-civil' and a['geocodes']]
    res = []
    for a in alertas:
        if a.get('fonteId') == 'defesa-civil-rs' and str(a.get('grupo', '')).startswith('rs-cidade-') and \
                any(n == a['nivel'] and set(a['geocodes']) <= g for g, n in idap):
            continue
        res.append(a)
    return res


def main():
    pasta = sys.argv[1] if len(sys.argv) > 1 else 'saida'
    os.makedirs(pasta, exist_ok=True)
    resultado = {'versao': 1, 'gerado_em': iso(AGORA), 'fontes': {}, 'alertas': [], 'inmet_bruto': None}
    ler_anterior(os.environ.get('ALERTAS_ANTERIOR', 'anterior/alertas.json'))
    for fid, fnome, fn in FONTES:
        t0 = time.time()
        try:
            alertas = fn()
            resultado['alertas'] += alertas
            resultado['fontes'][fid] = {'nome': fnome, 'ok': True, 'quantidade': len(alertas)}
            print(f'{fnome}: {len(alertas)} alerta(s) em {time.time() - t0:.1f}s')
        except Exception as e:
            # Fonte fora do ar: mantém o que ela tinha publicado e ainda vale
            antigos = manter_vigentes(fid, [])
            resultado['alertas'] += antigos
            resultado['fontes'][fid] = {'nome': fnome, 'ok': False, 'quantidade': len(antigos), 'erro': str(e)[:300]}
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
    resultado['alertas'] = sem_repetidos(resultado['alertas'])
    resultado['alertas'].sort(key=lambda a: -a['nivel'])
    # Cancelamentos dos últimos 3 dias, para um alerta cancelado não voltar pela memória
    limite = iso(AGORA - timedelta(days=3))
    canc = {k: v for k, v in ANTERIOR['cancelados'].items() if v >= limite}
    canc.update({c: iso(AGORA) for c in CANCELADOS if c not in canc})
    resultado['cancelados'] = canc
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
