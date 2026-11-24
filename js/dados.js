// Acesso às fontes de dados (todas gratuitas e sem chave de API)
import { getJSON, comCache, store, norm, UF_NOMES, UF_POR_NOME, UF_POR_CODIGO } from './util.js';

export const API = {
  municipios: 'https://servicodados.ibge.gov.br/api/v1/localidades/municipios?view=nivelado',
  malhas: 'https://servicodados.ibge.gov.br/api/v3/malhas',
  geocode: 'https://geocoding-api.open-meteo.com/v1/search',
  previsao: 'https://api.open-meteo.com/v1/forecast',
  ar: 'https://air-quality-api.open-meteo.com/v1/air-quality',
  reverso: 'https://api.bigdatacloud.net/data/reverse-geocode-client',
  inmet: 'https://apiprevmet3.inmet.gov.br/avisos/ativos',
  inmetSite: 'https://alertas2.inmet.gov.br/',
  radar: 'https://api.rainviewer.com/public/weather-maps.json',
};

/* ======================= Municípios (IBGE) ======================= */
let municipios = null;
let carregando = null;

function lerMunicipio(m) {
  const id = m['municipio-id'] ?? m.id;
  const nome = m['municipio-nome'] ?? m.nome;
  const uf = m['UF-sigla'] ?? m.microrregiao?.mesorregiao?.UF?.sigla ?? m['regiao-imediata']?.['regiao-intermediaria']?.UF?.sigla;
  if (!id || !nome || !uf) return null;
  return { id: String(id), nome, uf };
}

export function carregarMunicipios() {
  if (municipios) return Promise.resolve(municipios);
  if (carregando) return carregando;
  carregando = (async () => {
    let lista = store.get('wc:municipios:v1');
    if (!Array.isArray(lista) || lista.length < 5000) {
      const dados = await getJSON(API.municipios, 30000);
      lista = dados.map(lerMunicipio).filter(Boolean);
      if (lista.length > 5000) store.set('wc:municipios:v1', lista);
    }
    municipios = lista.map((m) => ({ ...m, n: norm(m.nome) }));
    return municipios;
  })().catch((e) => { carregando = null; throw e; });
  return carregando;
}

export function buscarLocal(consulta) {
  if (!municipios) return [];
  let q = norm(consulta);
  let uf = null;
  const m = q.match(/^(.*?)[\s,\-/]+([a-z]{2})$/);
  if (m && UF_NOMES[m[2].toUpperCase()]) { q = m[1].trim(); uf = m[2].toUpperCase(); }
  if (q.length < 2) return [];
  const comeca = [], contem = [];
  for (const mu of municipios) {
    if (uf && mu.uf !== uf) continue;
    if (mu.n.startsWith(q)) comeca.push(mu); else if (mu.n.includes(q)) contem.push(mu);
  }
  const ord = (a, b) => a.n.length - b.n.length || a.n.localeCompare(b.n);
  return [...comeca.sort(ord), ...contem.sort(ord)].slice(0, 8);
}

export function municipioPorId(id) {
  return municipios?.find((m) => m.id === String(id)) || null;
}

export function municipioPorNome(nome, uf) {
  const n = norm(nome);
  return municipios?.find((m) => m.n === n && (!uf || m.uf === uf)) || null;
}

// Plano B quando o IBGE está fora do ar
export async function buscarOpenMeteo(consulta) {
  const url = `${API.geocode}?name=${encodeURIComponent(consulta)}&count=15&language=pt&format=json&countryCode=BR`;
  const dados = await getJSON(url);
  return (dados.results || []).filter((r) => r.country_code === 'BR').slice(0, 8)
    .map((r) => ({ id: null, nome: r.name, uf: UF_POR_NOME[norm(r.admin1)] || '', lat: r.latitude, lon: r.longitude }));
}

export async function coordenadas(cidade) {
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
  const e = res.find((r) => mesmoNome(r) && mesmoEstado(r) && /^PPL/.test(r.feature_code || ''))
    || res.find((r) => mesmoNome(r) && mesmoEstado(r))
    || res.find(mesmoEstado)
    || (!cidade.uf && (res.find(mesmoNome) || res[0]));
  if (!e) throw new Error('Não encontramos as coordenadas desta cidade.');
  const c = { lat: e.latitude, lon: e.longitude };
  if (cidade.id) { cache[cidade.id] = c; store.set('wc:coords', cache); }
  return { ...cidade, ...c };
}

