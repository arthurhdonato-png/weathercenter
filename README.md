# WeatherCenter – primeira versão (PWA)

App de previsão do tempo e alertas para os 5.570 municípios do Brasil. Funciona no navegador e pode ser instalado no celular como app.

## O que faz
- Busca de qualquer município brasileiro (lista oficial do IBGE, sem acento, aceita "Cidade - UF").
- Tempo agora, próximas 24 horas e próximos 7 dias (Open-Meteo, gratuito para uso não comercial).
- Alertas ativos do INMET para a cidade escolhida, com cor por severidade, riscos e instruções.
- Lembra as cidades recentes e abre a última consultada; mostra a última previsão salva quando está sem internet.

## Como publicar (grátis)
São só arquivos estáticos. Basta enviar esta pasta para GitHub Pages, Netlify ou Cloudflare Pages. A instalação como app exige HTTPS, que esses serviços já oferecem.

Para testar no computador: `python3 -m http.server` dentro da pasta e abrir http://localhost:8000.

## Suposições
- Alertas: usa o JSON público https://apiprevmet3.inmet.gov.br/avisos/ativos. Se o navegador bloquear o acesso (CORS) ou o INMET estiver fora do ar, o app avisa e mostra o link para alertas2.inmet.gov.br. Plano B: um pequeno proxy ou o feed CAP/RSS do INMET.
- Coordenadas das cidades vêm da busca do Open-Meteo, cruzando nome e estado.
