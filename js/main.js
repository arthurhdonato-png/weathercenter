// WeatherCenter: fluxo principal, busca, navegação e localização
import { $, esc, store, norm, UF_NOMES } from './util.js';
import {
  carregarMunicipios, buscarLocal, buscarOpenMeteo, coordenadas, previsao, qualidadeAr,
  todosAlertas, alertaAfetaCidade, posicaoAtual, cidadeDaPosicao, municipioPorId,
} from './dados.js';
import { renderAgora, renderChuvaProxima, renderWidgets, renderHoras, renderDias, renderFontes, renderAlertasCidade } from './previsao.js';
import { iniciarMapas } from './mapas.js';
import { iniciarAlertasMapa } from './alertasMapa.js';

function setStatus(msg, erro = false) {
  const el = $('status');
  el.textContent = msg || '';
  el.hidden = !msg;
  el.classList.toggle('erro', !!erro);
}

/* ======================= Navegação por abas ======================= */
const ABAS = ['previsao', 'mapas', 'alertas'];
let abaAtual = null;
const rolagemDaAba = {}; // cada aba lembra onde a pessoa parou de rolar
function mostrarAba(aba) {
  if (!ABAS.includes(aba)) aba = 'previsao';
  if (aba === abaAtual) return;
  if (abaAtual) rolagemDaAba[abaAtual] = window.scrollY;
  abaAtual = aba;
  for (const a of ABAS) {
    $(`aba-${a}`).hidden = a !== aba;
    document.querySelectorAll(`a[data-aba="${a}"]`).forEach((b) => b.setAttribute('aria-current', a === aba ? 'page' : 'false'));
  }
  document.body.dataset.aba = aba;
  window.scrollTo({ top: rolagemDaAba[aba] || 0 });
  if (aba === 'mapas') requestAnimationFrame(() => iniciarMapas(abrirPonto));
  if (aba === 'alertas') requestAnimationFrame(() => iniciarAlertasMapa());
}
window.addEventListener('hashchange', () => {
  // Só reage a endereços das abas (#previsao, #mapas, #alertas); qualquer outro "#" é ignorado
  const aba = location.hash.slice(1);
  if (ABAS.includes(aba)) mostrarAba(aba);
});
// Atenção: só os LINKS das abas. O <body> também tem data-aba, e escutar cliques nele fazia
// qualquer clique na página voltar para o topo (e impedia abrir os dias da previsão).
document.querySelectorAll('a[data-aba]').forEach((b) => b.addEventListener('click', (e) => {
  e.preventDefault();
  history.replaceState(null, '', `${location.search}#${b.dataset.aba}`);
  mostrarAba(b.dataset.aba);
}));

// Botões que levam a um cartão da própria página (ex.: "Consenso de N fontes")
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ir]');
  if (!b) return;
  const alvo = $(b.dataset.ir);
  if (alvo) alvo.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Setas da previsão por hora (no computador, onde não há deslizar com o dedo)
document.querySelectorAll('[data-rolar]').forEach((b) => b.addEventListener('click', () => {
  const faixa = $('horas');
  faixa.scrollBy({ left: Number(b.dataset.rolar) * faixa.clientWidth * 0.8, behavior: 'smooth' });
}));

/* ======================= Abrir uma cidade ======================= */
let pedido = 0;
let alertasPromessa = null;
function alertasCompartilhados() {
  if (!alertasPromessa) {
    alertasPromessa = todosAlertas().catch(() => null);
    setTimeout(() => { alertasPromessa = null; }, 5 * 60 * 1000);
  }
  return alertasPromessa;
}

