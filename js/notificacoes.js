// Notificações no celular: a pessoa escolhe cidades e recebe um aviso quando surge alerta novo,
// mesmo com o app fechado (Web Push). O envio é feito pelo GitHub Actions (notificador/enviar.mjs);
// aqui o app só pede a permissão, cria a inscrição e a guarda no Supabase (só via função validada).
import { $, esc, store } from './util.js';
import { API } from './dados.js';

const CONFIG_URL = API.coletor.replace('alertas.json', 'push.json');
const CHAVE = 'wc:notif';
const MAX_CIDADES = 10;
const NIVEIS = [
  { v: 1, t: 'Todos os alertas (amarelo, laranja, vermelho e roxo)' },
  { v: 2, t: 'Só risco alto ou maior (laranja, vermelho e roxo)' },
  { v: 3, t: 'Só risco muito alto ou extremo (vermelho e roxo)' },
];

const estado = () => ({ cidades: [], nivelMin: 1, ...store.get(CHAVE, {}) });
const salvar = (e) => store.set(CHAVE, e);

const suporta = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const ehIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const instalado = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

let configPromessa = null;
function config() {
  if (!configPromessa) {
    configPromessa = fetch(`${CONFIG_URL}?v=${Math.floor(Date.now() / 600000)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => (c?.vapidPublicKey && c.supabaseUrl && c.supabaseKey ? c : null))
      .catch(() => null);
  }
  return configPromessa;
}

const deB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const paraB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function rpc(cfg, funcao, corpo) {
  const h = { 'Content-Type': 'application/json', apikey: cfg.supabaseKey };
  if (cfg.supabaseKey.startsWith('eyJ')) h.Authorization = `Bearer ${cfg.supabaseKey}`;
  const r = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${funcao}`, { method: 'POST', headers: h, body: JSON.stringify(corpo) });
  if (!r.ok) throw new Error(`Não foi possível salvar a inscrição (HTTP ${r.status}).`);
}

// Inscrição deste aparelho no serviço de push do navegador (Google, Apple, Mozilla ou Microsoft)
async function inscricaoPush(cfg) {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const chave = deB64(cfg.vapidPublicKey);
  const atual = sub?.options?.applicationServerKey;
  if (sub && atual && paraB64(atual) !== paraB64(chave)) { await sub.unsubscribe(); sub = null; } // chave do site mudou
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chave });
  return sub;
}

// O service worker também precisa saber das cidades (para refazer a inscrição sozinho se o navegador trocá-la)
async function guardarParaServiceWorker(e, cfg) {
  try {
    const c = await caches.open('wc-notif');
    await c.put('estado', new Response(JSON.stringify({ cidades: e.cidades, nivelMin: e.nivelMin, cfg })));
  } catch { /* ok */ }
}

async function enviarInscricao(e) {
  const cfg = await config();
  if (!cfg) throw new Error('As notificações ainda não foram ativadas no servidor do WeatherCenter.');
  const sub = await inscricaoPush(cfg);
  const j = sub.toJSON();
  await rpc(cfg, 'wc_inscrever', {
    p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth,
    p_cidades: e.cidades.map(({ id, nome, uf, lat, lon }) => ({ id: id ? String(id) : null, nome, uf, lat: +lat, lon: +lon })),
    p_nivel_min: e.nivelMin,
  });
  await guardarParaServiceWorker(e, cfg);
  store.set('wc:notifSinc', { t: Date.now(), endpoint: j.endpoint });
  return sub;
}

async function cancelarTudo() {
  const cfg = await config();
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub && cfg) await rpc(cfg, 'wc_cancelar', { p_endpoint: sub.endpoint }).catch(() => {});
  if (sub) await sub.unsubscribe().catch(() => {});
  try { await caches.delete('wc-notif'); } catch { /* ok */ }
}

const mesmaCidade = (a, b) => (a.id && b.id ? String(a.id) === String(b.id) : a.nome === b.nome && a.uf === b.uf);
const nomeCidade = (c) => `${c.nome}${c.uf ? `/${c.uf}` : ''}`;

/* ======================= Ações ======================= */
let cidadeAberta = null;
let ocupado = false;
let mensagem = '';

