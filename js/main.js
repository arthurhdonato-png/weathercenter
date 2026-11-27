// WeatherCenter: fluxo principal, busca, navegação e localização
import { $, esc, store, norm, UF_NOMES } from './util.js';
import {
  carregarMunicipios, buscarLocal, buscarOpenMeteo, coordenadas, previsao, qualidadeAr,
  todosAlertas, alertaAfetaCidade, posicaoAtual, cidadeDaPosicao, municipioPorId,
} from './dados.js';
import { renderAgora, renderResumo, renderChuvaProxima, renderWidgets, renderHoras, renderDias, renderFontes, renderAlertasCidade } from './previsao.js';
import { iniciarMapas, mapasVisiveis } from './mapas.js';
import { icone } from './icones.js';
import { iniciarAlertasMapa, definirAlertas, filtrarUF } from './alertasMapa.js';
import { definirCidadeNotificacao, iniciarNotificacoes } from './notificacoes.js';
import { abrirGraficos, GRUPOS_GRAFICO } from './graficos.js';
import { iniciarTema } from './tema.js';
import { renderCena } from './cena.js';

iniciarTema();

// Ícones fixos da página (lupa, localização, barra inferior)
document.querySelectorAll('[data-icone]').forEach((el) => { el.innerHTML = icone(el.dataset.icone); });

// Altura real do topo: os mapas ocupam exatamente o resto da tela
const topo = document.getElementById('topo');
const medirTopo = () => document.documentElement.style.setProperty('--altura-topo', `${topo.offsetHeight}px`);
medirTopo();
if ('ResizeObserver' in window) new ResizeObserver(medirTopo).observe(topo);

function setStatus(msg, erro = false) {
  const el = $('status');
  el.textContent = msg || '';
  el.hidden = !msg;
  el.classList.toggle('erro', !!erro);
}