let cidadeAtual = null;
// trocarAba: false quando o app abre com #mapas ou #alertas no endereço (fica nessa aba)
async function abrirCidade(cidade, { trocarAba = true } = {}) {
  const meu = ++pedido;
  fecharSugestoes();
  $('campo-busca').value = '';
  $('campo-busca').blur();
  if (trocarAba) mostrarAba('previsao');
  setStatus(`Carregando o tempo em ${cidade.nome}…`);
  document.body.classList.add('carregando');
  try {
    const c = await coordenadas(cidade);
    const [prev, ar, alertas] = await Promise.all([
      previsao(c.lat, c.lon, c.id),
      qualidadeAr(c.lat, c.lon).catch(() => null),
      alertasCompartilhados(),
    ]);
    if (meu !== pedido) return;
    renderAgora(prev, c);
    renderAlertasCidade(alertas, c, alertaAfetaCidade);
    renderChuvaProxima(prev);
    renderWidgets(prev, ar);
    renderHoras(prev);
    renderDias(prev);
    renderFontes(prev);
    $('painel').hidden = false;
    // Cidade nova: começa do topo. Mesma cidade (atualização): a página fica onde está.
    const chaveCidade = c.id || `${c.nome}|${c.uf}|${c.local ? 'local' : ''}`;
    if (cidadeAtual !== chaveCidade && abaAtual === 'previsao') window.scrollTo({ top: 0 });
    cidadeAtual = chaveCidade;
    $('boas-vindas').hidden = true;
    setStatus('');
    salvarRecente(c);
    const params = new URLSearchParams();
    params.set('cidade', c.id || (c.local ? `${c.lat.toFixed(3)},${c.lon.toFixed(3)}` : `${c.nome}|${c.uf}`));
    history.replaceState(null, '', `?${params}${location.hash}`);
    document.title = `${c.nome} · WeatherCenter`;
  } catch (e) {
    if (meu !== pedido) return;
    console.error(e);
    setStatus(navigator.onLine === false ? 'Você está sem internet. Conecte-se e tente de novo.'
      : `Não foi possível carregar a previsão. ${e.message && !/HTTP|abort|fetch/i.test(e.message) ? e.message : 'Tente novamente em instantes.'}`, true);
  } finally {
    if (meu === pedido) document.body.classList.remove('carregando');
  }
}

async function abrirPonto(lat, lon) {
  setStatus('Procurando o local…');
  mostrarAba('previsao');
  const c = await cidadeDaPosicao(lat, lon);
  c.local = false;
  abrirCidade(c);
}

async function usarLocalizacao(opcoes) {
  setStatus('Obtendo sua localização…');
  try {
    const { lat, lon } = await posicaoAtual();
    store.set('wc:usarLocal', true);
    const c = await cidadeDaPosicao(lat, lon);
    if (c.foraDoBrasil) setStatus('Você parece estar fora do Brasil. Mostrando a previsão mesmo assim.');
    abrirCidade(c, opcoes);
  } catch (e) {
    store.set('wc:usarLocal', false);
    setStatus(e.message, true);
  }
}
$('btn-local').addEventListener('click', () => usarLocalizacao());
$('btn-local-boas').addEventListener('click', () => usarLocalizacao());

/* ======================= Recentes ======================= */
function salvarRecente(c) {
  if (c.local) { store.set('wc:ultima', { local: true }); renderRecentes(); return; }
  const item = { id: c.id, nome: c.nome, uf: c.uf, lat: c.lat, lon: c.lon };
  const lista = store.get('wc:recentes', []).filter((r) => !(r.nome === c.nome && r.uf === c.uf));
  lista.unshift(item);
  store.set('wc:recentes', lista.slice(0, 6));
  store.set('wc:ultima', item);
  renderRecentes();
}
function renderRecentes() {
  const lista = store.get('wc:recentes', []);
  $('recentes').innerHTML = lista.map((r, i) => `<button type="button" class="chip" data-i="${i}">${esc(r.nome)}${r.uf ? ` · ${esc(r.uf)}` : ''}</button>`).join('');
}
$('recentes').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) abrirCidade(store.get('wc:recentes', [])[+b.dataset.i]);
});

