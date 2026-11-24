'use strict';

/* ======================================================================
   WeatherCenter – primeira versão
   Fontes:
   - Lista de municípios: API de Localidades do IBGE
   - Coordenadas: geocodificação do Open-Meteo
   - Previsão: Open-Meteo (sem chave de API)
   - Alertas: avisos ativos do INMET
   ====================================================================== */

const API = {
  municipios: 'https://servicodados.ibge.gov.br/api/v1/localidades/municipios?view=nivelado',
  geocode: 'https://geocoding-api.open-meteo.com/v1/search',
  previsao: 'https://api.open-meteo.com/v1/forecast',
  alertas: 'https://apiprevmet3.inmet.gov.br/avisos/ativos',
  alertasSite: 'https://alertas2.inmet.gov.br/',
};

const UF_NOMES = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará',
  DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso',
  MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná',
  PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte',
  RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina',
  SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};

// Códigos de tempo da OMM (WMO) usados pelo Open-Meteo
const TEMPO = {
  0: ['Céu limpo', '☀️', '🌙'],
  1: ['Predomínio de sol', '🌤️', '🌙'],
  2: ['Parcialmente nublado', '⛅', '☁️'],
  3: ['Nublado', '☁️', '☁️'],
  45: ['Nevoeiro', '🌫️', '🌫️'],
  48: ['Nevoeiro com geada', '🌫️', '🌫️'],
  51: ['Garoa fraca', '🌦️', '🌧️'],
  53: ['Garoa', '🌦️', '🌧️'],
  55: ['Garoa forte', '🌧️', '🌧️'],
  56: ['Garoa congelante', '🌧️', '🌧️'],
  57: ['Garoa congelante forte', '🌧️', '🌧️'],
  61: ['Chuva fraca', '🌦️', '🌧️'],
  63: ['Chuva', '🌧️', '🌧️'],
  65: ['Chuva forte', '🌧️', '🌧️'],
  66: ['Chuva congelante', '🌧️', '🌧️'],
  67: ['Chuva congelante forte', '🌧️', '🌧️'],
  71: ['Neve fraca', '🌨️', '🌨️'],
  73: ['Neve', '🌨️', '🌨️'],
  75: ['Neve forte', '❄️', '❄️'],
  77: ['Grãos de neve', '🌨️', '🌨️'],
  80: ['Pancadas de chuva', '🌦️', '🌧️'],
  81: ['Pancadas de chuva', '🌧️', '🌧️'],
  82: ['Pancadas de chuva fortes', '⛈️', '⛈️'],
  85: ['Pancadas de neve', '🌨️', '🌨️'],
  86: ['Pancadas de neve fortes', '❄️', '❄️'],
  95: ['Trovoadas', '⛈️', '⛈️'],
  96: ['Trovoadas com granizo', '⛈️', '⛈️'],
  99: ['Trovoadas com granizo forte', '⛈️', '⛈️'],
};
const tempo = (code, dia = true) => {
  const t = TEMPO[code] || ['—', '🌡️', '🌡️'];
  return { desc: t[0], icone: dia ? t[1] : t[2] };
};

const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const PONTOS = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];

const $ = (id) => document.getElementById(id);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- armazenamento local (tolerante a falhas) ---------- */
const store = {
  get(k, padrao = null) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : padrao; } catch { return padrao; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem espaço ou bloqueado */ } },
};