/* ======================= Localização atual ======================= */
export function posicaoAtual() {
  return new Promise((ok, falha) => {
    if (!navigator.geolocation) { falha(new Error('Seu navegador não permite usar a localização.')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => falha(new Error(e.code === 1
        ? 'Você não permitiu o acesso à localização. Libere nas configurações do navegador.'
        : 'Não foi possível descobrir sua localização agora.')),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 },
    );
  });
}

// Descobre a cidade a partir das coordenadas
export async function cidadeDaPosicao(lat, lon) {
  let nome = null, uf = '';
  try {
    const r = await getJSON(`${API.reverso}?latitude=${lat}&longitude=${lon}&localityLanguage=pt`, 10000);
    if (r.countryCode && r.countryCode !== 'BR') {
      return { id: null, nome: r.city || r.locality || 'Minha localização', uf: '', lat, lon, foraDoBrasil: true };
    }
    nome = r.city || r.locality || null;
    uf = (r.principalSubdivisionCode || '').replace('BR-', '') || UF_POR_NOME[norm(r.principalSubdivision)] || '';
  } catch { /* segue sem nome */ }
  try { await carregarMunicipios(); } catch { /* ok */ }
  const m = nome ? municipioPorNome(nome, uf) : null;
  return { id: m?.id ?? null, nome: m?.nome ?? nome ?? 'Minha localização', uf: m?.uf ?? uf, lat, lon, local: true };
}

/* ======================= Previsão (Open-Meteo) ======================= */
const HORARIAS = [
  'temperature_2m', 'apparent_temperature', 'precipitation_probability', 'precipitation', 'weather_code',
  'uv_index', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'relative_humidity_2m',
  'visibility', 'pressure_msl', 'dew_point_2m', 'cloud_cover', 'is_day',
];
const DIARIAS = [
  'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'apparent_temperature_max', 'apparent_temperature_min',
  'precipitation_sum', 'precipitation_probability_max', 'uv_index_max', 'wind_speed_10m_max', 'wind_gusts_10m_max',
  'wind_direction_10m_dominant', 'sunrise', 'sunset', 'daylight_duration',
];
const ATUAIS = [
  'temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'is_day', 'precipitation', 'weather_code',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'pressure_msl', 'cloud_cover', 'uv_index', 'visibility', 'dew_point_2m',
];

export function previsao(lat, lon) {
  const p = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: 'auto', forecast_days: '8',
    current: ATUAIS.join(','), hourly: HORARIAS.join(','), daily: DIARIAS.join(','),
    minutely_15: 'precipitation', forecast_minutely_15: '12',
  });
  const chave = `wc:prev2:${(+lat).toFixed(2)},${(+lon).toFixed(2)}`;
  return comCache(chave, 20 * 60 * 1000, () => getJSON(`${API.previsao}?${p}`));
}

export function qualidadeAr(lat, lon) {
  const p = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: 'auto',
    current: 'us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,carbon_monoxide',
  });
  const chave = `wc:ar:${(+lat).toFixed(2)},${(+lon).toFixed(2)}`;
  return comCache(chave, 60 * 60 * 1000, () => getJSON(`${API.ar}?${p}`));
}

/* ======================= Malhas do IBGE (contornos) ======================= */
const malhaCache = new Map();
function malha(caminho, params) {
  const url = `${API.malhas}/${caminho}?formato=application/vnd.geo%2Bjson&qualidade=minima${params ? `&${params}` : ''}`;
  if (!malhaCache.has(url)) {
    malhaCache.set(url, getJSON(url, 45000).catch((e) => { malhaCache.delete(url); throw e; }));
  }
  return malhaCache.get(url);
}
export const contornoBrasil = () => malha('paises/BR');
export const contornoEstados = () => malha('paises/BR', 'intrarregiao=UF');
export const municipiosDoEstado = (codigoUF) => malha(`estados/${codigoUF}`, 'intrarregiao=municipio');

/* ======================= Alertas ======================= */
// Cada fonte devolve uma lista no formato comum:
// { id, fonte, fonteCor, titulo, severidade, cor, inicio, fim, riscos[], instrucoes[], geocodes[], poligonos[[ [lat,lon], ... ]], areaTexto }

