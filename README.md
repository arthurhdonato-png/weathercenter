# WeatherCenter

App de previsão do tempo, mapas e alertas para os 5.570 municípios do Brasil. Funciona no navegador e pode ser instalado no celular como app (PWA). Site: https://arthurhdonato-png.github.io/weathercenter/

## O que faz
- **Busca e localização**: qualquer município (lista oficial do IBGE) ou a localização atual do celular.
- **Previsão por consenso**: cada valor (agora, por hora e por dia) junta 11 modelos globais (ECMWF IFS e AIFS, Met Office, ICON/DWD, GFS/NOAA, ARPEGE/Météo-France, GEM/Canadá, JMA/Japão, KMA/Coreia, BoM/Austrália e CMA/China, todos pela Open-Meteo), a MET Norway e as máximas e mínimas do INMET. Usa mediana ponderada (temperatura, umidade, vento, pressão), média sem extremos (chuva) e mostra quais fontes entraram, a faixa entre elas e a concordância. Código em `js/consenso.js`.
- **Uma página só**: previsão, mapas e alertas ficam na mesma página, um abaixo do outro (os links do topo só levam a cada parte).
- **Alertas em primeiro lugar**: no topo da previsão, uma faixa na cor do alerta com a linha do tempo dos alertas da cidade; sem alerta, uma faixa verde dizendo que não há nenhum alerta para a cidade e quais fontes foram consultadas. Os alertas são conferidos de novo a cada 5 minutos com a página aberta.
- **Resumo**: um quadro curto com o tempo agora, as próximas horas, amanhã e os pontos de atenção (alertas, UV, rajadas, calor, frio, ar seco, chuva forte).
- **Agora**: temperatura, sensação, condição, máxima, mínima, chuva, vento, umidade e UV.
- **Por hora**: faixa rolável das próximas 24 horas com nascer e pôr do sol, mais gráfico e tabela completa.
- **Gráficos hora a hora** (`js/graficos.js`): ao tocar num quadro (ou nos atalhos), abre um gráfico interativo de hoje, de cada um dos próximos dias ou dos 10 dias juntos: chuva e chance de chuva, temperatura e sensação, vento e rajadas (com a direção), nuvens/neblina/visibilidade, umidade e ponto de orvalho, pressão, UV e qualidade do ar.
- **10 dias**: barras de mínima e máxima (toque no dia para ver tudo, inclusive a opinião das fontes).
- **Quadros**: chuva nas próximas 3 horas, sensação, UV, vento, chuva do dia, sol, umidade, visibilidade, pressão, qualidade do ar e lua.
- **Agora no seu local**: cena animada (`js/cena.js`) com a casa do local escolhido e o sol, a lua, as nuvens, a neblina, a chuva ou os raios de agora; se a chuva ainda não chegou, o radar do RainViewer mostra a mais próxima ao lado da casa, a uma distância proporcional (até 150 km), e se ela está se aproximando.
- **Mapas**: só o Brasil (os outros países ficam cobertos; `js/mapaControles.js`), com ruas, limites de estados e municípios e nomes em português; camadas suaves de temperatura, chuva, vento (partículas animadas), nuvens, sensação, umidade, UV, pressão e visibilidade, animação contínua das próximas 24 h e radar de chuva animado (últimos 80 min). No computador, a rodinha do mouse sobre o mapa dá zoom; no celular, um dedo rola a página e dois dedos movem o mapa; botão de tela cheia. Contornos do IBGE em qualidade máxima (`ferramentas/contornos.py`), com folga para nenhuma parte do território ficar coberta.
- **Alertas**: mapa do Brasil com todos os avisos ativos nas cores originais, filtro por estado (o mapa pinta só a parte do alerta dentro do estado escolhido) e por severidade (uma, várias ou todas), linha do tempo com uma barra por alerta (`js/linhaTempoAlertas.js`), caixa com todos os alertas vigentes e situação de cada fonte.
- **Alertas próprios do WeatherCenter** (automáticos, não oficiais): tempestades detectadas por raios de satélite e radar com trajetória e horário de chegada nas cidades, vento/granizo/tornado observados em aeroportos e previsão de 48 h de chuva, vento, temporais e ambiente para tornado pelo consenso GFS + ECMWF. Classificados como moderado, severo ou extremo, nas mesmas cores do INMET. Critérios e limitações em [`detector/CRITERIOS.md`](detector/CRITERIOS.md).

## Fontes de dados (gratuitas, sem chave)
| Dado | Fonte |
|---|---|
| Previsão (consenso) | Open-Meteo com 11 modelos (CC BY 4.0, uso não comercial), MET Norway (CC BY 4.0) e INMET (máx./mín.) |
| Mapas, qualidade do ar | Open-Meteo |
| Alertas (ao vivo no navegador) | INMET (`apiprevmet3.inmet.gov.br/avisos/ativos`) |
| Alertas (pelo coletor automático) | Defesa Civil/IDAP (CAP) e Marinha/CHM (avisos de mau tempo) |
| Alertas próprios (WeatherCenter) | Raios do satélite GOES-19 (GLM), radar RainViewer, METAR dos aeroportos, modelos GFS (NOAA) e IFS (ECMWF) |
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

## Detector WeatherCenter (alertas próprios)
Código em `detector/` (Python com numpy, scipy, eccodes, netCDF4 e pillow, instalados pelo GitHub Actions).
- **A cada ~5 min**, junto com o coletor: raios, radar e aeroportos (`python3 detector/detectar.py agora saida anterior`). Os alertas entram no mesmo `alertas.json` com `fonteId: "weathercenter"` e também em `weathercenter.json` (com as tempestades acompanhadas). Para não depender do agendamento do GitHub, que atrasa ou pula execuções, cada coleta dispara a seguinte; para desligar, crie a variável `ENCADEAR` com valor `nao` em Settings > Secrets and variables > Actions > Variables.
- **A cada 30 min** (workflow **Prever eventos**): verifica se saiu rodada nova do GFS ou do ECMWF e recalcula a previsão de 48 h, publicada no ramo `dados-modelos`.
- Testes com casos reais: `detector/testes/` (resultados em `detector/testes/RESULTADOS.md`).
## Avisos no celular
Notificações push dos alertas novos para as cidades que cada pessoa escolher, mesmo com o app fechado. Enviadas pelo mesmo GitHub Actions, com as inscrições guardadas no Supabase (grátis). Configuração e limitações: [`notificador/LEIAME.md`](notificador/LEIAME.md).

## Estrutura
Arquivos estáticos, sem etapa de build: `index.html`, `styles.css` (visual), `js/*.js` (módulos), `sw.js` (offline), `vendor/leaflet` e `vendor/maplibre` (mapas), `vendor/polygon-clipping` (recorte dos alertas por estado, licença MIT), `vendor/fontes` (fonte única do app: Noto Sans, licença OFL), `dados/contorno-*.json` (cópia local dos contornos do IBGE).

Para testar no computador: `python3 -m http.server` dentro da pasta e abrir http://localhost:8000.
