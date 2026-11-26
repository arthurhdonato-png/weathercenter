# WeatherCenter

App de previsão do tempo, mapas e alertas para os 5.570 municípios do Brasil. Funciona no navegador e pode ser instalado no celular como app (PWA). Site: https://arthurhdonato-png.github.io/weathercenter/

## O que faz
- **Busca e localização**: qualquer município (lista oficial do IBGE) ou a localização atual do celular.
- **Agora**: temperatura, sensação, umidade, vento e rajadas, chuva, UV, visibilidade, pressão, ponto de orvalho e nuvens.
- **Próximas 24 horas**: gráfico e tabela com probabilidade e volume de chuva, temperatura, sensação, UV, vento, rajadas, umidade, visibilidade e pressão.
- **Próximos 7 dias**: os mesmos dados por dia (toque no dia para ver tudo), com nascer e pôr do sol.
- **Widgets**: chuva nas próximas 3 horas, UV, sol, lua, vento, qualidade do ar e conforto térmico.
- **Mapas**: temperatura, sensação, UV, vento (com setas), precipitação, umidade, visibilidade e pressão, com controle de horário para as próximas 24 h, e radar de chuva.
- **Alertas**: mapa do Brasil com todos os avisos ativos nas cores originais, lista filtrável por estado e situação de cada fonte.

## Fontes de dados (gratuitas, sem chave)
| Dado | Fonte |
|---|---|
| Previsão, mapas, qualidade do ar | Open-Meteo (CC BY 4.0, uso não comercial) |
| Alertas (ao vivo no navegador) | INMET (`apiprevmet3.inmet.gov.br/avisos/ativos`) |
| Alertas (pelo coletor automático) | Defesa Civil/IDAP (CAP) e Marinha/CHM (avisos de mau tempo) |
| Municípios e contornos | IBGE (API de localidades e de malhas) |
| Nome da cidade pela localização | BigDataCloud (reverse geocode client) |
| Radar | RainViewer |
| Mapa de fundo | OpenStreetMap / CARTO |

Fontes de alertas sem dados abertos hoje: Cemaden (o painel tem JSON, mas o robots.txt proíbe coleta automática), centros estaduais (Simepar, Epagri/Ciram, Funceme, APAC, Inea, CGE-SP, Alerta Rio), CPTEC/INPE, SGB/ANA (boletins em PDF) e institutos privados. O app mostra essa lista na aba Alertas.

## Coletor automático de alertas
Algumas fontes não podem ser lidas direto pelo navegador. O arquivo `coletor/coletar.py` (Python, sem nada para instalar) busca essas fontes, respeita o `robots.txt` de cada site, junta tudo num formato único e grava `alertas.json`.

- Roda sozinho no GitHub Actions (`.github/workflows/coletar-alertas.yml`) a cada 5 minutos, que é o menor intervalo que o GitHub permite. Em horários de pico o GitHub pode atrasar a execução.
- O resultado fica no ramo `dados` (só a última coleta, sem histórico) e o app lê de `https://raw.githubusercontent.com/arthurhdonato-png/weathercenter/dados/alertas.json`.
- Para rodar na mão: aba **Actions** > **Coletar alertas** > **Run workflow**.
- Para testar no computador: `python3 coletor/coletar.py saida` e veja `saida/alertas.json`.
- Para incluir uma fonte nova: escreva uma função `fonte_xxx()` em `coletar.py` que devolva a lista de alertas no formato comum e coloque-a na lista `FONTES`.

## Estrutura
Arquivos estáticos, sem etapa de build: `index.html`, `styles.css`, `js/*.js` (módulos), `sw.js` (offline), `vendor/leaflet` (mapas).

Para testar no computador: `python3 -m http.server` dentro da pasta e abrir http://localhost:8000.
