# Avisos no celular (notificações push)

Quem ativa os avisos para uma ou mais cidades recebe uma notificação quando surge um **alerta novo** (ou quando um alerta fica **mais grave**), mesmo com o app fechado. Vale para todas as fontes: INMET, Defesa Civil e os alertas próprios do WeatherCenter. Avisos só para o mar (Marinha) ficam de fora.

## Como funciona (tudo grátis, sem servidor pago)
1. No app, a pessoa toca em **Ativar avisos**. O navegador cria uma "inscrição" (Web Push, padrão aberto: Google no Android/Chrome, Apple no iPhone, Mozilla, Microsoft).
2. A inscrição vai para um banco **Supabase** (plano grátis). O app só consegue chamar a função `wc_inscrever`, que valida tudo; ninguém de fora consegue ler a lista.
3. A cada ~5 minutos o GitHub Actions coleta os alertas e roda `notificador/enviar.mjs`, que compara com os já avisados (tabela `wc_enviados`) e envia as notificações novas, assinadas com a chave VAPID.

## Limitações
- **Atraso**: a verificação roda a cada 5 minutos, e o GitHub às vezes atrasa (10 a 20 min em horários de pico). Some o tempo que a própria fonte leva para publicar.
- **iPhone/iPad**: só funciona com iOS 16.4 ou mais novo **e** com o app adicionado à tela de início (Safari > Compartilhar > Adicionar à Tela de Início). Pelo Safari comum não funciona; é uma regra da Apple.
- **Android**: funciona no Chrome (e Edge, Firefox, Samsung Internet), instalado ou não. Economia de bateria agressiva de alguns aparelhos pode atrasar.
- O Supabase grátis pausa projetos parados por 7 dias, mas o envio a cada 5 minutos mantém o projeto ativo.
- O aviso não substitui os alertas oficiais (SMS 40199 da Defesa Civil, 199, 193).

## Configuração (uma vez só)
Veja o passo a passo completo na descrição do pull request que criou esta função. Resumo:

| Onde | Nome | Valor |
|---|---|---|
| GitHub > Settings > Secrets and variables > Actions > **Secrets** | `VAPID_PRIVATE_KEY` | gerada em `ferramentas/chave-push.html` |
| idem, **Secrets** | `SUPABASE_SECRET_KEY` | Supabase > Project Settings > API Keys > Secret key |
| idem, **Variables** | `SUPABASE_URL` | `https://<projeto>.supabase.co` |
| idem, **Variables** | `SUPABASE_PUBLISHABLE_KEY` | Supabase > Project Settings > API Keys > Publishable key |

No Supabase, rode `notificador/supabase.sql` no **SQL Editor**.

## Teste
- No app: aba **Alertas** > **Avisos no celular** > **Testar notificação** (mostra uma notificação local).
- Do servidor até o aparelho: copie o **código deste aparelho** que aparece no mesmo cartão, vá em Actions > **Coletar alertas** > **Run workflow**, cole o código em "teste_codigo" e rode. Em 2 a 3 minutos chega "✅ Teste do WeatherCenter".
- Testes automáticos (sem internet): `node notificador/testes/webpush.test.mjs` e `node notificador/testes/ponta-a-ponta.test.mjs`.
