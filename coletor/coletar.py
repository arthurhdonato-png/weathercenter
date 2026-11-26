#!/usr/bin/env python3
"""Coletor de alertas do WeatherCenter.

Busca os alertas de todas as fontes que não podem ser lidas direto pelo
navegador, junta tudo num formato único (parecido com o CAP) e grava
`<pasta>/alertas.json`. Roda sozinho no GitHub Actions a cada ~5 minutos
(veja .github/workflows/coletar-alertas.yml) e o app lê o arquivo gerado.

Usa só a biblioteca padrão do Python 3 (nada para instalar).
Uso: python3 coletor/coletar.py [pasta_de_saida]
"""
import gzip
import html
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

AMARELO, LARANJA, VERMELHO, AZUL = '#FFD400', '#FF8C00', '#E60000', '#5B9BD5'


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


def poligono_cap(texto, max_pontos=300):
    pontos = []
    for par in (texto or '').split():
        try:
            lat, lon = (float(x) for x in par.split(',')[:2])
        except ValueError:
            continue
        pontos.append([round(lat, 4), round(lon, 4)])
    if len(pontos) > max_pontos:  # simplifica para o arquivo não ficar enorme
        passo = len(pontos) / max_pontos
        pontos = [pontos[int(i * passo)] for i in range(max_pontos)] + [pontos[-1]]
    return pontos if len(pontos) >= 3 else None


SEVERIDADE_CAP = {
    'extreme': ('Extrema', 3, VERMELHO), 'severe': ('Severa', 2, LARANJA),
    'moderate': ('Moderada', 1, AMARELO), 'minor': ('Menor', 0, AZUL),
}


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
    sev, nivel, cor = SEVERIDADE_CAP.get(txt(info, 'severity').lower(), ('Aviso', 0, AZUL))
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
    riscos = linhas(descricao) if descricao and descricao.strip() != headline.strip() else []
    if headline and len(headline) > 140:
        riscos.insert(0, headline)
    web = txt(info, 'web')
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
    return ler_feed_cap('https://idapfile.mdr.gov.br/idap/api/rss/cap', 'defesa-civil', 'Defesa Civil',
                        'https://www.gov.br/mdr/pt-br/assuntos/protecao-e-defesa-civil/alertas-de-desastres-1')


RISCOS_CEMADEN = {
    'hidrol': ('Possibilidade de inundação, enxurrada ou alagamento.',),
    'movimento': ('Possibilidade de deslizamento de terra, queda de barreira ou desabamento.',),
}
NIVEL_CEMADEN = {'moderado': (1, AMARELO), 'alto': (2, LARANJA), 'muito alto': (3, VERMELHO)}


def fonte_cemaden():
    """Alertas de risco geo-hidrológico que o Cemaden envia às Defesas Civis (painel público)."""
    dados = json.loads(baixar('https://painelalertas.cemaden.gov.br/wsAlertas2', timeout=60))
    lista = dados.get('alertas', []) if isinstance(dados, dict) else dados
    alertas = []
    for r in lista or []:
        if str(r.get('status', 1)) != '1':
            continue
        evento = str(r.get('evento') or 'Alerta de risco')
        tipo = evento.split(' - ')[0].strip()
        nivel_txt = str(r.get('nivel') or (evento.split(' - ')[1] if ' - ' in evento else '')).strip()
        nivel, cor = NIVEL_CEMADEN.get(sem_acento(nivel_txt), (1, AMARELO))
        cod = str(r.get('codibge') or '')
        uf = str(r.get('uf') or UF_POR_CODIGO.get(cod[:2], '')).upper()
        municipio = str(r.get('municipio') or '').title()
        criado = r.get('datahoracriacao') or r.get('ult_atualizacao')
        inicio = None
        if criado:
            m = re.match(r'(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)', str(criado))
            if m:
                inicio = datetime.fromisoformat(f'{m[1]}T{m[2]}').replace(tzinfo=BRT)
        riscos = next((v for k, v in RISCOS_CEMADEN.items() if k in sem_acento(tipo)), ())
        alertas.append({
            'id': f"cemaden-{r.get('cod_alerta')}",
            'fonteId': 'cemaden',
            'fonte': 'Cemaden',
            'emissor': 'Cemaden (alerta técnico às Defesas Civis)',
            'titulo': f'{tipo} – risco {nivel_txt.lower()}' if nivel_txt else tipo,
            'evento': tipo,
            'severidade': f'Risco {nivel_txt.lower()}' if nivel_txt else 'Alerta',
            'nivel': nivel,
            'cor': cor,
            'inicio': iso(inicio),
            'fim': None,
            'riscos': list(riscos),
            'instrucoes': ['Siga as orientações da Defesa Civil do seu município (telefone 199).'],
            'geocodes': [cod] if len(cod) >= 6 else [],
            'estados': [uf] if uf in UFS else [],
            'poligonos': [],
            'areaTexto': f'{municipio} - {uf}' if municipio else '',
            'link': 'https://painelalertas.cemaden.gov.br/',
        })
    return alertas


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