async function getJSON(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function setStatus(msg, erro = false) {
  const el = $('status');
  el.textContent = msg || '';
  el.classList.toggle('erro', !!erro);
}

/* ======================================================================
   Municípios (IBGE)
   ====================================================================== */
let municipios = null; // [{ id, nome, uf, n }]
let carregandoMunicipios = null;

function lerMunicipio(m) {
  // Aceita o formato "nivelado" e o formato aninhado da API do IBGE.
  const id = m['municipio-id'] ?? m.id;
  const nome = m['municipio-nome'] ?? m.nome;
  const uf = m['UF-sigla']
    ?? m.microrregiao?.mesorregiao?.UF?.sigla
    ?? m['regiao-imediata']?.['regiao-intermediaria']?.UF?.sigla;
  if (!id || !nome || !uf) return null;
  return { id: String(id), nome, uf };
}

function carregarMunicipios() {
  if (municipios) return Promise.resolve(municipios);
  if (carregandoMunicipios) return carregandoMunicipios;
  carregandoMunicipios = (async () => {
    let lista = store.get('wc:municipios:v1');
    if (!Array.isArray(lista) || lista.length < 5000) {
      const dados = await getJSON(API.municipios, 30000);
      lista = dados.map(lerMunicipio).filter(Boolean);
      if (lista.length > 5000) store.set('wc:municipios:v1', lista);
    }
    municipios = lista.map((m) => ({ ...m, n: norm(m.nome) }));
    return municipios;
  })().catch((e) => {
    carregandoMunicipios = null;
    throw e;
  });
  return carregandoMunicipios;
}

function buscarLocal(consulta) {
  let q = norm(consulta);
  let ufFiltro = null;
  // Aceita "Cidade - UF", "Cidade, UF" ou "Cidade UF"
  const m = q.match(/^(.*?)[\s,\-/]+([a-z]{2})$/);
  if (m && UF_NOMES[m[2].toUpperCase()]) { q = m[1].trim(); ufFiltro = m[2].toUpperCase(); }
  if (q.length < 2) return [];
  const comeca = [], contem = [];
  for (const mu of municipios) {
    if (ufFiltro && mu.uf !== ufFiltro) continue;
    if (mu.n.startsWith(q)) comeca.push(mu);
    else if (mu.n.includes(q)) contem.push(mu);
  }
  const ord = (a, b) => a.n.length - b.n.length || a.n.localeCompare(b.n);
  return [...comeca.sort(ord), ...contem.sort(ord)].slice(0, 8);
}

// Plano B: se o IBGE estiver fora do ar, busca direto no Open-Meteo.
const UF_POR_NOME = Object.fromEntries(Object.entries(UF_NOMES).map(([s, n]) => [norm(n), s]));
async function buscarOpenMeteo(consulta) {
  const url = `${API.geocode}?name=${encodeURIComponent(consulta)}&count=15&language=pt&format=json&countryCode=BR`;
  const dados = await getJSON(url);
  return (dados.results || [])
    .filter((r) => r.country_code === 'BR')
    .slice(0, 8)
    .map((r) => ({ id: null, nome: r.name, uf: UF_POR_NOME[norm(r.admin1)] || '', lat: r.latitude, lon: r.longitude }));
}

/* ---------- coordenadas ---------- */
async function coordenadas(cidade) {
  if (cidade.lat != null) return cidade;
  const cache = store.get('wc:coords', {});
  if (cidade.id && cache[cidade.id]) return { ...cidade, ...cache[cidade.id] };

  const url = `${API.geocode}?name=${encodeURIComponent(cidade.nome)}&count=30&language=pt&format=json&countryCode=BR`;
  const dados = await getJSON(url);
  const res = (dados.results || []).filter((r) => r.country_code === 'BR');
  const nomeN = norm(cidade.nome);
  const estadoN = norm(UF_NOMES[cidade.uf]);
  const mesmoEstado = (r) => norm(r.admin1) === estadoN;
  const mesmoNome = (r) => norm(r.name) === nomeN;
  const escolhido =
    res.find((r) => mesmoNome(r) && mesmoEstado(r) && /^PPL/.test(r.feature_code || '')) ||
    res.find((r) => mesmoNome(r) && mesmoEstado(r)) ||
    res.find(mesmoEstado) ||
    (!cidade.uf && (res.find(mesmoNome) || res[0]));
  if (!escolhido) throw new Error('Não encontramos as coordenadas desta cidade.');
  const c = { lat: escolhido.latitude, lon: escolhido.longitude };
  if (cidade.id) { cache[cidade.id] = c; store.set('wc:coords', cache); }
  return { ...cidade, ...c };
}

/* ======================================================================
   Previsão (Open-Meteo)
   ====================================================================== */
async function buscarPrevisao(lat, lon) {
  const p = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: 'auto', forecast_days: '7',
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    hourly: 'temperature_2m,precipitation_probability,weather_code,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,uv_index_max,wind_speed_10m_max',
  });
  // Guarda por 30 minutos para poupar chamadas à API
  const chave = `wc:prev:${(+lat).toFixed(2)},${(+lon).toFixed(2)}`;
  const salvo = store.get(chave);
  if (salvo && Date.now() - salvo.t < 30 * 60 * 1000) return salvo.d;
  const d = await getJSON(`${API.previsao}?${p}`);
  store.set(chave, { t: Date.now(), d });
  return d;
}

/* ======================================================================
   Alertas (INMET)
   ====================================================================== */
