// Envia notificações push dos alertas NOVOS para quem escolheu receber avisos de cada cidade.
// Roda no GitHub Actions logo depois da coleta (a cada ~5 min). Uso: node notificador/enviar.mjs <pasta-da-coleta>
//
// Configuração (Settings > Secrets and variables > Actions do repositório):
//   Secrets:   VAPID_PRIVATE_KEY, SUPABASE_SECRET_KEY
//   Variables: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY
// Sem isso o script só avisa no log e termina sem erro.
// Também grava <pasta>/push.json com os dados PÚBLICOS que o app precisa para se inscrever.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chavesVapid, enviarPush } from './webpush.mjs';
import { carregarAlertas, alertaAfetaCidade } from './alertas.mjs';

const pasta = process.argv[2] || 'saida';
const env = process.env;
const SIMULAR = env.SIMULAR === '1';
const [dono, repo] = String(env.GITHUB_REPOSITORY || 'arthurhdonato-png/weathercenter').split('/');
const SITE = env.SITE_URL || `https://${dono.toLowerCase()}.github.io/${repo}/`;
const MAX_POR_APARELHO = 4; // por rodada; acima disso vai um resumo
const resumo = [];
const log = (...a) => { console.log(...a); resumo.push(a.join(' ')); };

/* ---------- Supabase (API REST) ---------- */
const SUPA = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const cabSupa = (chave) => ({ apikey: chave, ...(chave.startsWith('eyJ') ? { Authorization: `Bearer ${chave}` } : {}) });
async function supa(caminho, { method = 'GET', corpo, headers = {} } = {}) {
  const r = await fetch(`${SUPA}/rest/v1/${caminho}`, {
    method,
    headers: { ...cabSupa(env.SUPABASE_SECRET_KEY.trim()), 'Content-Type': 'application/json', ...headers },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (!r.ok) throw new Error(`Supabase ${method} ${caminho.split('?')[0]}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 || method !== 'GET' ? null : r.json();
}
async function todos(tabela, campos) {
  const res = [];
  for (let de = 0; ; de += 1000) {
    const parte = await supa(`${tabela}?select=${campos}&order=${campos.split(',')[0]}`, { headers: { Range: `${de}-${de + 999}` } });
    res.push(...parte);
    if (parte.length < 1000) return res;
  }
}

/* ---------- Texto da notificação ---------- */
const SINAL = { 1: '🟡', 2: '🟠', 3: '🔴' };
const fmtHora = (d) => (d ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d).replace(',', '') : '');
const corta = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function mensagem(a, cidades, agravado) {
  const nomes = cidades.map((c) => c.nome).filter(Boolean);
  const onde = nomes.length > 2 ? `${nomes.slice(0, 2).join(', ')} e mais ${nomes.length - 2}` : nomes.join(' e ');
  const risco = (a.riscos || []).map((r) => String(r).replace(/^Defesa Civil:\s*/i, '').trim()).find((r) => r.length > 10) || '';
  // Alertas automáticos do WeatherCenter com trajetória: horário estimado de chegada na cidade
  const chegada = a.detalhes?.chegadaMin;
  const min = chegada ? cidades.map((c) => chegada[String(c.id)]).find((v) => v != null) : null;
  const quando = min == null ? '' : min === 0 ? 'chegando agora' : `chegada em ~${min} min`;
  const linhas = [
    [onde, a.severidade, quando || (a.fim ? `até ${fmtHora(a.fim)}` : '')].filter(Boolean).join(' · '),
    risco && corta(risco, 180),
    a.oficial === false ? 'Fonte: WeatherCenter (automático, não oficial)' : `Fonte: ${a.fonte || 'WeatherCenter'}`,
  ].filter(Boolean);
  const titulo = `${SINAL[a.nivel] || '⚠️'} ${agravado ? 'Alerta agravado: ' : ''}${a.titulo || a.evento || 'Alerta'}`;
  const cidade = cidades.find((c) => c.id);
  return {
    titulo: corta(titulo, 90),
    corpo: linhas.join('\n'),
    tag: `wc-${a.id}`.slice(0, 120),
    nivel: a.nivel,
    url: `${SITE}${cidade ? `?cidade=${cidade.id}` : ''}#previsao`,
  };
}

// Código curto que o app mostra para o aparelho (usado no envio de teste manual)
const codigoAparelho = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 6).toUpperCase();

/* ---------- Envio com várias conexões ao mesmo tempo ---------- */
async function emParalelo(itens, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, async () => { while (i < itens.length) await fn(itens[i++]); }));
}

function gravarResumo() {
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `### Notificações\n\n${resumo.map((l) => `- ${l}`).join('\n')}\n`);
}

