#!/usr/bin/env python3
"""Gera dados/cidades.json: nome, estado, coordenadas e população dos 5.570 municípios.

O mapa de alertas usa este arquivo para escrever o nome das cidades: as mais populosas
aparecem primeiro e as menores vão surgindo conforme o zoom aumenta.

Fontes:
- Coordenadas: github.com/kelvins/municipios-brasileiros (licença MIT, dados do IBGE)
- População: IBGE, Censo 2022 (API SIDRA, tabela 4709)

Roda pelo workflow "Gerar lista de cidades" (só precisa rodar de novo se o IBGE
atualizar a população). Uso: python3 coletor/gerar_cidades.py dados/cidades.json
"""
import csv
import io
import json
import os
import sys
import urllib.request

UA = 'WeatherCenter-coletor/1.0 (app de alertas sem fins comerciais)'
COORDS = 'https://raw.githubusercontent.com/kelvins/municipios-brasileiros/main/csv/municipios.csv'
POPULACAO = 'https://apisidra.ibge.gov.br/values/t/4709/n6/all/v/93/p/2022'
UF_POR_CODIGO = {
    '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO',
    '21': 'MA', '22': 'PI', '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL', '28': 'SE', '29': 'BA',
    '31': 'MG', '32': 'ES', '33': 'RJ', '35': 'SP', '41': 'PR', '42': 'SC', '43': 'RS',
    '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF',
}


def baixar(url, timeout=120):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def main():
    destino = sys.argv[1] if len(sys.argv) > 1 else 'dados/cidades.json'
    linhas = list(csv.DictReader(io.StringIO(baixar(COORDS).decode('utf-8'))))
    pop = {}
    try:
        for r in json.loads(baixar(POPULACAO))[1:]:  # a 1ª linha é o cabeçalho
            v = str(r.get('V', '')).strip()
            if v.isdigit():
                pop[str(r.get('D1C'))] = int(v)
    except Exception as e:  # sem população: ordena só por capital
        print(f'Aviso: população do IBGE indisponível ({e})')
    cidades = []
    for r in linhas:
        cod = r['codigo_ibge']
        cidades.append([
            r['nome'], UF_POR_CODIGO.get(r['codigo_uf'], ''), round(float(r['latitude']), 3),
            round(float(r['longitude']), 3), pop.get(cod, 0), int(r['capital'] == '1'),
        ])
    # Capitais primeiro, depois da maior para a menor população
    cidades.sort(key=lambda c: (-c[5], -c[4], c[0]))
    os.makedirs(os.path.dirname(destino) or '.', exist_ok=True)
    with open(destino, 'w', encoding='utf-8') as f:
        json.dump({'campos': ['nome', 'uf', 'lat', 'lon', 'populacao', 'capital'],
                   'fontes': 'Coordenadas: kelvins/municipios-brasileiros (MIT). População: IBGE, Censo 2022.',
                   'cidades': cidades}, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{destino}: {len(cidades)} cidades, {len(pop)} com população, {os.path.getsize(destino) // 1024} KB')
    print('Maiores:', ', '.join(c[0] for c in cidades[27:37]))
    if len(cidades) < 5000:
        sys.exit('Lista de cidades incompleta')


if __name__ == '__main__':
    main()