/* ======================= Uma página só: previsão, mapas e alertas ======================= */
// Os links do topo (e da barra de baixo no celular) só levam a cada parte da página.
const SECOES = ['previsao', 'mapas', 'alertas'];
const marcarSecao = (id) => document.querySelectorAll('a[data-secao]').forEach((a) => a.setAttribute('aria-current', a.dataset.secao === id ? 'true' : 'false'));
marcarSecao('previsao');
document.querySelectorAll('a[data-secao]').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  irPara(a.dataset.secao);
}));
function irPara(id, suave = true) {
  const alvo = $(id);
  if (!alvo) return;
  history.replaceState(null, '', `${location.search}${id === 'previsao' ? '' : `#${id}`}`);
  if (id === 'previsao') window.scrollTo({ top: 0, behavior: suave ? 'smooth' : 'auto' });
  else alvo.scrollIntoView({ behavior: suave ? 'smooth' : 'auto', block: 'start' });
}

if ('IntersectionObserver' in window) {
  // Parte da página em destaque no menu
  const visiveis = new Map();
  const espiao = new IntersectionObserver((itens) => {
    for (const it of itens) visiveis.set(it.target.id, it.intersectionRatio);
    const melhor = SECOES.map((id) => [id, visiveis.get(id) || 0]).sort((a, b) => b[1] - a[1])[0];
    if (melhor[1] > 0) marcarSecao(melhor[0]);
  }, { threshold: [0, 0.15, 0.3, 0.5, 0.75], rootMargin: '-35% 0px -35% 0px' });
  SECOES.forEach((id) => espiao.observe($(id)));
  // Mapas só são montados quando chegam perto da tela (são pesados), e a animação para quando saem dela
  const perto = new IntersectionObserver((itens) => {
    for (const it of itens) {
      if (it.target.id === 'mapas') {
        if (it.isIntersecting) iniciarMapas(abrirPonto);
        mapasVisiveis(it.isIntersecting);
      }
      if (it.target.id === 'alertas' && it.isIntersecting) iniciarAlertasMapa(alertasCompartilhados);
    }
  }, { rootMargin: '300px 0px' });
  perto.observe($('mapas'));
  perto.observe($('alertas'));
} else {
  setTimeout(() => { iniciarMapas(abrirPonto); iniciarAlertasMapa(alertasCompartilhados); }, 0);
}

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
// Uma única consulta de alertas serve para a cidade e para o mapa (renovada a cada 5 minutos)
function alertasCompartilhados() {
  if (!alertasPromessa) {
    alertasPromessa = todosAlertas().catch(() => null);
    setTimeout(() => { alertasPromessa = null; }, 4.5 * 60 * 1000);
  }
  return alertasPromessa;
}

let cidadeAtual = null;
let aberto = null; // { prev, ar, cidade } da cidade na tela (para os gráficos e a atualização dos alertas)

// manterPosicao: true quando o app abre com #mapas ou #alertas no endereço
async function abrirCidade(cidade, { manterPosicao = false } = {}) {
  const meu = ++pedido;
  fecharSugestoes();
  $('campo-busca').value = '';
  $('campo-busca').blur();
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
    aberto = { prev, ar, cidade: c };
    renderAgora(prev, c);
    renderCena(prev, c);
    const alertasDaCidade = renderAlertasCidade(alertas, c, alertaAfetaCidade);
    renderResumo(prev, alertasDaCidade);
    renderChuvaProxima(prev);
    renderWidgets(prev, ar);
    marcarQuadros(ar);
    renderHoras(prev);
    renderDias(prev);
    renderFontes(prev);
    $('painel').hidden = false;
    // Cidade nova: volta ao início da página. Mesma cidade (atualização): a página fica onde está.
    const chaveCidade = c.id || `${c.nome}|${c.uf}|${c.local ? 'local' : ''}`;
    const nova = cidadeAtual !== chaveCidade;
    cidadeAtual = chaveCidade;
    $('boas-vindas').hidden = true;
    if (manterPosicao && SECOES.includes(location.hash.slice(1))) requestAnimationFrame(() => irPara(location.hash.slice(1), false));
    else if (nova) window.scrollTo({ top: 0 });
    setStatus('');
    salvarUltima(c);
    definirCidadeNotificacao(c);
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
  const c = await cidadeDaPosicao(lat, lon);
  c.local = false;
  abrirCidade(c);
}

/* ======================= Gráficos hora a hora ======================= */
const ROTULO_QUADRO = 'Hora a hora';
function marcarQuadros(ar) {
  document.querySelectorAll('#quadros [data-grafico]').forEach((q) => {
    const semAr = q.dataset.grafico === 'ar' && !ar?.hourly;
    q.classList.toggle('clicavel', !semAr);
    if (semAr) { q.removeAttribute('role'); q.removeAttribute('tabindex'); return; }
    q.setAttribute('role', 'button');
    q.setAttribute('tabindex', '0');
    q.setAttribute('aria-label', `${q.querySelector('.rotulo')?.textContent || ''}: ver gráfico hora a hora`);
    q.insertAdjacentHTML('beforeend', `<span class="ver-grafico" aria-hidden="true">${ROTULO_QUADRO} ›</span>`);
  });
  $('atalhos-graficos').innerHTML = GRUPOS_GRAFICO.filter((g) => g.id !== 'ar' || ar?.hourly)
    .map((g) => `<button type="button" class="chip" data-grafico="${g.id}">${esc(g.nome)}</button>`).join('');
}
function abrirGraficoDe(el) {
  if (!aberto) return;
  abrirGraficos({ prev: aberto.prev, ar: aberto.ar, cidade: aberto.cidade.nome, grupoId: el.dataset.grafico, dia: el.dataset.dia || null });
}
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-grafico]');
  if (g && !e.target.closest('a')) { abrirGraficoDe(g); return; }
  const uf = e.target.closest('[data-ver-uf]');
  if (uf) { filtrarUF(uf.dataset.verUf); irPara('alertas'); }
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('#quadros [data-grafico]')) { e.preventDefault(); abrirGraficoDe(e.target); }
});

/* ======================= Alertas sempre atualizados ======================= */
// A cada 5 minutos (com a página aberta e visível) busca os alertas de novo e redesenha
// a faixa da cidade, o mapa, a linha do tempo e a lista.
async function atualizarAlertas() {
  if (document.hidden) return;
  alertasPromessa = null;
  const r = await alertasCompartilhados();
  if (!r) return;
  definirAlertas(r);
  if (aberto) {
    const daCidade = renderAlertasCidade(r, aberto.cidade, alertaAfetaCidade);
    renderResumo(aberto.prev, daCidade);
  }
}
setInterval(atualizarAlertas, 5 * 60 * 1000);
let escondidaEm = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) escondidaEm = Date.now();
  else if (escondidaEm && Date.now() - escondidaEm > 5 * 60 * 1000) atualizarAlertas();
});

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

/* ======================= Última cidade ======================= */
// Só a última cidade aberta é lembrada (para abrir direto da próxima vez); a lista de recentes saiu.
function salvarUltima(c) {
  store.set('wc:ultima', c.local ? { local: true } : { id: c.id, nome: c.nome, uf: c.uf, lat: c.lat, lon: c.lon });
}
try { localStorage.removeItem('wc:recentes'); } catch { /* ok */ }

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
iniciarNotificacoes();

/* ======================= Início ======================= */
async function permissaoLocal() {
  try { return (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { return 'prompt'; }
}

const INICIO = { manterPosicao: true };
(async function iniciar() {
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
