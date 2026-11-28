#!/usr/bin/env python3
"""Sonda temporária: baixa os posts de avisos da Defesa Civil RS (texto completo + imagens) para análise."""
import gzip, html, os, re, urllib.request
UA = 'WeatherCenter-coletor/1.0 (app de alertas sem fins comerciais)'
B = 'https://www.defesacivil.rs.gov.br'
def get(u):
    req = urllib.request.Request(u, headers={'User-Agent': UA, 'Accept-Encoding': 'gzip'})
    with urllib.request.urlopen(req, timeout=40) as r:
        d = r.read()
        return gzip.decompress(d) if r.headers.get('Content-Encoding') == 'gzip' else d
os.makedirs('sonda', exist_ok=True)
lista = get(B + '/avisos-e-alertas-6ad7aa4f35d41').decode('utf-8', 'replace')
open('sonda/lista.html', 'w').write(lista)
posts = []
for h in re.findall(r'href="(/[a-z0-9-]+-[0-9a-f]{12,13}(?:-[0-9a-f]{12,13})?)"', lista):
    if h not in posts and 'avisos-e-alertas' not in h: posts.append(h)
for i, p in enumerate(posts[:12]):
    h = get(B + p).decode('utf-8', 'replace')
    open(f'sonda/post{i}.html', 'w').write(h)
    for img in sorted(set(re.findall(r'/upload/recortes/[0-9]+/[0-9_]+_(?:GD|GDO)\.(?:png|jpe?g)', h))):
        nome = 'sonda/' + img.rsplit('/', 1)[1]
        if not os.path.exists(nome):
            open(nome, 'wb').write(get(B + img))
    print(i, p)
for m in re.findall(r'href="([^"]*(?:rss|RSS|feed)[^"]*)"', lista): print('RSS?', m)