/* ======================= Busca com autocompletar ======================= */
let sugestoes = [], sel = -1, espera = null;
function fecharSugestoes() {
  $('sugestoes').hidden = true;
  $('campo-busca').setAttribute('aria-expanded', 'false');
  sugestoes = []; sel = -1;
}
function mostrarSugestoes(itens, q) {
  sugestoes = itens; sel = itens.length ? 0 : -1;
  $('sugestoes').innerHTML = itens.length
    ? itens.map((m, i) => `<li role="option" data-i="${i}" aria-selected="${i === 0}"><span>${esc(m.nome)}</span><span class="uf">${esc(UF_NOMES[m.uf] || m.uf)}</span></li>`).join('')
    : `<li aria-disabled="true"><span class="uf">Nenhuma cidade encontrada para “${esc(q)}”.</span></li>`;
  $('sugestoes').hidden = false;
  $('campo-busca').setAttribute('aria-expanded', 'true');
}
const marcar = () => [...$('sugestoes').children].forEach((li, i) => li.setAttribute('aria-selected', String(i === sel)));

$('campo-busca').addEventListener('input', (e) => {
  const q = e.target.value;
  clearTimeout(espera);
  if (norm(q).length < 2) { fecharSugestoes(); return; }
  espera = setTimeout(async () => {
    try {
      try {
        await carregarMunicipios();
        if ($('campo-busca').value === q) mostrarSugestoes(buscarLocal(q), q);
      } catch {
        const r = await buscarOpenMeteo(q);
        if ($('campo-busca').value === q) mostrarSugestoes(r, q);
      }
    } catch (err) {
      console.error(err);
      setStatus('Não foi possível buscar cidades agora. Verifique sua conexão.', true);
    }
  }, 120);
});
$('campo-busca').addEventListener('keydown', (e) => {
  if ($('sugestoes').hidden || !sugestoes.length) return;
  if (e.key === 'ArrowDown') { sel = (sel + 1) % sugestoes.length; marcar(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { sel = (sel - 1 + sugestoes.length) % sugestoes.length; marcar(); e.preventDefault(); }
  else if (e.key === 'Enter') { e.preventDefault(); if (sel >= 0) abrirCidade(sugestoes[sel]); }
  else if (e.key === 'Escape') fecharSugestoes();
});
$('sugestoes').addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li) { e.preventDefault(); abrirCidade(sugestoes[+li.dataset.i]); }
});
$('campo-busca').addEventListener('blur', () => setTimeout(fecharSugestoes, 150));

/* ======================= Instalação (PWA) ======================= */
let pedidoInstalacao = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); pedidoInstalacao = e; $('btn-instalar').hidden = false; });
$('btn-instalar').addEventListener('click', async () => {
  if (!pedidoInstalacao) return;
  pedidoInstalacao.prompt();
  await pedidoInstalacao.userChoice;
  pedidoInstalacao = null;
  $('btn-instalar').hidden = true;
});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(console.warn));
}

/* ======================= Início ======================= */
async function permissaoLocal() {
  try { return (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { return 'prompt'; }
}

const INICIO = { trocarAba: false };
(async function iniciar() {
  renderRecentes();
  mostrarAba(location.hash.slice(1));
  carregarMunicipios().catch(() => { /* plano B: Open-Meteo */ });

  const param = new URLSearchParams(location.search).get('cidade');
  if (param) {
    try {
      if (/^\d{7}$/.test(param)) {
        await carregarMunicipios();
        const c = municipioPorId(param);
        if (c) return abrirCidade(c, INICIO);
      } else if (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(param)) {
        const [lat, lon] = param.split(',').map(Number);
        return abrirCidade(await cidadeDaPosicao(lat, lon), INICIO);
      } else {
        const [nome, uf] = param.split('|');
        return abrirCidade({ id: null, nome, uf: uf || '' }, INICIO);
      }
    } catch { /* segue */ }
  }
  const ultima = store.get('wc:ultima');
  const usarLocal = store.get('wc:usarLocal');
  // Abre na localização atual quando a pessoa já permitiu antes
  if (usarLocal !== false && (await permissaoLocal()) === 'granted') return usarLocalizacao(INICIO);
  if (ultima && !ultima.local) return abrirCidade(ultima, INICIO);
  if (ultima?.local && usarLocal) return usarLocalizacao(INICIO);
})();
