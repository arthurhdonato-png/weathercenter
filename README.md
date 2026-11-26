# WeatherCenter

App de previsão do tempo, mapas e alertas para os 5.570 municípios do Brasil. Funciona no navegador e pode ser instalado no celular como app (PWA). Site: https://arthurhdonato-png.github.io/weathercenter/

## O que faz
- **Busca e localização**: qualquer município (lista oficial do IBGE) ou a localização atual do celular.
- **Previsão por consenso**: cada valor (agora, por hora e por dia) junta 11 modelos globais (ECMWF IFS e AIFS, Met Office, ICON/DWD, GFS/NOAA, ARPEGE/Météo-France, GEM/Canadá, JMA/Japão, KMA/Coreia, BoM/Austrália e CMA/China, todos pela Open-Meteo), a MET Norway e as máximas e mínimas do INMET. Usa mediana ponderada (temperatura, umidade, vento, pressão), média sem extremos (chuva) e mostra quais fontes entraram, a faixa entre elas e a concordância. Código em `js/consenso.js`.
- **Alertas em primeiro lugar**: quando há aviso oficial para a cidade (ou no estado), uma faixa na cor do alerta aparece no topo da previsão, antes de tudo.
- **Resumo**: um quadro curto com o tempo agora, as próximas horas, amanhã e os pontos de atenção (alertas, UV, rajadas, calor, frio, ar seco, chuva forte).
- **Agora**: temperatura, sensação, condição, máxima, mínima, chuva, vento, umidade e UV.
- **Por hora**: faixa rolável das próximas 24 horas com nascer e pôr do sol, mais gráfico e tabela completa.
- **10 dias**: barras de mínima e máxima (toque no dia para ver tudo, inclusive a opinião das fontes).
- **Quadros**: chuva nas próximas 3 horas, sensação, UV, vento, chuva do dia, sol, umidade, visibilidade, pressão, qualidade do ar e lua.
- **Mapas**: mapa de fundo com ruas, limites de estados e municípios e nomes em português; camadas suaves de temperatura, chuva, vento (partículas animadas), nuvens, sensação, umidade, UV, pressão e visibilidade, animação contínua das próximas 24 h e radar de chuva animado (últimos 80 min).
- **Alertas**: mapa do Brasil com todos os avisos ativos nas cores originais, lista filtrável por estado e situação de cada fonte.

## Fontes de dados (gratuitas, sem chave)
| Dado | Fonte |
|---|---|
| Previsão (consenso) | Open-Meteo com 11 modelos (CC BY 4.0, uso não comercial), MET Norway (CC BY 4.0) e INMET (máx./mín.) |
| Mapas, qualidade do ar | Open-Meteo |
| Alertas (ao vivo no navegador) | INMET (`apiprevmet3.inmet.gov.br/avisos/ativos`) |
| Alertas (pelo coletor automático) | Defesa Civil/IDAP (CAP) e Marinha/CHM (avisos de mau tempo) |
| Municípios e contornos | IBGE (API de localidades e de malhas) |
| Nome da cidade pela localização | BigDataCloud (reverse geocode client) |
| Radar | RainViewer |
| Mapa de fundo | OpenFreeMap (mapas vetoriais do OpenStreetMap, desenhados pela MapLibre GL) |

CPTEC/INPE tem previsão por cidade, mas o serviço não permite leitura direta por sites (sem CORS), por isso não entra no consenso.

Fontes de alertas sem dados abertos hoje: Cemaden (o painel tem JSON, mas o robots.txt proíbe coleta automática), centros estaduais (Simepar, Epagri/Ciram, Funceme, APAC, Inea, CGE-SP, Alerta Rio), CPTEC/INPE, SGB/ANA (boletins em PDF) e institutos privados. O app mostra essa lista na aba Alertas.

## Coletor automático de alertas
Algumas fontes não podem ser lidas direto pelo navegador. O arquivo `coletor/coletar.py` (Python, sem nada para instalar) busca essas fontes, respeita o `robots.txt` de cada site, junta tudo num formato único e grava `alertas.json`.

- Roda sozinho no GitHub Actions (`.github/workflows/coletar-alertas.yml`) a cada 5 minutos, que é o menor intervalo que o GitHub permite. Em horários de pico o GitHub pode atrasar a execução.
- O resultado fica no ramo `dados` (só a última coleta, sem histórico) e o app lê de `https://raw.githubusercontent.com/arthurhdonato-png/weathercenter/dados/alertas.json`.
- Para rodar na mão: aba **Actions** > **Coletar alertas** > **Run workflow**.
- Para testar no computador: `python3 coletor/coletar.py saida` e veja `saida/alertas.json`.
- Para incluir uma fonte nova: escreva uma função `fonte_xxx()` em `coletar.py` que devolva a lista de alertas no formato comum e coloque-a na lista `FONTES`.

## Estrutura
Arquivos estáticos, sem etapa de build: `index.html`, `styles.css` (visual), `js/*.js` (módulos), `sw.js` (offline), `vendor/leaflet` e `vendor/maplibre` (mapas), `vendor/fontes` (fonte única do app: Noto Sans, licença OFL).

Para testar no computador: `python3 -m http.server` dentro da pasta e abrir http://localhost:8000.