// Precisa ser chamada direto do clique (o iPhone só pede permissão a partir de um toque)
async function pedirPermissao() {
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') throw new Error(textoBloqueado());
  const r = await Notification.requestPermission();
  if (r !== 'granted') throw new Error(r === 'denied' ? textoBloqueado() : 'Permissão não concedida. Toque de novo para tentar.');
  return true;
}
const textoBloqueado = () => (ehIOS()
  ? 'As notificações estão bloqueadas. Libere em Ajustes > Notificações > WeatherCenter.'
  : 'As notificações estão bloqueadas para este site. Libere no cadeado ao lado do endereço (ou nas configurações do navegador) e tente de novo.');

async function executar(acao) {
  if (ocupado) return;
  ocupado = true; mensagem = ''; render();
  try { mensagem = (await acao()) || ''; } catch (err) { console.warn(err); mensagem = `⚠️ ${err.message}`; }
  ocupado = false; render();
}

function adicionarCidade(c) {
  return executar(async () => {
    await pedirPermissao();
    const e = estado();
    if (!e.cidades.some((x) => mesmaCidade(x, c))) {
      if (e.cidades.length >= MAX_CIDADES) throw new Error(`Limite de ${MAX_CIDADES} cidades. Remova uma para adicionar outra.`);
      e.cidades.push({ id: c.id ? String(c.id) : null, nome: c.nome, uf: c.uf || '', lat: c.lat, lon: c.lon });
    }
    await enviarInscricao(e);
    salvar(e);
    return `Pronto! Você vai receber os alertas novos de ${nomeCidade(c)} neste aparelho.`;
  });
}

function removerCidade(i) {
  return executar(async () => {
    const e = estado();
    const [c] = e.cidades.splice(i, 1);
    if (e.cidades.length) await enviarInscricao(e); else await cancelarTudo();
    salvar(e);
    return c ? `${nomeCidade(c)} removida dos avisos.` : '';
  });
}

function mudarNivel(v) {
  return executar(async () => {
    const e = estado();
    e.nivelMin = v;
    if (e.cidades.length) await enviarInscricao(e);
    salvar(e);
    return 'Preferência salva.';
  });
}

function testar() {
  return executar(async () => {
    await pedirPermissao();
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification('✅ Teste do WeatherCenter', {
      body: 'É assim que os alertas vão aparecer neste aparelho.\nFonte: WeatherCenter',
      icon: 'icons/icon-192.png', tag: 'wc-teste-local', data: { url: './' },
    });
    return 'Notificação de teste mostrada. Se não apareceu, verifique o modo "Não perturbe" e as configurações de notificação.';
  });
}

async function codigoAparelho() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return '';
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub.endpoint));
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 6).toUpperCase();
  } catch { return ''; }
}

/* ======================= Tela ======================= */
// Por que não dá para ativar aqui (ou '' se dá)
function impedimento(cfg) {
  if (ehIOS() && !instalado()) return 'ios';
  if (!suporta()) return 'sem-suporte';
  if (!cfg) return 'sem-config';
  return '';
}

const AJUDA_IOS = `<p>No iPhone, os avisos só funcionam com o app na tela de início (iOS 16.4 ou mais novo):</p>
  <ol class="notif-passos"><li>Abra este site no <strong>Safari</strong>.</li><li>Toque em <strong>Compartilhar</strong> (quadrado com a seta para cima).</li><li>Toque em <strong>Adicionar à Tela de Início</strong>.</li><li>Abra o WeatherCenter pelo ícone novo e ative os avisos aqui.</li></ol>`;

