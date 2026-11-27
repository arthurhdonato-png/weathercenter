// Utilidades compartilhadas

export const $ = (id) => document.getElementById(id);
export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const r0 = (v) => (v == null || Number.isNaN(v) ? '—' : Math.round(v));
export const num = (v, casas = 1) => (v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: casas }));

export const store = {
  get(k, padrao = null) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : padrao; } catch { return padrao; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* cheio ou bloqueado */ }
  },
};

export async function getJSON(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Guarda o resultado de uma função assíncrona no localStorage por `ttlMs`.
// Se a fonte falhar (ex.: limite de consultas), usa a cópia guardada enquanto ela tiver menos de `velhoAteMs`.
export async function comCache(chave, ttlMs, fn, velhoAteMs = 0) {
  const salvo = store.get(chave);
  if (salvo && Date.now() - salvo.t < ttlMs) return salvo.d;
  try {
    const d = await fn();
    store.set(chave, { t: Date.now(), d });
    return d;
  } catch (e) {
    if (salvo && Date.now() - salvo.t < velhoAteMs) { console.warn('Usando cópia guardada de', chave, e.message); return salvo.d; }
    throw e;
  }
}

// Igual ao comCache, mas para dados grandes (grade dos mapas): guarda no Cache Storage do navegador,
// que tem muito mais espaço que o localStorage
const CACHE_GRANDE = 'wc-grande';
export async function comCacheGrande(chave, ttlMs, fn, velhoAteMs = 0) {
  let cache = null, salvo = null;
  try {
    cache = await caches.open(CACHE_GRANDE);
    const r = await cache.match(`/${chave}`);
    if (r) salvo = await r.json();
  } catch { /* sem Cache Storage */ }
  if (salvo && Date.now() - salvo.t < ttlMs) return salvo.d;
  try {
    const d = await fn();
    try { await cache?.put(`/${chave}`, new Response(JSON.stringify({ t: Date.now(), d }))); } catch { /* cheio */ }
    return d;
  } catch (e) {
    if (salvo && Date.now() - salvo.t < velhoAteMs) { console.warn('Usando cópia guardada de', chave, e.message); return salvo.d; }
    throw e;
  }
}

// Erro de "consultas demais" (HTTP 429) do serviço de previsão
export const ehLimite = (e) => e?.status === 429 || /429|too many|limit exceeded/i.test(String(e?.message || ''));

// Intensidade da chuva por mm/h. É a ÚNICA regra do site: o texto do tempo, a cena animada e o radar
// usam estes limites (classes usuais da meteorologia): até 2,5 fraca, até 10 moderada, até 50 forte, acima muito forte
export const LIMITES_CHUVA = [0.1, 2.5, 10, 50];
export const NOMES_CHUVA = [null, 'fraca', 'moderada', 'forte', 'muito forte'];
export const FAIXAS_CHUVA = [null, 'até 2,5 mm/h', '2,5 a 10 mm/h', '10 a 50 mm/h', 'mais de 50 mm/h'];
export const intensidadeMm = (mm) => (!(mm >= LIMITES_CHUVA[0]) ? 0 : mm < LIMITES_CHUVA[1] ? 1 : mm < LIMITES_CHUVA[2] ? 2 : mm < LIMITES_CHUVA[3] ? 3 : 4);

export const UF_NOMES = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará',
  DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso',
  MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná',
  PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte',
  RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina',
  SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};
export const UF_POR_NOME = Object.fromEntries(Object.entries(UF_NOMES).map(([s, n]) => [norm(n), s]));
// Código IBGE (2 primeiros dígitos) → sigla
export const UF_POR_CODIGO = {
  11: 'RO', 12: 'AC', 13: 'AM', 14: 'RR', 15: 'PA', 16: 'AP', 17: 'TO', 21: 'MA', 22: 'PI', 23: 'CE',
  24: 'RN', 25: 'PB', 26: 'PE', 27: 'AL', 28: 'SE', 29: 'BA', 31: 'MG', 32: 'ES', 33: 'RJ', 35: 'SP',
  41: 'PR', 42: 'SC', 43: 'RS', 50: 'MS', 51: 'MT', 52: 'GO', 53: 'DF',
};