async function principal() {
  const alertas = carregarAlertas(pasta);
  const pronto = env.VAPID_PRIVATE_KEY && SUPA && env.SUPABASE_SECRET_KEY && env.SUPABASE_PUBLISHABLE_KEY;
  if (!pronto) {
    log(`Notificações ainda não configuradas (faltam chaves no GitHub). ${alertas.length} alertas em terra lidos.`);
    return;
  }
  const vapid = chavesVapid(env.VAPID_PRIVATE_KEY.trim());
  // Dados públicos para o app (vão para o ramo "dados" junto com os alertas)
  fs.writeFileSync(path.join(pasta, 'push.json'), JSON.stringify({
    versao: 1, vapidPublicKey: vapid.publica, supabaseUrl: SUPA, supabaseKey: env.SUPABASE_PUBLISHABLE_KEY.trim(),
  }));
  if (SIMULAR) { log(`Simulação: ${alertas.length} alertas em terra; nada enviado.`); return; }

  const contato = SITE;
  const enviados = new Set((await todos('wc_enviados', 'chave')).map((r) => r.chave));
  const chave = (a) => `${a.id}#${a.nivel}`;
  const novos = alertas.filter((a) => !enviados.has(chave(a)));
  const primeiraVez = enviados.size === 0;

  const inscricoes = await todos('wc_inscricoes', 'endpoint,p256dh,auth,cidades,nivel_min');
  log(`${alertas.length} alertas ativos em terra, ${novos.length} novos, ${inscricoes.length} aparelhos inscritos.`);

  // Fila: para cada aparelho, os alertas novos que atingem alguma das cidades dele
  const fila = [];
  const testeCodigo = String(env.TESTE_CODIGO || '').trim().toUpperCase();
  for (const ins of inscricoes) {
    const meus = [];
    if (!primeiraVez) {
      for (const a of novos) {
        if (a.nivel < (ins.nivel_min || 1)) continue;
        const cidades = (ins.cidades || []).filter((c) => alertaAfetaCidade(a, c));
        if (!cidades.length) continue;
        const agravado = [...enviados].some((k) => k.startsWith(`${a.id}#`) && Number(k.split('#').pop()) < a.nivel);
        meus.push(mensagem(a, cidades, agravado));
      }
    }
    meus.sort((x, y) => y.nivel - x.nivel);
    if (meus.length > MAX_POR_APARELHO) {
      const resto = meus.splice(MAX_POR_APARELHO - 1);
      meus.push({ titulo: `⚠️ Mais ${resto.length} alertas novos`, corpo: 'Abra o WeatherCenter para ver todos os alertas das suas cidades.\nFonte: WeatherCenter', tag: 'wc-resumo', nivel: resto[0].nivel, url: `${SITE}#alertas` });
    }
    if (testeCodigo && codigoAparelho(ins.endpoint) === testeCodigo) {
      meus.push({ titulo: '✅ Teste do WeatherCenter', corpo: 'As notificações estão funcionando neste aparelho.\nFonte: WeatherCenter', tag: 'wc-teste', nivel: 1, url: SITE });
    }
    for (const m of meus) fila.push({ ins, m });
  }
  if (testeCodigo && !inscricoes.some((i) => codigoAparelho(i.endpoint) === testeCodigo)) log(`Teste: nenhum aparelho com o código ${testeCodigo}.`);

  let ok = 0, falhas = 0;
  const expiradas = new Set();
  const erros = {};
  await emParalelo(fila, 20, async ({ ins, m }) => {
    if (expiradas.has(ins.endpoint)) return;
    const r = await enviarPush(ins, m, vapid, contato, { urgencia: m.nivel >= 2 ? 'high' : 'normal' });
    if (r.ok) ok++;
    else {
      falhas++;
      if (r.expirada) expiradas.add(ins.endpoint);
      erros[r.status] = (erros[r.status] || 0) + 1;
      if (Object.values(erros).reduce((s, v) => s + v, 0) <= 3) console.warn('falha no envio', r.status, r.detalhe);
    }
  });
  if (fila.length) log(`Notificações enviadas: ${ok}; falhas: ${falhas}${falhas ? ` (${Object.entries(erros).map(([s, n]) => `HTTP ${s}: ${n}`).join(', ')})` : ''}.`);

  // Aparelhos que desinstalaram o app ou bloquearam as notificações: sai da lista
  for (const e of expiradas) await supa(`wc_inscricoes?endpoint=eq.${encodeURIComponent(e)}`, { method: 'DELETE' });
  if (expiradas.size) log(`${expiradas.size} inscrições expiradas removidas.`);

  // Marca os alertas como avisados (na 1ª vez só marca, para não disparar alertas antigos)
  if (novos.length) {
    await supa('wc_enviados?on_conflict=chave', { method: 'POST', corpo: novos.map((a) => ({ chave: chave(a) })), headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } });
  }
  if (primeiraVez) log('Primeira execução: alertas atuais marcados como já vistos (os próximos novos serão avisados).');
  const limite = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString();
  await supa(`wc_enviados?enviado_em=lt.${limite}`, { method: 'DELETE' });
}

principal()
  .catch((e) => { log(`Erro nas notificações: ${e.message}`); process.exitCode = 1; })
  .finally(gravarResumo);