export const FONTES_ALERTA = [
  { id: 'inmet', nome: 'INMET', descricao: 'Instituto Nacional de Meteorologia', site: API.inmetSite, cor: '#0b5394', ativa: true },
  { id: 'defesa-civil', nome: 'Defesa Civil', descricao: 'Defesa Civil Alerta (nacional e estaduais)', site: 'https://www.gov.br/mdr/pt-br/assuntos/protecao-e-defesa-civil', ativa: false, motivo: 'Os alertas são enviados por SMS, celular e WhatsApp, mas não há uma API pública para sites lerem.' },
  { id: 'cemaden', nome: 'Cemaden', descricao: 'Centro Nacional de Monitoramento e Alertas de Desastres Naturais', site: 'https://www.gov.br/cemaden/', ativa: false, motivo: 'Não publica os alertas em formato aberto que um site possa ler.' },
  { id: 'cptec', nome: 'CPTEC/INPE', descricao: 'Centro de Previsão de Tempo e Estudos Climáticos', site: 'https://www.cptec.inpe.br/', ativa: false, motivo: 'Não oferece uma lista aberta de avisos ativos.' },
  { id: 'privados', nome: 'Institutos privados', descricao: 'MetSul, Climatempo e outros', site: '', ativa: false, motivo: 'Exigem contrato ou chave paga para uso dos dados.' },
  { id: 'wmo', nome: 'OMM (WMO)', descricao: 'Centro de Informação de Tempo Severo da OMM', site: 'https://severeweather.wmo.int/', ativa: false, motivo: 'Para o Brasil, repassa os mesmos avisos do INMET.' },
];

const lista = (v) => (Array.isArray(v) ? v : v ? String(v).split(/\n|;(?=\s*[A-ZÁÉÍÓÚ])/) : [])
  .map((s) => String(s).trim()).filter(Boolean);

const CORES_INMET = { amarelo: '#FFD400', laranja: '#FF8C00', vermelho: '#E60000' };

function corINMET(a) {
  const hex = String(a.aviso_cor || '').trim();
  if (/^#?[0-9a-f]{6}$/i.test(hex)) return hex.startsWith('#') ? hex : `#${hex}`;
  const sev = norm(a.severidade);
  if (sev.includes('grande')) return CORES_INMET.vermelho;
  if (sev === 'perigo') return CORES_INMET.laranja;
  return CORES_INMET.amarelo;
}

function nivelSeveridade(sev) {
  const s = norm(sev);
  if (s.includes('grande')) return 3;
  if (s === 'perigo') return 2;
  return 1;
}

function dataINMET(data, hora, iso) {
  let d = null;
  if (iso) d = new Date(String(iso).replace(' ', 'T').replace(/\.\d+$/, ''));
  if ((!d || Number.isNaN(+d)) && data) d = new Date(`${data}T${hora || '00:00'}`);
  return d && !Number.isNaN(+d) ? d : null;
}

// Lê polígonos em formatos variados: WKT, "lat,lon lat,lon" (CAP), listas de pares, GeoJSON
export function lerPoligonos(v) {
  if (!v) return [];
  if (typeof v === 'object' && !Array.isArray(v) && v.type && v.coordinates) {
    const polys = v.type === 'Polygon' ? [v.coordinates] : v.type === 'MultiPolygon' ? v.coordinates : [];
    return polys.map((p) => p[0].map(([lon, lat]) => [lat, lon]));
  }
  const textos = Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : [typeof v === 'string' ? v : JSON.stringify(v)];
  const res = [];
  for (const t of textos) {
    for (const parte of String(t).split(/\)\s*\)\s*,|\|/)) {
      const nums = (parte.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      if (nums.length < 6) continue;
      const pares = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pares.push([nums[i], nums[i + 1]]);
      // Descobre a ordem: longitudes do Brasil ficam entre -74 e -28; latitudes entre -34 e 6
      const mediaA = pares.reduce((s, p) => s + p[0], 0) / pares.length;
      const mediaB = pares.reduce((s, p) => s + p[1], 0) / pares.length;
      const aEhLon = mediaA < mediaB;
      res.push(pares.map(([a, b]) => (aEhLon ? [b, a] : [a, b])));
    }
  }
  return res;
}

function normalizarINMET(a) {
  const codigos = Array.isArray(a.geocodes) ? a.geocodes.join(',') : String(a.geocodes ?? a.geocode ?? '');
  const geocodes = codigos.split(/\D+/).filter((c) => c.length >= 6);
  const estados = String(a.estados ?? '').split(/[^A-Za-z]+/).map((s) => s.toUpperCase()).filter((s) => UF_NOMES[s]);
  for (const g of geocodes) { const uf = UF_POR_CODIGO[g.slice(0, 2)]; if (uf && !estados.includes(uf)) estados.push(uf); }
  return {
    id: `inmet-${a.id ?? `${a.descricao}-${a.inicio}`}`,
    fonte: 'INMET',
    titulo: a.descricao || a.evento || 'Aviso meteorológico',
    severidade: a.severidade || 'Aviso',
    nivel: nivelSeveridade(a.severidade),
    cor: corINMET(a),
    inicio: dataINMET(a.data_inicio, a.hora_inicio, a.inicio),
    fim: dataINMET(a.data_fim, a.hora_fim, a.fim),
    riscos: lista(a.riscos),
    instrucoes: lista(a.instrucoes),
    geocodes,
    estados,
    poligonos: lerPoligonos(a.poligono ?? a.poligonos ?? a.polygon ?? a.area ?? null),
    areaTexto: Array.isArray(a.municipios) ? a.municipios.join(', ') : (a.municipios || ''),
    link: API.inmetSite,
  };
}