// Códigos de tempo da OMM usados pelo Open-Meteo: [descrição, ícone dia, ícone noite, tema]
const TEMPO = {
  0: ['Céu limpo', '☀️', '🌙', 'limpo'], 1: ['Predomínio de sol', '🌤️', '🌙', 'limpo'],
  2: ['Parcialmente nublado', '⛅', '☁️', 'nuvens'], 3: ['Nublado', '☁️', '☁️', 'nublado'],
  45: ['Nevoeiro', '🌫️', '🌫️', 'nublado'], 48: ['Nevoeiro com geada', '🌫️', '🌫️', 'nublado'],
  51: ['Garoa fraca', '🌦️', '🌧️', 'chuva'], 53: ['Garoa', '🌦️', '🌧️', 'chuva'], 55: ['Garoa forte', '🌧️', '🌧️', 'chuva'],
  56: ['Garoa congelante', '🌧️', '🌧️', 'chuva'], 57: ['Garoa congelante forte', '🌧️', '🌧️', 'chuva'],
  61: ['Chuva fraca', '🌦️', '🌧️', 'chuva'], 63: ['Chuva moderada', '🌧️', '🌧️', 'chuva'], 65: ['Chuva forte', '🌧️', '🌧️', 'chuva'],
  66: ['Chuva congelante', '🌧️', '🌧️', 'chuva'], 67: ['Chuva congelante forte', '🌧️', '🌧️', 'chuva'],
  71: ['Neve fraca', '🌨️', '🌨️', 'nublado'], 73: ['Neve', '🌨️', '🌨️', 'nublado'], 75: ['Neve forte', '❄️', '❄️', 'nublado'],
  77: ['Grãos de neve', '🌨️', '🌨️', 'nublado'],
  80: ['Pancadas de chuva fraca', '🌦️', '🌧️', 'chuva'], 81: ['Pancadas de chuva moderada', '🌧️', '🌧️', 'chuva'],
  82: ['Pancadas de chuva forte', '⛈️', '⛈️', 'tempestade'], 85: ['Pancadas de neve', '🌨️', '🌨️', 'nublado'],
  86: ['Pancadas de neve fortes', '❄️', '❄️', 'nublado'],
  95: ['Trovoadas', '⛈️', '⛈️', 'tempestade'], 96: ['Trovoadas com granizo', '⛈️', '⛈️', 'tempestade'],
  99: ['Trovoadas com granizo forte', '⛈️', '⛈️', 'tempestade'],
};
export function tempo(code, dia = true) {
  const t = TEMPO[code] || ['—', '🌡️', '🌡️', 'nuvens'];
  return { desc: t[0], icone: dia ? t[1] : t[2], tema: t[3] };
}

const PONTOS = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
export const direcao = (graus) => (graus == null ? '' : PONTOS[Math.round((((graus % 360) + 360) % 360) / 45) % 8]);

export function nivelUV(uv) {
  if (uv == null) return { nome: '—', cor: '#999', dica: '' };
  if (uv < 3) return { nome: 'Baixo', cor: '#3ea72d', dica: 'Pode ficar ao ar livre com tranquilidade.' };
  if (uv < 6) return { nome: 'Moderado', cor: '#e4c600', dica: 'Use protetor solar se ficar muito tempo ao sol.' };
  if (uv < 8) return { nome: 'Alto', cor: '#f18b00', dica: 'Protetor, chapéu e óculos. Evite o sol entre 10h e 16h.' };
  if (uv < 11) return { nome: 'Muito alto', cor: '#e53210', dica: 'Evite o sol entre 10h e 16h. Proteção obrigatória.' };
  return { nome: 'Extremo', cor: '#b567a4', dica: 'Evite ficar ao sol. Risco muito alto de queimaduras.' };
}

export function nivelAr(aqi) {
  if (aqi == null) return { nome: '—', cor: '#999' };
  if (aqi <= 50) return { nome: 'Boa', cor: '#3ea72d' };
  if (aqi <= 100) return { nome: 'Moderada', cor: '#e4c600' };
  if (aqi <= 150) return { nome: 'Ruim p/ sensíveis', cor: '#f18b00' };
  if (aqi <= 200) return { nome: 'Ruim', cor: '#e53210' };
  if (aqi <= 300) return { nome: 'Muito ruim', cor: '#8f3f97' };
  return { nome: 'Péssima', cor: '#7e0023' };
}

// Fase da lua (0 = nova, 0.5 = cheia)
export function faseLua(data = new Date()) {
  const ref = Date.UTC(2000, 0, 6, 18, 14); // lua nova de referência
  const ciclo = 29.530588853;
  const dias = (data.getTime() - ref) / 86400000;
  const f = ((dias % ciclo) + ciclo) % ciclo / ciclo;
  const nomes = [
    [0.0339, 'Lua nova', '🌑'], [0.2161, 'Crescente', '🌒'], [0.2839, 'Quarto crescente', '🌓'],
    [0.4661, 'Crescente gibosa', '🌔'], [0.5339, 'Lua cheia', '🌕'], [0.7161, 'Minguante gibosa', '🌖'],
    [0.7839, 'Quarto minguante', '🌗'], [0.9661, 'Minguante', '🌘'], [1.01, 'Lua nova', '🌑'],
  ];
  const [, nome, icone] = nomes.find(([lim]) => f < lim);
  const iluminacao = Math.round((1 - Math.cos(2 * Math.PI * f)) / 2 * 100);
  return { fase: f, nome, icone, iluminacao };
}

export const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
export const DIAS_SEMANA_LONGO = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