def dia_hora(ref, dia, hhmm):
    """Converte 'DDHHMMZ' para data, usando o mês/ano da emissão."""
    d = ref
    if dia < ref.day - 15:  # virou o mês
        d = (ref.replace(day=28) + timedelta(days=4)).replace(day=1)
    try:
        return d.replace(day=dia, hour=int(hhmm[:2]), minute=int(hhmm[2:]), second=0, microsecond=0)
    except ValueError:
        return None


def fonte_marinha():
    """Avisos de mau tempo da Marinha (CHM) para o litoral e alto-mar. Página HTML, sem feed."""
    url = 'https://www.marinha.mil.br/chm/dados-do-smm-avisos-de-mau-tempo/avisos-de-mau-tempo'
    texto = html_para_texto(baixar(url, timeout=60).decode('utf-8', 'replace'))
    alertas, vistos = [], set()
    marcas = list(re.finditer(r'AVISO\s+NR\s+(\d+)\s*/\s*(\d{4})', texto))
    for i, m in enumerate(marcas):
        numero, ano = m[1], m[2]
        if numero in vistos:
            continue
        corpo = texto[m.end(): marcas[i + 1].start() if i + 1 < len(marcas) else m.end() + 3000]
        corpo = corpo.split('WARNING')[0]
        e = re.search(r'AVISO DE (.+?) EMITIDO\s+[ÀA]S\s+(\d{4})Z\s*-\s*\w+\s*-\s*(\d{1,2})/(\w{3})/(\d{4})', corpo)
        if not e:
            continue
        vistos.add(numero)
        tipo = re.sub(r'\s+', ' ', e[1]).strip()
        mes = MESES.get(e[4].upper()[:3], AGORA.month)
        emitido = datetime(int(e[5]), mes, int(e[3]), int(e[2][:2]), int(e[2][2:]), tzinfo=UTC)
        ini = re.search(r'A PARTIR DE\s+(\d{2})(\d{4})Z', corpo)
        ate = re.search(r'V[ÁA]LIDO AT[ÉE]\s+(\d{2})(\d{4})Z', corpo)
        inicio = dia_hora(emitido, int(ini[1]), ini[2]) if ini else emitido
        fim = dia_hora(emitido, int(ate[1]), ate[2]) if ate else emitido + timedelta(hours=48)
        if fim and fim < AGORA:
            continue
        if ate:  # o que vem depois de "VÁLIDO ATÉ" já é o título da próxima área
            corpo = corpo[:ate.end()]
        areas_achadas = RE_AREA.findall(corpo) or RE_AREA.findall(texto[:m.start()])[-1:]
        estados, regioes = [], []
        for a in areas_achadas:
            a = a.replace('OCEANICA', 'OCEÂNICA')
            desc, ufs = AREAS_MARINHA.get(a, ('', []))
            regioes.append(f'Área {a.title()}' + (f' ({desc})' if desc else ''))
            estados += [u for u in ufs if u not in estados]
        for uf in re.findall(r'/([A-Z]{2})\b', corpo):
            if uf in UFS and uf not in estados:
                estados.append(uf)
        t = sem_acento(tipo)
        nivel, cor = (3, VERMELHO) if re.search(r'tempestade|furacao|ciclone|violento', t) else \
            (2, LARANJA) if 'muito' in t or 'alto' in t else (1, AMARELO)
        detalhe = re.sub(r'\s+', ' ', corpo[e.end():]).strip()[:600]
        alertas.append({
            'id': f'marinha-{numero}-{ano}',
            'fonteId': 'marinha',
            'fonte': 'Marinha',
            'emissor': 'Centro de Hidrografia da Marinha',
            'titulo': f'Aviso de {tipo.lower()} (mar)',
            'evento': tipo.title(),
            'severidade': 'Aviso de mau tempo',
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
    return alertas


def fonte_inmet_bruto():
    """Cópia dos avisos do INMET, usada pelo app só quando o INMET não responde direto ao navegador."""
    dados = json.loads(baixar('https://apiprevmet3.inmet.gov.br/avisos/ativos', timeout=60))
    return dados


FONTES = [
    ('defesa-civil', 'Defesa Civil (IDAP)', fonte_defesa_civil),
    ('cemaden', 'Cemaden', fonte_cemaden),
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
    resultado['alertas'].sort(key=lambda a: -a['nivel'])
    caminho = os.path.join(pasta, 'alertas.json')
    with open(caminho, 'w', encoding='utf-8') as f:
        json.dump(resultado, f, ensure_ascii=False, separators=(',', ':'))
    print(f'Gravado {caminho}: {len(resultado["alertas"])} alertas, {os.path.getsize(caminho) // 1024} KB')
    if not any(f['ok'] for f in resultado['fontes'].values()):
        sys.exit(1)


if __name__ == '__main__':
    main()