async function render() {
  const cfg = await config();
  const imp = impedimento(cfg);
  const e = estado();
  const ativo = suporta() && Notification.permission === 'granted' && e.cidades.length > 0;

  // Barra da cidade aberta (previsão)
  const barra = $('notif-cidade');
  if (barra) {
    const c = cidadeAberta;
    if (!c || c.lat == null || c.foraDoBrasil || imp === 'sem-suporte' || imp === 'sem-config') { barra.hidden = true; }
    else {
      barra.hidden = false;
      const tem = ativo && e.cidades.some((x) => mesmaCidade(x, c));
      barra.innerHTML = tem
        ? `<span class="notif-sino" aria-hidden="true">🔔</span><span>Avisos de alerta ativados para <strong>${esc(c.nome)}</strong> neste aparelho.</span><a href="#alertas" class="notif-link">Gerenciar</a>`
        : imp === 'ios'
          ? `<span class="notif-sino" aria-hidden="true">🔔</span><span>Quer receber alertas de <strong>${esc(c.nome)}</strong> no iPhone? Adicione o app à tela de início.</span><a href="#alertas" class="notif-link">Como fazer</a>`
          : `<span class="notif-sino" aria-hidden="true">🔔</span><span>Receba no celular os alertas novos de <strong>${esc(c.nome)}</strong>, mesmo com o app fechado.</span><button type="button" class="btn-sec" id="notif-ativar" ${ocupado ? 'disabled' : ''}>${ocupado ? 'Ativando…' : 'Ativar avisos'}</button>`;
      if (mensagem) barra.insertAdjacentHTML('beforeend', `<p class="notif-msg">${esc(mensagem)}</p>`);
    }
  }

  // Cartão completo (parte de alertas)
  const painel = $('notif-painel');
  if (!painel) return;
  let html = '<h2 class="rotulo">Avisos no celular</h2>';
  if (imp === 'ios') html += AJUDA_IOS;
  else if (imp === 'sem-suporte') html += '<p>Este navegador não recebe notificações de sites. No Android, use o Chrome; no iPhone, adicione o app à tela de início pelo Safari.</p>';
  else if (imp === 'sem-config') html += '<p>Os avisos no celular estão sendo preparados e estarão disponíveis em breve.</p>';
  else {
    html += '<p class="nota">Quando surgir um alerta novo (ou um alerta ficar mais grave) para as cidades abaixo, você recebe uma notificação, mesmo com o app fechado. A verificação acontece a cada 5 minutos, aproximadamente.</p>';
    if (Notification.permission === 'denied') html += `<p class="notif-msg">⚠️ ${esc(textoBloqueado())}</p>`;
    html += e.cidades.length
      ? `<ul class="notif-cidades">${e.cidades.map((c, i) => `<li><span>${esc(nomeCidade(c))}</span><button type="button" class="btn-icone" data-remover="${i}" aria-label="Parar avisos de ${esc(c.nome)}" title="Remover" ${ocupado ? 'disabled' : ''}>✕</button></li>`).join('')}</ul>`
      : '<p>Nenhuma cidade ainda. Abra uma cidade (busca no topo da página) e toque em <strong>Ativar avisos</strong>.</p>';
    if (cidadeAberta && cidadeAberta.lat != null && !cidadeAberta.foraDoBrasil && !e.cidades.some((x) => mesmaCidade(x, cidadeAberta))) {
      html += `<button type="button" class="btn-sec" id="notif-add-atual" ${ocupado ? 'disabled' : ''}>+ Avisar sobre ${esc(cidadeAberta.nome)}</button>`;
    }
    html += `<label class="notif-nivel">Quais alertas avisar
      <select id="notif-nivel" ${ocupado ? 'disabled' : ''}>${NIVEIS.map((n) => `<option value="${n.v}" ${n.v === e.nivelMin ? 'selected' : ''}>${n.t}</option>`).join('')}</select></label>`;
    html += `<div class="notif-acoes"><button type="button" class="btn-sec" id="notif-testar" ${ocupado ? 'disabled' : ''}>Testar notificação</button></div>`;
    if (ativo) {
      const cod = await codigoAparelho();
      if (cod) html += `<p class="nota">Código deste aparelho: <strong class="notif-codigo">${cod}</strong></p>`;
    }
    html += '<p class="nota">Os avisos não substituem os alertas oficiais. Em emergências, ligue 199 (Defesa Civil) ou 193 (Bombeiros). Para receber também o SMS da Defesa Civil, envie seu CEP para 40199.</p>';
  }
  if (mensagem) html += `<p class="notif-msg">${esc(mensagem)}</p>`;
  painel.innerHTML = html;
}

document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.closest('#notif-ativar') || t.closest('#notif-add-atual')) { if (cidadeAberta) adicionarCidade(cidadeAberta); return; }
  if (t.closest('#notif-testar')) { testar(); return; }
  const rem = t.closest('[data-remover]');
  if (rem) removerCidade(+rem.dataset.remover);
});
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'notif-nivel') mudarNivel(+ev.target.value);
});

// Chamado pelo main.js sempre que uma cidade é aberta
export function definirCidadeNotificacao(c) {
  cidadeAberta = c;
  mensagem = '';
  render();
}

// Ao abrir o app: confirma a inscrição no servidor uma vez por dia (o navegador pode trocar o endereço)
export async function iniciarNotificacoes() {
  render();
  const e = estado();
  if (!suporta() || Notification.permission !== 'granted' || !e.cidades.length) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    const sinc = store.get('wc:notifSinc', {});
    if (!sub || sub.endpoint !== sinc.endpoint || Date.now() - (sinc.t || 0) > 24 * 3600 * 1000) await enviarInscricao(e);
  } catch (err) { console.warn('notificações', err); }
}