async function buscarAlertas() {
  const dados = await getJSON(API.alertas, 20000);
  const lista = Array.isArray(dados) ? dados : [...(dados.hoje || []), ...(dados.futuro || [])];
  // Remove duplicados (o mesmo aviso pode aparecer em "hoje" e "futuro")
  const vistos = new Set();
  return lista.filter((a) => {
    const k = a.id ?? JSON.stringify([a.descricao, a.inicio, a.fim]);
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

function alertaAfetaCidade(a, cidade) {
  const codigos = Array.isArray(a.geocodes) ? a.geocodes.join(',') : String(a.geocodes ?? a.geocode ?? '');
  if (cidade.id && /\d/.test(codigos)) {
    const id7 = cidade.id, id6 = cidade.id.slice(0, 6);
    return codigos.split(/\D+/).some((c) => c === id7 || c === id6);
  }
  // Sem código IBGE: compara pelo nome do município + UF
  const texto = norm(Array.isArray(a.municipios) ? a.municipios.join(',') : a.municipios);
  if (!texto) return false;
  const alvo = norm(cidade.nome);
  return texto.split(/[,;]/).some((parte) => {
    const p = parte.trim();
    return p === alvo || p === `${alvo} - ${norm(cidade.uf)}` || p === `${alvo} (${norm(cidade.uf)})` || p.startsWith(`${alvo} -`);
  });
}

function corAlerta(a) {
  const sev = norm(a.severidade);
  const cor = norm(a.aviso_cor);
  if (sev.includes('grande') || cor.includes('vermelh') || cor === '#ff0000') return 'vermelho';
  if (sev === 'perigo' || cor.includes('laranja') || cor === '#ff8c00' || cor === '#ffa500') return 'laranja';
  return 'amarelo';
}

function formatarDataINMET(data, hora, iso) {
  let d = null;
  if (iso) d = new Date(String(iso).replace(' ', 'T'));
  if ((!d || isNaN(d)) && data) d = new Date(`${data}T${hora || '00:00'}`);
  if (!d || isNaN(d)) return [data, hora].filter(Boolean).join(' ');
  return d.toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const lista = (v) => (Array.isArray(v) ? v : v ? String(v).split(/\n|;(?=\s*[A-ZÁÉÍÓÚ])/) : [])
  .map((s) => String(s).trim()).filter(Boolean);

function renderAlertas(alertas, cidade) {
  const el = $('alertas');
  if (alertas === null) {
    el.innerHTML = `<div class="sem-alerta">Não foi possível consultar os alertas do INMET agora.
      Veja em <a href="${API.alertasSite}" target="_blank" rel="noopener">alertas2.inmet.gov.br</a>.</div>`;
    return;
  }
  const daCidade = alertas.filter((a) => alertaAfetaCidade(a, cidade));
  if (!daCidade.length) {
    el.innerHTML = `<div class="sem-alerta">✅ Nenhum alerta ativo do INMET para ${esc(cidade.nome)}.</div>`;
    return;
  }
  const peso = { vermelho: 0, laranja: 1, amarelo: 2 };
  daCidade.sort((a, b) => peso[corAlerta(a)] - peso[corAlerta(b)]);
  el.innerHTML = daCidade.map((a) => {
    const cor = corAlerta(a);
    const riscos = lista(a.riscos);
    const instr = lista(a.instrucoes);
    const inicio = formatarDataINMET(a.data_inicio, a.hora_inicio, a.inicio);
    const fim = formatarDataINMET(a.data_fim, a.hora_fim, a.fim);
    return `<div class="alerta ${cor}" role="alert">
      <div class="sev">⚠️ ${esc(a.severidade || 'Alerta')}</div>
      <h3>${esc(a.descricao || a.evento || 'Alerta meteorológico')}</h3>
      <div class="pequeno">${inicio ? `De ${esc(inicio)}` : ''}${fim ? ` até ${esc(fim)}` : ''}</div>
      ${riscos.length || instr.length ? `<details>
        <summary>Riscos e o que fazer</summary>
        ${riscos.length ? `<strong>Riscos</strong><ul>${riscos.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        ${instr.length ? `<strong>Instruções</strong><ul>${instr.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      </details>` : ''}
    </div>`;
  }).join('') + `<p class="sutil pequeno" style="margin:-4px 2px 12px">Fonte: INMET. Mais detalhes em <a href="${API.alertasSite}" target="_blank" rel="noopener">alertas2.inmet.gov.br</a>.</p>`;
}

/* ======================================================================
   Renderização da previsão
   ====================================================================== */
function renderPrevisao(prev, cidade) {
  const c = prev.current;
  const d = prev.daily;
  const h = prev.hourly;
  const t = tempo(c.weather_code, c.is_day === 1);

  $('cidade-nome').textContent = cidade.nome;
  $('cidade-uf').textContent = UF_NOMES[cidade.uf] || cidade.uf || 'Brasil';
  $('atual-icone').textContent = t.icone;
  $('atual-temp').textContent = `${Math.round(c.temperature_2m)}°`;
  $('atual-desc').textContent = t.desc;
  $('atual-sensacao').textContent =
    `Sensação ${Math.round(c.apparent_temperature)}° · Máx ${Math.round(d.temperature_2m_max[0])}° Mín ${Math.round(d.temperature_2m_min[0])}°`;
  $('d-umidade').textContent = `${c.relative_humidity_2m}%`;
  const dir = PONTOS[Math.round(((c.wind_direction_10m % 360) / 45)) % 8];
  $('d-vento').textContent = `${Math.round(c.wind_speed_10m)} km/h ${dir}`;
  $('d-chuva').textContent = `${(c.precipitation ?? 0).toLocaleString('pt-BR')} mm`;
  $('d-uv').textContent = d.uv_index_max?.[0] != null ? Math.round(d.uv_index_max[0]) : '—';
  $('atualizado').textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · horário local da cidade`;

  // Próximas 24 horas a partir da hora atual da cidade
  const agora = c.time.slice(0, 13); // "AAAA-MM-DDTHH"
  let i0 = h.time.findIndex((x) => x.slice(0, 13) >= agora);
  if (i0 < 0) i0 = 0;
  const horas = [];
  for (let i = i0; i < Math.min(i0 + 24, h.time.length); i++) {
    const th = tempo(h.weather_code[i], h.is_day?.[i] === 1);
    const prob = h.precipitation_probability?.[i];
    horas.push(`<div class="hora">
      <div class="h">${i === i0 ? 'Agora' : h.time[i].slice(11, 13) + 'h'}</div>
      <div class="i" title="${esc(th.desc)}">${th.icone}</div>
      <div class="t">${Math.round(h.temperature_2m[i])}°</div>
      <div class="p">${prob ? `💧${prob}%` : ''}</div>
    </div>`);
  }
  $('horas').innerHTML = horas.join('');

  // Próximos dias
  $('dias').innerHTML = d.time.map((dia, i) => {
    const dt = new Date(`${dia}T12:00:00`);
    const nome = i === 0 ? 'Hoje' : i === 1 ? 'Amanhã' : DIAS_SEMANA[dt.getDay()];
    const td = tempo(d.weather_code[i]);
    const prob = d.precipitation_probability_max?.[i];
    const mm = d.precipitation_sum?.[i];
    const chuva = prob ? `<span class="chuva">💧 ${prob}%${mm ? ` · ${mm.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mm` : ''}</span>` : '';
    return `<li class="dia">
      <div class="nome">${nome}<small>${dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</small></div>
      <div class="i" aria-hidden="true">${td.icone}</div>
      <div class="desc">${esc(td.desc)}<br>${chuva}</div>
      <div class="temps">${Math.round(d.temperature_2m_max[i])}°<span class="min">${Math.round(d.temperature_2m_min[i])}°</span></div>
    </li>`;
  }).join('');
}

/* ======================================================================
   Fluxo principal
   ====================================================================== */
let pedidoAtual = 0;

async function abrirCidade(cidade) {
  const meu = ++pedidoAtual;
  fecharSugestoes();
  $('campo-busca').value = '';
  $('campo-busca').blur();
  setStatus(`Carregando o tempo em ${cidade.nome}…`);
  try {
    const comCoords = await coordenadas(cidade);
    const [prev, alertas] = await Promise.all([
      buscarPrevisao(comCoords.lat, comCoords.lon),
      buscarAlertas().catch((e) => { console.warn('Alertas INMET indisponíveis:', e); return null; }),
    ]);
    if (meu !== pedidoAtual) return;
    renderPrevisao(prev, comCoords);
    renderAlertas(alertas, comCoords);
    $('painel').hidden = false;
    $('boas-vindas').hidden = true;
    setStatus('');
    salvarRecente(comCoords);
    const params = new URLSearchParams(location.search);
    params.set('cidade', comCoords.id || `${comCoords.nome}|${comCoords.uf}`);
    history.replaceState(null, '', `?${params}`);
    document.title = `${comCoords.nome} – WeatherCenter`;
  } catch (e) {
    if (meu !== pedidoAtual) return;
    console.error(e);
    setStatus(navigator.onLine === false
      ? 'Você está sem internet. Conecte-se e tente de novo.'
      : `Não foi possível carregar a previsão. ${e.message && !/HTTP|abort/i.test(e.message) ? e.message : 'Tente novamente em instantes.'}`, true);
  }
}

/* ---------- recentes ---------- */
function salvarRecente(c) {
  const item = { id: c.id, nome: c.nome, uf: c.uf, lat: c.lat, lon: c.lon };
  const recentes = store.get('wc:recentes', []).filter((r) => !(r.nome === c.nome && r.uf === c.uf));
  recentes.unshift(item);
  store.set('wc:recentes', recentes.slice(0, 6));
  store.set('wc:ultima', item);
  renderRecentes();
}
function renderRecentes() {
  const recentes = store.get('wc:recentes', []);
  $('recentes').innerHTML = recentes
    .map((r, i) => `<button type="button" data-i="${i}">${esc(r.nome)}${r.uf ? ` · ${esc(r.uf)}` : ''}</button>`)
    .join('');
}
$('recentes').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) abrirCidade(store.get('wc:recentes', [])[+b.dataset.i]);
});

/* ---------- autocompletar ---------- */
let sugestoes = [];
let selecionada = -1;
let debounce = null;

function fecharSugestoes() {
  $('sugestoes').hidden = true;
  $('campo-busca').setAttribute('aria-expanded', 'false');
  sugestoes = [];
  selecionada = -1;
}

function mostrarSugestoes(itens, consulta) {
  sugestoes = itens;
  selecionada = itens.length ? 0 : -1;
  const ul = $('sugestoes');
  if (!itens.length) {
    ul.innerHTML = `<li aria-disabled="true"><span class="uf">Nenhuma cidade encontrada para “${esc(consulta)}”.</span></li>`;
  } else {
    ul.innerHTML = itens.map((m, i) =>
      `<li role="option" id="sug-${i}" data-i="${i}" aria-selected="${i === 0}">
        <span>${esc(m.nome)}</span><span class="uf">${esc(UF_NOMES[m.uf] || m.uf)}</span></li>`).join('');
  }
  ul.hidden = false;
  $('campo-busca').setAttribute('aria-expanded', 'true');
}

function marcarSelecionada() {
  [...$('sugestoes').children].forEach((li, i) => li.setAttribute('aria-selected', String(i === selecionada)));
}

$('campo-busca').addEventListener('input', (e) => {
  const q = e.target.value;
  clearTimeout(debounce);
  if (norm(q).length < 2) { fecharSugestoes(); return; }
  debounce = setTimeout(async () => {
    try {
      if (municipios) {
        mostrarSugestoes(buscarLocal(q), q);
      } else {
        try {
          await carregarMunicipios();
          if ($('campo-busca').value === q) mostrarSugestoes(buscarLocal(q), q);
        } catch {
          const r = await buscarOpenMeteo(q);
          if ($('campo-busca').value === q) mostrarSugestoes(r, q);
        }
      }
    } catch (err) {
      console.error(err);
      setStatus('Não foi possível buscar cidades agora. Verifique sua conexão.', true);
    }
  }, municipios ? 80 : 300);
});

$('campo-busca').addEventListener('keydown', (e) => {
  if ($('sugestoes').hidden || !sugestoes.length) return;
  if (e.key === 'ArrowDown') { selecionada = (selecionada + 1) % sugestoes.length; marcarSelecionada(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { selecionada = (selecionada - 1 + sugestoes.length) % sugestoes.length; marcarSelecionada(); e.preventDefault(); }
  else if (e.key === 'Enter') { e.preventDefault(); if (selecionada >= 0) abrirCidade(sugestoes[selecionada]); }
  else if (e.key === 'Escape') fecharSugestoes();
});

$('sugestoes').addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li) { e.preventDefault(); abrirCidade(sugestoes[+li.dataset.i]); }
});
$('campo-busca').addEventListener('blur', () => setTimeout(fecharSugestoes, 150));

/* ---------- instalação como app (PWA) ---------- */
let pedidoInstalacao = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  pedidoInstalacao = e;
  $('btn-instalar').hidden = false;
});
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

/* ---------- início ---------- */
(async function iniciar() {
  renderRecentes();
  carregarMunicipios().catch(() => { /* usa o Open-Meteo como plano B */ });

  const param = new URLSearchParams(location.search).get('cidade');
  if (param) {
    try {
      if (/^\d{7}$/.test(param)) {
        const lista = await carregarMunicipios();
        const c = lista.find((m) => m.id === param);
        if (c) return abrirCidade(c);
      } else {
        const [nome, uf] = param.split('|');
        return abrirCidade({ id: null, nome, uf: uf || '' });
      }
    } catch { /* segue para a última cidade */ }
  }
  const ultima = store.get('wc:ultima');
  if (ultima) abrirCidade(ultima);
})();
