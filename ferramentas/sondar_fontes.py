#!/usr/bin/env python3
"""Sonda temporária: verifica, a partir do GitHub Actions, que fontes estaduais da Defesa Civil respondem."""
import json, re, sys, urllib.request, urllib.parse, gzip
UA = 'WeatherCenter-coletor/1.0 (app de alertas sem fins comerciais)'
def get(u, t=25):
    req = urllib.request.Request(u, headers={'User-Agent': UA, 'Accept-Encoding': 'gzip'})
    with urllib.request.urlopen(req, timeout=t) as r:
        d = r.read()
        if r.headers.get('Content-Encoding') == 'gzip': d = gzip.decompress(d)
        return r.status, r.headers.get('Content-Type', ''), r.geturl(), d
def tenta(u, mostrar=300, t=25):
    try:
        s, ct, fim, d = get(u, t)
        print(f'OK {s} {ct[:40]} {len(d)}B {u} -> {fim}')
        if mostrar: print('   ', repr(d[:mostrar].decode('utf-8', 'replace')))
        return d.decode('utf-8', 'replace')
    except Exception as e:
        print(f'ERRO {u}: {str(e)[:150]}')
        return ''
modo = sys.argv[1] if len(sys.argv) > 1 else 'tudo'
UFS = 'ac al ap am ba ce df es go ma mt ms mg pa pb pr pe pi rj rn rs ro rr sc sp se to'.split()
if modo in ('tudo', 'ufs'):
    for uf in UFS:
        for h in (f'https://www.defesacivil.{uf}.gov.br', f'https://defesacivil.{uf}.gov.br'):
            home = tenta(h + '/', 0, 15)
            if home:
                tenta(h + '/robots.txt', 400, 15)
                wp = tenta(h + '/wp-json/wp/v2/posts?per_page=3&_fields=id,date,link,title', 600, 20)
                links = sorted(set(re.findall(r'href="([^"]*(?:aviso|alerta|boletim|risco)[^"]*)"', home, re.I)))[:25]
                print('   links:', links)
                break
if modo in ('tudo', 'rs'):
    for u in ['https://clima.rs.gov.br/robots.txt', 'https://www.defesacivil.rs.gov.br/robots.txt', 'https://www.estado.rs.gov.br/robots.txt']:
        tenta(u, 500)
    h = tenta('https://clima.rs.gov.br/', 1500)
    for js in re.findall(r'(?:src|href)="([^"]+\.js[^"]*)"', h)[:15]:
        u = urllib.parse.urljoin('https://clima.rs.gov.br/', js)
        c = tenta(u, 0, 40)
        achados = sorted(set(re.findall(r'["\'`](https?://[^"\'`\s]{6,120}|/api[^"\'`\s]{0,100})["\'`]', c)))
        print('   urls em', js, achados[:80])
        for m in re.finditer(r'(?i)alert|aviso|defesa', c):
            pass
        for k in ('alerta', 'avisos', 'defesa', 'risco'):
            for m in list(re.finditer(k, c))[:5]:
                print(f'   ctx[{k}]', repr(c[max(0, m.start()-120): m.start()+160]))
    tenta('https://www.defesacivil.rs.gov.br/avisos-e-alertas', 800)
    d = tenta('https://www.defesacivil.rs.gov.br/inicial', 0)
    print('   links rs:', sorted(set(re.findall(r'href="([^"]+)"', d)))[:200])
if modo in ('tudo', 'idap'):
    x = tenta('https://idapfile.mdr.gov.br/idap/api/rss/cap', 1500, 120)
    datas = re.findall(r'<updated>([^<]+)', x)
    print('   entradas', x.count('<entry'), 'datas', datas[:3], datas[-3:])
    links = re.findall(r'<link[^>]+href="([^"]+)"', x)
    print('   links exemplo', links[:5])
    for u in ['https://idapfile.mdr.gov.br/idap/api/rss/cap?page=2', 'https://idapfile.mdr.gov.br/idap/api/', 'https://idapfile.mdr.gov.br/robots.txt']:
        tenta(u, 500, 90)
