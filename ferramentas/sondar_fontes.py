#!/usr/bin/env python3
"""Sonda temporária: lê páginas de avisos das Defesas Civis estaduais a partir do GitHub Actions."""
import gzip, html, re, sys, urllib.request
UA = 'WeatherCenter-coletor/1.0 (app de alertas sem fins comerciais)'
def get(u, t=30):
    req = urllib.request.Request(u, headers={'User-Agent': UA, 'Accept-Encoding': 'gzip'})
    with urllib.request.urlopen(req, timeout=t) as r:
        d = r.read()
        if r.headers.get('Content-Encoding') == 'gzip': d = gzip.decompress(d)
        return r.status, r.headers.get('Content-Type', ''), r.geturl(), d.decode('utf-8', 'replace')
def texto(h):
    h = re.sub(r'(?is)<(script|style|nav|header|footer)\b.*?</\1>', ' ', h)
    h = re.sub(r'(?i)<br\s*/?>|</(p|div|li|tr|h\d)>', '\n', h)
    h = html.unescape(re.sub(r'<[^>]+>', ' ', h))
    return re.sub(r'\n\s*\n+', '\n', re.sub(r'[ \t\xa0]+', ' ', h))
PAGINAS = sys.argv[1:]
for u in PAGINAS:
    print('=' * 20, u)
    try:
        s, ct, fim, h = get(u)
    except Exception as e:
        print('ERRO', e); continue
    print(s, ct, fim, len(h))
    if 'robots' in u or 'json' in ct:
        print(h[:3000]); continue
    t = texto(h)
    i = max(0, min([t.find(k) for k in ('Risco', 'RISCO', 'Alerta', 'ALERTA', 'Aviso') if t.find(k) >= 0] or [0]) - 300)
    print('TEXTO:', t[i:i + 5000])
    links = sorted(set(re.findall(r'(?:href|src)="([^"]+)"', h)))
    print('LINKS:', [l for l in links if re.search(r'(?i)alert|aviso|risco|boletim|upload|progn|\.pdf|\.jpg|\.png|json|api', l)][:80])