async function alertasINMET() {
  const dados = await comCache('wc:inmet', 5 * 60 * 1000, () => getJSON(API.inmet, 25000));
  const brutos = Array.isArray(dados) ? dados : [...(dados.hoje || []), ...(dados.futuro || [])];
  const vistos = new Set();
  return brutos.map(normalizarINMET).filter((a) => (vistos.has(a.id) ? false : vistos.add(a.id)));
}

// Busca todas as fontes ativas. Devolve { alertas, status: {fonteId: 'ok'|'erro'} }
export async function todosAlertas() {
  const status = {};
  const alertas = [];
  const fontes = [['inmet', alertasINMET]];
  await Promise.all(fontes.map(async ([id, fn]) => {
    try { alertas.push(...await fn()); status[id] = 'ok'; } catch (e) { console.warn(id, e); status[id] = 'erro'; }
  }));
  alertas.sort((a, b) => b.nivel - a.nivel);
  return { alertas, status };
}

export function alertaAfetaCidade(a, cidade) {
  if (cidade.id && a.geocodes.length) {
    const id7 = String(cidade.id), id6 = id7.slice(0, 6);
    return a.geocodes.some((c) => c === id7 || c === id6);
  }
  if (cidade.lat != null && a.poligonos.length) {
    return a.poligonos.some((p) => pontoNoPoligono(cidade.lat, cidade.lon, p));
  }
  const texto = norm(a.areaTexto);
  if (!texto) return false;
  const alvo = norm(cidade.nome);
  return texto.split(/[,;]/).some((parte) => {
    const p = parte.trim();
    return p === alvo || p.startsWith(`${alvo} -`) || p.startsWith(`${alvo} (`);
  });
}

export function pontoNoPoligono(lat, lon, anel) {
  let dentro = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [yi, xi] = anel[i], [yj, xj] = anel[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

/* ======================= Grade para os mapas ======================= */
export const CAMPOS_MAPA = 'temperature_2m,apparent_temperature,uv_index,wind_speed_10m,wind_direction_10m,precipitation,relative_humidity_2m,visibility,pressure_msl';

// Busca a previsão das próximas ~30 horas para uma lista de pontos (em lotes)
export async function gradeMapa(pontos) {
  const chave = `wc:grade:${pontos.length}:${pontos[0]?.join()}`;
  return comCache(chave, 45 * 60 * 1000, async () => {
    const lotes = [];
    for (let i = 0; i < pontos.length; i += 100) lotes.push(pontos.slice(i, i + 100));
    const resultados = [];
    let proximo = 0;
    async function trabalhador() {
      while (proximo < lotes.length) {
        const k = proximo++;
        const lote = lotes[k];
        const p = new URLSearchParams({
          latitude: lote.map((q) => q[0].toFixed(2)).join(','),
          longitude: lote.map((q) => q[1].toFixed(2)).join(','),
          hourly: CAMPOS_MAPA, timezone: 'GMT', forecast_days: '2', past_hours: '1',
        });
        const r = await getJSON(`${API.previsao}?${p}`, 40000);
        resultados[k] = Array.isArray(r) ? r : [r];
      }
    }
    await Promise.all([trabalhador(), trabalhador(), trabalhador()]);
    const todos = resultados.flat();
    const tempo = todos[0].hourly.time;
    const campos = CAMPOS_MAPA.split(',');
    // Formato compacto: { tempo: [...], valores: { campo: [ [ponto0 por hora...], ... ] } }
    const valores = {};
    for (const c of campos) valores[c] = todos.map((t) => t.hourly[c]);
    return { tempo, valores };
  });
}

/* ======================= Radar (RainViewer) ======================= */
export async function radarQuadros() {
  const r = await getJSON(API.radar, 15000);
  const quadros = [...(r.radar?.past || []), ...(r.radar?.nowcast || [])];
  return { host: r.host || 'https://tilecache.rainviewer.com', quadros };
}
