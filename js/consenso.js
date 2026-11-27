// Previsão por consenso: junta vários modelos e institutos e calcula um valor único para cada hora e cada dia.
//
// Como funciona
// - Open-Meteo entrega, numa só chamada, a previsão de vários modelos globais (ECMWF, GFS, ICON, UKMO...).
// - MET Norway (Instituto Meteorológico da Noruega) entra como fonte independente.
// - INMET entra com as temperaturas máximas e mínimas oficiais dos próximos dias (por município).
// - Para temperatura, umidade, vento, pressão e nuvens usamos a MEDIANA PONDERADA: um modelo muito
//   diferente dos outros não puxa o resultado. Para a chuva usamos a média ponderada sem os extremos.
// - A chance de chuva é a fração das fontes que preveem chuva, combinada com a probabilidade por conjunto
//   (ensemble) da Open-Meteo.
import { getJSON, comCache, store, intensidadeMm } from './util.js';

const OM = 'https://api.open-meteo.com/v1/forecast';
const METNO = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const INMET_PREV = 'https://apiprevmet3.inmet.gov.br/previsao/';
export const DIAS = 10;

// Modelos globais que cobrem todo o Brasil. O peso reflete a qualidade média de cada um em avaliações
// internacionais (ECMWF e UKMO costumam errar menos). Todos são gratuitos pela Open-Meteo, sem chave.
export const MODELOS = [
  { id: 'ecmwf_ifs025', nome: 'ECMWF IFS', inst: 'Centro Europeu (ECMWF)', peso: 1.5 },
  { id: 'ecmwf_aifs025_single', nome: 'ECMWF AIFS', inst: 'Centro Europeu (ECMWF), modelo com IA', peso: 1.2 },
  { id: 'ukmo_seamless', nome: 'UM Global', inst: 'Met Office (Reino Unido)', peso: 1.2 },
  { id: 'icon_seamless', nome: 'ICON', inst: 'DWD (Alemanha)', peso: 1.1 },
  { id: 'gfs_seamless', nome: 'GFS', inst: 'NOAA (Estados Unidos)', peso: 1.0 },
  { id: 'meteofrance_seamless', nome: 'ARPEGE', inst: 'Météo-France (França)', peso: 1.0 },
  { id: 'gem_seamless', nome: 'GEM', inst: 'Serviço Meteorológico do Canadá', peso: 0.9 },
  { id: 'jma_seamless', nome: 'GSM', inst: 'Agência Meteorológica do Japão', peso: 0.9 },
  { id: 'kma_seamless', nome: 'GDPS', inst: 'Administração Meteorológica da Coreia', peso: 0.9 },
  { id: 'bom_access_global', nome: 'ACCESS-G', inst: 'Bureau of Meteorology (Austrália)', peso: 0.8 },
  { id: 'cma_grapes_global', nome: 'GRAPES', inst: 'Administração Meteorológica da China', peso: 0.7 },
];
// Usados se a Open-Meteo recusar a lista completa (por exemplo, se um modelo for renomeado)
const MODELOS_SEGUROS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'gem_seamless', 'jma_seamless'];

export const OUTRAS_FONTES = [
  { id: 'metno', nome: 'MET Norway', inst: 'Instituto Meteorológico da Noruega', peso: 1.0 },
  { id: 'inmet', nome: 'INMET', inst: 'Instituto Nacional de Meteorologia (Brasil)', peso: 1.5, obs: 'máximas e mínimas diárias' },
  { id: 'cptec', nome: 'CPTEC/INPE', inst: 'Centro de Previsão de Tempo e Estudos Climáticos', indisponivel: 'O serviço do CPTEC não permite leitura direta por sites (sem CORS).' },
];

// Variáveis combinadas por consenso
const H_CONSENSO = ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'dew_point_2m', 'precipitation',
  'weather_code', 'cloud_cover', 'pressure_msl', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'];
const D_CONSENSO = ['temperature_2m_max', 'temperature_2m_min', 'apparent_temperature_max', 'apparent_temperature_min',
  'precipitation_sum', 'weather_code', 'wind_speed_10m_max', 'wind_gusts_10m_max'];

// Variáveis que vêm só da previsão principal (melhor modelo para o local, escolhido pela Open-Meteo)
const H_BASE = [...H_CONSENSO, 'precipitation_probability', 'uv_index', 'visibility', 'is_day',
  'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high'];
const D_BASE = [...D_CONSENSO, 'apparent_temperature_max', 'precipitation_probability_max', 'uv_index_max',
  'wind_direction_10m_dominant', 'sunrise', 'sunset', 'daylight_duration'];
const ATUAIS = ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'is_day', 'precipitation', 'weather_code',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'pressure_msl', 'cloud_cover', 'uv_index', 'visibility', 'dew_point_2m'];

/* ======================= Estatística ======================= */
function medianaPonderada(votos) {
  if (!votos.length) return null;
  const v = [...votos].sort((a, b) => a.v - b.v);
  const total = v.reduce((s, x) => s + x.w, 0);
  let acc = 0;
  for (let i = 0; i < v.length; i++) {
    acc += v[i].w;
    if (acc >= total / 2) {
      // Exatamente no meio: média dos dois vizinhos
      if (Math.abs(acc - total / 2) < 1e-9 && v[i + 1]) return (v[i].v + v[i + 1].v) / 2;
      return v[i].v;
    }
  }
  return v[v.length - 1].v;
}
function mediaAparada(votos) {
  if (!votos.length) return null;
  let v = [...votos].sort((a, b) => a.v - b.v);
  if (v.length >= 5) v = v.slice(1, -1); // tira o maior e o menor
  const total = v.reduce((s, x) => s + x.w, 0);
  return v.reduce((s, x) => s + x.v * x.w, 0) / total;
}
function mediaAngular(votos) {
  if (!votos.length) return null;
  let x = 0, y = 0;
  for (const { v, w } of votos) { x += Math.cos((v * Math.PI) / 180) * w; y += Math.sin((v * Math.PI) / 180) * w; }
  if (Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6) return votos[0].v;
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
const fracao = (votos, teste) => {
  const total = votos.reduce((s, x) => s + x.w, 0);
  return total ? votos.filter((x) => teste(x.v)).reduce((s, x) => s + x.w, 0) / total : null;
};

// Códigos de tempo da OMM em ordem de "gravidade", para tirar a mediana entre os modelos
const ORDEM_CODIGO = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 80, 63, 81, 66, 65, 67, 71, 73, 85, 75, 77, 86, 82, 95, 96, 99];
function codigoConsenso(votos) {
  const comRank = votos.map(({ v, w }) => ({ v: Math.max(0, ORDEM_CODIGO.indexOf(v)), w })).filter((x) => x.v >= 0);
  const r = medianaPonderada(comRank);
  return r == null ? null : ORDEM_CODIGO[Math.round(r)];
}
// Deixa o ícone coerente com a chuva e as nuvens do próprio consenso
function codigoCoerente(code, chuva, prob, nuvens, porHora = true) {
  if (code == null) return code;
  const limite = porHora ? 0.1 : 1;
  const chove = code >= 51;
  const deNuvens = nuvens == null ? 2 : nuvens < 20 ? 0 : nuvens < 45 ? 1 : nuvens < 80 ? 2 : 3;
  if (chove && code < 95 && (chuva ?? 0) < limite && (prob ?? 0) < 40) return Math.max(deNuvens, 2);
  if (!chove && code !== 45 && code !== 48 && (chuva ?? 0) >= (porHora ? 0.5 : 5)) {
    if (porHora) return [61, 61, 63, 65, 65][intensidadeMm(chuva)];
    return (chuva ?? 0) >= 25 ? 65 : 80;
  }
  // Por hora, o nome segue o volume (mesma regra da cena animada): garoa só abaixo de 1 mm/h,
  // "chuva fraca/chuva/chuva forte" e "pancadas" conforme os mm/h
  if (porHora && chove && code < 95 && (chuva ?? 0) >= limite) {
    const n = intensidadeMm(chuva);
    const garoa = code >= 51 && code <= 57;
    const congelante = code === 56 || code === 57 || code === 66 || code === 67;
    if (garoa && chuva < 1) return congelante ? 56 : chuva < 0.3 ? 51 : 53;
    if (congelante) return n >= 2 ? 67 : 66;
    if (code >= 71 && code <= 77) return code; // neve: mantém
    if (code >= 85 && code <= 86) return code;
    if (code >= 80 && code <= 82) return [80, 80, 81, 82, 82][n];
    return [61, 61, 63, 65, 65][n];
  }
  return code;
}

// Mediana ponderada para a maioria; regras próprias para chuva, direção do vento e código do tempo
function combinar(variavel, votos) {
  if (!votos.length) return null;
  if (variavel === 'precipitation' || variavel === 'precipitation_sum') return mediaAparada(votos);
  if (variavel.startsWith('wind_direction')) return mediaAngular(votos);
  if (variavel === 'weather_code') return codigoConsenso(votos);
  return medianaPonderada(votos);
}

// Faixa da maioria das fontes (sem os extremos: um quinto de cada ponta), para mostrar a concordância
function faixa(votos) {
  let v = votos.map((x) => x.v).sort((a, b) => a - b);
  const corte = Math.floor(v.length / 5);
  if (corte) v = v.slice(corte, -corte);
  return v.length ? [v[0], v[v.length - 1]] : null;
}

/* ======================= Fontes ======================= */
async function pedirOM(params) {
  const r = await fetch(`${OM}?${new URLSearchParams(params)}`);
  let corpo = null;
  try { corpo = await r.json(); } catch { /* sem corpo */ }
  if (!r.ok || corpo?.error) {
    const e = new Error(corpo?.reason || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return corpo;
}

function base(lat, lon) {
  return pedirOM({
    latitude: lat, longitude: lon, timezone: 'auto', forecast_days: String(DIAS),
    current: ATUAIS.join(','), hourly: H_BASE.join(','), daily: [...new Set(D_BASE)].join(','),
    minutely_15: 'precipitation', forecast_minutely_15: '12',
  });
}

async function variosModelos(lat, lon) {
  const params = (lista) => ({
    latitude: lat, longitude: lon, timezone: 'auto', forecast_days: String(DIAS),
    hourly: H_CONSENSO.join(','), daily: D_CONSENSO.join(','), models: lista.join(','),
  });
  let lista = MODELOS.map((m) => m.id);
  try {
    return { lista, dados: await pedirOM(params(lista)) };
  } catch (e) {
    if (e.status !== 400) throw e;
    // Algum modelo foi recusado: tira os citados na mensagem de erro, ou usa a lista segura
    const citados = lista.filter((m) => e.message.includes(m));
    lista = citados.length ? lista.filter((m) => !citados.includes(m)) : MODELOS_SEGUROS;
    console.warn('Open-Meteo recusou modelos; tentando com', lista, e.message);
    return { lista, dados: await pedirOM(params(lista)) };
  }
}

// MET Norway: horário UTC, vento em m/s, símbolos próprios
const SIMBOLO_MET = [
  [/thunder/, 95], [/heavyrainshowers/, 82], [/lightrainshowers/, 80], [/rainshowers/, 81],
  [/heavyrain/, 65], [/lightrain/, 61], [/rain/, 63], [/sleet/, 66], [/heavysnow/, 75], [/lightsnow/, 71], [/snow/, 73],
  [/fog/, 45], [/cloudy/, 3], [/partlycloudy/, 2], [/fair/, 1], [/clearsky/, 0],
];
const codigoMET = (s) => {
  if (!s) return null;
  const nome = s.replace(/_(day|night|polartwilight)$/, '');
  for (const [re, c] of SIMBOLO_MET) if (re.test(nome)) return c;
  return null;
};
async function metNorway(lat, lon) {
  // A MET Norway pede no máximo 4 casas decimais nas coordenadas e cache local
  const la = (+lat).toFixed(3), lo = (+lon).toFixed(3);
  return comCache(`wc:met:${la},${lo}`, 30 * 60 * 1000, async () => {
    const d = await getJSON(`${METNO}?lat=${la}&lon=${lo}`, 15000);
    // Guarda só o necessário (o arquivo original é grande)
    return (d.properties?.timeseries || []).map((t) => {
      const i = t.data.instant.details;
      const h1 = t.data.next_1_hours, h6 = t.data.next_6_hours;
      return {
        t: t.time,
        temp: i.air_temperature, ur: i.relative_humidity, p: i.air_pressure_at_sea_level,
        vento: i.wind_speed != null ? i.wind_speed * 3.6 : null, dir: i.wind_from_direction, nuvens: i.cloud_area_fraction,
        chuva1: h1?.details?.precipitation_amount ?? null, cod1: codigoMET(h1?.summary?.symbol_code),
        chuva6: h6?.details?.precipitation_amount ?? null, cod6: codigoMET(h6?.summary?.symbol_code),
      };
    });
  });
}

// INMET: previsão por município (código IBGE). Lê máximas e mínimas de cada dia (manhã, tarde e noite).
async function inmet(geocode) {
  return comCache(`wc:inmetprev:${geocode}`, 60 * 60 * 1000, async () => {
    const d = await getJSON(`${INMET_PREV}${geocode}`, 15000);
    const raiz = d?.[geocode] || d?.[String(geocode)] || Object.values(d || {})[0] || {};
    const dias = {};
    for (const [chave, valor] of Object.entries(raiz)) {
      const m = chave.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (!m) continue;
      const maximas = [], minimas = [];
      (function coletar(o) {
        if (!o || typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) {
          if (k === 'temp_max' && Number.isFinite(+v) && v !== '') maximas.push(+v);
          else if (k === 'temp_min' && Number.isFinite(+v) && v !== '') minimas.push(+v);
          else if (typeof v === 'object') coletar(v);
        }
      })(valor);
      if (maximas.length || minimas.length) {
        dias[`${m[3]}-${m[2]}-${m[1]}`] = {
          max: maximas.length ? Math.max(...maximas) : null,
          min: minimas.length ? Math.min(...minimas) : null,
        };
      }
    }
    if (!Object.keys(dias).length) throw new Error('INMET sem previsão para este município');
    return dias;
  });
}


/* ======================= Plano B: previsão só com a MET Norway ======================= */
// Quando a Open-Meteo recusa (limite de consultas da rede do usuário), monta a mesma estrutura
// que a Open-Meteo devolveria a partir da MET Norway, para a página abrir normalmente.
const FUSO_UF = { 12: -5, 11: -4, 13: -4, 14: -4, 50: -4, 51: -4 }; // AC; RO, AM, RR, MS, MT; demais -3
function fusoHoras(lat, lon, geocode) {
  const uf = /^\d{7}$/.test(String(geocode || '')) ? +String(geocode).slice(0, 2) : null;
  if (uf != null) return FUSO_UF[uf] ?? -3;
  if (lon < -66 && lat > -11.5) return -5;
  if (lon < -52 && !(lat > -2 && lon > -54.5)) return -4;
  return -3;
}
// Nascer e pôr do sol (fórmula da NOAA, precisão de ~1 min), em horas UTC
function solUTC(diaIso, lat, lon) {
  const d = new Date(`${diaIso}T12:00:00Z`);
  const n = Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
  const g = (2 * Math.PI / 365) * (n - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const dec = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const fi = (lat * Math.PI) / 180;
  const ha = Math.acos(Math.min(1, Math.max(-1, Math.cos((90.833 * Math.PI) / 180) / (Math.cos(fi) * Math.cos(dec)) - Math.tan(fi) * Math.tan(dec)))) * 180 / Math.PI;
  const nasce = (720 - 4 * (lon + ha) - eq) / 60, poe = (720 - 4 * (lon - ha) - eq) / 60;
  return { nasce, poe };
}
function baseDeMET(serie, lat, lon, geocode) {
  if (!serie?.length) throw new Error('MET Norway sem dados');
  const fuso = fusoHoras(lat, lon, geocode), off = fuso * 3600;
  const pts = serie.map((x) => ({ ...x, ms: Date.parse(x.t) })).filter((x) => x.temp != null);
  const ini = pts[0].ms, fim = pts[pts.length - 1].ms;
  const H = Object.fromEntries(H_BASE.map((v) => [v, []]));
  H.time = [];
  const interp = (campo, ms, angular = false) => {
    let k = pts.findIndex((p) => p.ms >= ms);
    if (k <= 0) return pts[Math.max(0, k)]?.[campo] ?? null;
    const a = pts[k - 1], b2 = pts[k];
    if (a[campo] == null || b2[campo] == null) return a[campo] ?? b2[campo] ?? null;
    const f = (ms - a.ms) / (b2.ms - a.ms);
    if (angular) { let d = b2[campo] - a[campo]; if (d > 180) d -= 360; if (d < -180) d += 360; return (a[campo] + d * f + 360) % 360; }
    return a[campo] + (b2[campo] - a[campo]) * f;
  };
  // Chuva e código de cada hora: do passo de 1 h ou, mais adiante, do passo de 6 h dividido por 6
  const chuvaEm = (ms) => {
    const exata = pts.find((p) => p.ms === ms && p.chuva1 != null);
    if (exata) return { mm: exata.chuva1, cod: exata.cod1 };
    const bloco = [...pts].reverse().find((p) => p.ms <= ms && ms < p.ms + 6 * 3600000 && p.chuva6 != null);
    return bloco ? { mm: bloco.chuva6 / 6, cod: bloco.cod6 } : { mm: null, cod: null };
  };
  const dias = new Set();
  for (let ms = ini; ms <= fim; ms += 3600000) {
    const t = horaLocal(new Date(ms).toISOString(), off);
    H.time.push(t); dias.add(t.slice(0, 10));
    const temp = interp('temp', ms), ur = interp('ur', ms);
    const { mm, cod } = chuvaEm(ms);
    const a = 17.62, bb = 243.12, gm = Math.log(Math.max(1, ur ?? 70) / 100) + (a * temp) / (bb + temp);
    const sol = solUTC(t.slice(0, 10), lat, lon);
    const hUTC = new Date(ms).getUTCHours() + new Date(ms).getUTCMinutes() / 60;
    const dia = ((hUTC - sol.nasce + 24) % 24) < ((sol.poe - sol.nasce + 24) % 24);
    H.temperature_2m.push(temp); H.apparent_temperature.push(temp); H.relative_humidity_2m.push(ur);
    H.dew_point_2m.push((bb * gm) / (a - gm)); H.precipitation.push(mm); H.weather_code.push(cod ?? (interp('nuvens', ms) > 80 ? 3 : interp('nuvens', ms) > 40 ? 2 : 1));
    H.cloud_cover.push(interp('nuvens', ms)); H.pressure_msl.push(interp('p', ms)); H.wind_speed_10m.push(interp('vento', ms));
    H.wind_direction_10m.push(interp('dir', ms, true)); H.wind_gusts_10m.push(interp('vento', ms) != null ? interp('vento', ms) * 1.5 : null);
    H.precipitation_probability.push(null); H.uv_index.push(null); H.visibility.push(null); H.is_day.push(dia ? 1 : 0);
    H.cloud_cover_low.push(null); H.cloud_cover_mid.push(null); H.cloud_cover_high.push(null);
  }
  const D = Object.fromEntries([...new Set(D_BASE)].map((v) => [v, []]));
  D.time = [...dias].filter((d, k) => k === 0 || H.time.filter((t) => t.startsWith(d)).length >= 18); // hoje entra mesmo incompleto
  for (const dia of D.time) {
    for (const v of Object.keys(D)) if (v !== 'time') D[v].push(null);
    const i = D.time.indexOf(dia), sol = solUTC(dia, lat, lon);
    const hhmm = (h) => { const x = ((h + fuso + 24) % 24); return `${dia}T${pad(Math.floor(x))}:${pad(Math.floor((x % 1) * 60))}`; };
    D.sunrise[i] = hhmm(sol.nasce); D.sunset[i] = hhmm(sol.poe);
    D.daylight_duration[i] = ((sol.poe - sol.nasce + 24) % 24) * 3600;
    const ix = H.time.map((t, k) => (t.startsWith(dia) ? k : -1)).filter((k) => k >= 0);
    const cods = ix.map((k) => H.weather_code[k]).filter((c) => c != null);
    D.weather_code[i] = cods.length ? Math.max(...cods) : null;
    D.wind_direction_10m_dominant[i] = H.wind_direction_10m[ix[Math.floor(ix.length / 2)]];
    // Valores do dia a partir das horas disponíveis (hoje começa agora; os últimos dias vêm de passos de 6 h)
    const vals = (c) => ix.map((k) => H[c][k]).filter((x) => x != null);
    const ext = (cd, ch, f) => { const v = vals(ch); if (v.length) D[cd][i] = f(...v); };
    ext('temperature_2m_max', 'temperature_2m', Math.max); ext('temperature_2m_min', 'temperature_2m', Math.min);
    ext('apparent_temperature_max', 'apparent_temperature', Math.max); ext('apparent_temperature_min', 'apparent_temperature', Math.min);
    ext('wind_speed_10m_max', 'wind_speed_10m', Math.max); ext('wind_gusts_10m_max', 'wind_gusts_10m', Math.max);
    const mm = vals('precipitation'); if (mm.length) D.precipitation_sum[i] = Math.round(mm.reduce((x, y) => x + y, 0) * 10) / 10;
  }
  const agoraMs = Math.floor(Date.now() / 3600000) * 3600000;
  const tAgora = horaLocal(new Date(Math.max(ini, Math.min(fim, agoraMs))).toISOString(), off);
  const k = Math.max(0, H.time.indexOf(tAgora));
  const current = { time: H.time[k] };
  for (const v of ATUAIS) current[v] = H[v]?.[k] ?? null;
  return { latitude: lat, longitude: lon, utc_offset_seconds: off, timezone: `GMT${fuso}`, current, hourly: H, daily: D, soMET: true };
}

/* ======================= Combinação ======================= */
const pad = (n) => String(n).padStart(2, '0');
function horaLocal(isoUtc, offsetSeg) {
  const d = new Date(Date.parse(isoUtc) + offsetSeg * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:00`;
}

// Organiza os dados da MET Norway por hora local e por dia local
function prepararMET(serie, offset) {
  const porHora = {};
  const porDia = {};
  for (const s of serie) {
    const h = horaLocal(s.t, offset);
    const temHora = s.chuva1 != null || s.cod1 != null;
    porHora[h] = {
      temperature_2m: s.temp, relative_humidity_2m: s.ur, pressure_msl: s.p, wind_speed_10m: s.vento,
      wind_direction_10m: s.dir, cloud_cover: s.nuvens,
      precipitation: temHora ? s.chuva1 : null, weather_code: temHora ? s.cod1 : null,
    };
    const dia = h.slice(0, 10);
    const d = (porDia[dia] ||= { temps: [], chuva: 0, horasChuva: 0, codigos: [], horasTemp: 0 });
    if (s.temp != null) { d.temps.push(s.temp); if (temHora) d.horasTemp++; }
    if (temHora) { d.chuva += s.chuva1 || 0; d.horasChuva += 1; if (s.cod1 != null) d.codigos.push(s.cod1); }
    else if (s.chuva6 != null) { d.chuva += s.chuva6; d.horasChuva += 6; if (s.cod6 != null) d.codigos.push(s.cod6); }
  }
  const diario = {};
  for (const [dia, d] of Object.entries(porDia)) {
    // Só usa o dia quando a MET cobre quase todas as horas dele
    const completo = d.horasChuva >= 22;
    diario[dia] = {
      temperature_2m_max: d.horasTemp >= 20 ? Math.max(...d.temps) : null,
      temperature_2m_min: d.horasTemp >= 20 ? Math.min(...d.temps) : null,
      precipitation_sum: completo ? d.chuva : null,
    };
  }
  return { porHora, diario };
}

function montarConsenso(b, multi, listaModelos, met, inm) {
  const pesoModelo = Object.fromEntries(MODELOS.map((m) => [m.id, m.peso]));
  const ativos = listaModelos.filter((id) => multi?.hourly && multi.hourly[`temperature_2m_${id}`]?.some((v) => v != null));
  const pesoMet = OUTRAS_FONTES.find((f) => f.id === 'metno').peso;
  const pesoInmet = OUTRAS_FONTES.find((f) => f.id === 'inmet').peso;
  const metP = met ? prepararMET(met, b.utc_offset_seconds || 0) : null;

  const out = structuredClone(b);
  const H = out.hourly;
  const idxMulti = multi?.hourly ? Object.fromEntries(multi.hourly.time.map((t, i) => [t, i])) : {};
  H.n_fontes = H.time.map(() => 0);
  H.prob_modelos = H.time.map(() => null);

  const votosHora = (v, t) => {
    const votos = [];
    const k = idxMulti[t];
    if (k != null) {
      for (const id of ativos) {
        const val = multi.hourly[`${v}_${id}`]?.[k];
        if (val != null) votos.push({ v: val, w: pesoModelo[id] });
      }
    }
    const m = metP?.porHora[t]?.[v];
    if (m != null) votos.push({ v: m, w: pesoMet });
    return votos;
  };

  H.time.forEach((t, i) => {
    let nMax = 0;
    for (const v of H_CONSENSO) {
      if (v === 'weather_code') continue;
      const votos = votosHora(v, t);
      if (!votos.length) continue;
      H[v][i] = combinar(v, votos);
      if (v === 'temperature_2m') nMax = votos.length;
      if (v === 'precipitation') {
        const f = fracao(votos, (x) => x >= 0.1);
        H.prob_modelos[i] = f;
        const ens = b.hourly.precipitation_probability?.[i];
        // Probabilidade final: metade "quantas fontes preveem chuva", metade a probabilidade por conjunto
        H.precipitation_probability[i] = Math.round(ens != null ? (f * 100 + ens) / 2 : f * 100);
      }
    }
    const cods = votosHora('weather_code', t);
    if (cods.length) {
      H.weather_code[i] = codigoCoerente(codigoConsenso(cods), H.precipitation[i], H.precipitation_probability[i], H.cloud_cover[i]);
    }
    H.n_fontes[i] = nMax;
  });

  // ---- Diário ----
  const D = out.daily;
  const idxMultiD = multi?.daily ? Object.fromEntries(multi.daily.time.map((t, i) => [t, i])) : {};
  const faixas = [];
  D.time.forEach((dia, i) => {
    const k = idxMultiD[dia];
    const votosDia = (v) => {
      const votos = [];
      if (k != null) for (const id of ativos) {
        const val = multi.daily[`${v}_${id}`]?.[k];
        if (val != null) votos.push({ v: val, w: pesoModelo[id], id });
      }
      const m = metP?.diario[dia]?.[v];
      if (m != null) votos.push({ v: m, w: pesoMet, id: 'metno' });
      if (inm?.[dia]) {
        if (v === 'temperature_2m_max' && inm[dia].max != null) votos.push({ v: inm[dia].max, w: pesoInmet, id: 'inmet' });
        if (v === 'temperature_2m_min' && inm[dia].min != null) votos.push({ v: inm[dia].min, w: pesoInmet, id: 'inmet' });
      }
      return votos;
    };
    const info = { n: 0 };
    for (const v of D_CONSENSO) {
      if (v === 'weather_code') continue;
      const votos = votosDia(v);
      if (!votos.length) continue;
      D[v][i] = combinar(v, votos);
      if (v === 'temperature_2m_max') { info.max = faixa(votos); info.n = votos.length; info.fontes = votos.map((x) => x.id); }
      if (v === 'temperature_2m_min') info.min = faixa(votos);
      if (v === 'precipitation_sum') {
        const f = fracao(votos, (x) => x >= 1);
        info.chuvaFrac = f;
        info.chuva = faixa(votos);
        const ens = b.daily.precipitation_probability_max?.[i];
        D.precipitation_probability_max[i] = Math.round(ens != null ? (f * 100 + ens) / 2 : f * 100);
      }
    }
    // A mínima nunca pode ficar acima da máxima depois do consenso
    if (D.temperature_2m_min[i] > D.temperature_2m_max[i]) {
      [D.temperature_2m_min[i], D.temperature_2m_max[i]] = [D.temperature_2m_max[i], D.temperature_2m_min[i]];
    }
    const cods = votosDia('weather_code');
    if (cods.length) {
      D.weather_code[i] = codigoCoerente(codigoConsenso(cods), D.precipitation_sum[i], D.precipitation_probability_max[i], null, false);
    }
    const amplitude = info.max ? info.max[1] - info.max[0] : 0;
    const desacordoChuva = info.chuvaFrac != null && info.chuvaFrac > 0.25 && info.chuvaFrac < 0.75;
    info.concordancia = info.n < 2 ? null : amplitude <= 2.5 && !desacordoChuva ? 'alta' : amplitude <= 5 ? 'média' : 'baixa';
    faixas.push(info);
  });

  // ---- Coerência entre o diário e o hora a hora ----
  // O consenso diário (média aparada dos totais e máximas de cada modelo) não bate exatamente com a soma
  // ou o máximo do consenso hora a hora. Para a página nunca mostrar dois números diferentes para a mesma
  // coisa (ex.: chuva do dia no cartão × total no gráfico), os valores do dia passam a vir das horas.
  for (let i = 0; i < H.precipitation.length; i++) if (H.precipitation[i] != null) H.precipitation[i] = Math.round(H.precipitation[i] * 10) / 10;
  const horasDoDia = new Map();
  H.time.forEach((t, i) => { const dia = t.slice(0, 10); if (!horasDoDia.has(dia)) horasDoDia.set(dia, []); horasDoDia.get(dia).push(i); });
  const valores = (campo, ix) => ix.map((i) => H[campo]?.[i]).filter((v) => v != null && !Number.isNaN(v));
  D.time.forEach((dia, i) => {
    const ix = horasDoDia.get(dia) || [];
    if (ix.length < 23) return; // dia incompleto no hora a hora: fica o consenso diário
    const chuva = valores('precipitation', ix);
    if (chuva.length >= 23) D.precipitation_sum[i] = Math.round(chuva.reduce((a, b) => a + b, 0) * 10) / 10;
    const extremo = (campoD, campoH, fn) => { const v = valores(campoH, ix); if (v.length >= 20 && D[campoD]) D[campoD][i] = fn(...v); };
    extremo('temperature_2m_max', 'temperature_2m', Math.max);
    extremo('temperature_2m_min', 'temperature_2m', Math.min);
    extremo('apparent_temperature_max', 'apparent_temperature', Math.max);
    extremo('apparent_temperature_min', 'apparent_temperature', Math.min);
    extremo('wind_speed_10m_max', 'wind_speed_10m', Math.max);
    extremo('wind_gusts_10m_max', 'wind_gusts_10m', Math.max);
    extremo('precipitation_probability_max', 'precipitation_probability', Math.max);
    extremo('uv_index_max', 'uv_index', Math.max);
    // A faixa "na maioria das fontes" sempre contém o valor mostrado
    const f = faixas[i];
    const incluir = (fx, v) => (fx && v != null ? [Math.min(fx[0], v), Math.max(fx[1], v)] : fx);
    if (f) { f.max = incluir(f.max, D.temperature_2m_max[i]); f.min = incluir(f.min, D.temperature_2m_min[i]); f.chuva = incluir(f.chuva, D.precipitation_sum[i]); }
    if (D.weather_code[i] != null) {
      D.weather_code[i] = codigoCoerente(D.weather_code[i], D.precipitation_sum[i], D.precipitation_probability_max[i], null, false);
    }
  });

  // ---- Agora: valor de cada fonte interpolado para o horário atual ----
  const C = out.current;
  const tAgora = Date.parse(`${C.time}:00Z`);
  const i0 = H.time.findLastIndex((t) => Date.parse(`${t}:00Z`) <= tAgora);
  const agora = { n: 0 };
  if (i0 >= 0 && i0 + 1 < H.time.length) {
    const f = (tAgora - Date.parse(`${H.time[i0]}:00Z`)) / 3600000;
    const tA = H.time[i0], tB = H.time[i0 + 1];
    const interp = (a, b2) => (a == null ? b2 : b2 == null ? a : a + (b2 - a) * f);
    for (const v of H_CONSENSO) {
      if (v === 'weather_code' || v === 'precipitation') continue;
      const votos = [];
      const kA = idxMulti[tA], kB = idxMulti[tB];
      if (kA != null) for (const id of ativos) {
        const a = multi.hourly[`${v}_${id}`]?.[kA], b2 = multi.hourly[`${v}_${id}`]?.[kB];
        const val = v.startsWith('wind_direction') ? (a ?? b2) : interp(a, b2);
        if (val != null) votos.push({ v: val, w: pesoModelo[id] });
      }
      const mA = metP?.porHora[tA]?.[v], mB = metP?.porHora[tB]?.[v];
      const mv = v.startsWith('wind_direction') ? (mA ?? mB) : interp(mA, mB);
      if (mv != null) votos.push({ v: mv, w: pesoMet });
      if (!votos.length) continue;
      C[v] = combinar(v, votos);
      if (v === 'temperature_2m') { agora.n = votos.length; agora.temp = faixa(votos); }
    }
    const iPerto = f < 0.5 ? i0 : i0 + 1;
    C.precipitation = H.precipitation[iPerto];
    C.weather_code = H.weather_code[iPerto] ?? C.weather_code;
  }

  // A temperatura de agora nunca fica fora da máxima e da mínima de hoje
  if (C.temperature_2m != null && D.time[0] === String(C.time || '').slice(0, 10)) {
    if (D.temperature_2m_max[0] != null && C.temperature_2m > D.temperature_2m_max[0]) D.temperature_2m_max[0] = C.temperature_2m;
    if (D.temperature_2m_min[0] != null && C.temperature_2m < D.temperature_2m_min[0]) D.temperature_2m_min[0] = C.temperature_2m;
  }

  // Lista de fontes para mostrar ao usuário
  const hojeIdx = idxMultiD[D.time[0]];
  const fontes = MODELOS.map((m) => {
    const ok = ativos.includes(m.id);
    const dias = ok ? multi.daily[`temperature_2m_max_${m.id}`].filter((v) => v != null).length : 0;
    return {
      ...m, ok, dias,
      hoje: ok && hojeIdx != null ? { max: multi.daily[`temperature_2m_max_${m.id}`][hojeIdx], min: multi.daily[`temperature_2m_min_${m.id}`][hojeIdx] } : null,
      motivo: ok ? '' : listaModelos.includes(m.id) ? 'Sem dados para este local agora.' : 'Indisponível no momento.',
    };
  });
  for (const f of OUTRAS_FONTES) {
    if (f.id === 'metno') {
      const diasMet = metP ? Object.values(metP.diario).filter((d) => d.temperature_2m_max != null).length : 0;
      fontes.push({ ...f, ok: !!metP, dias: metP ? Math.min(DIAS, Object.keys(metP.diario).length) : 0, diasMet,
        hoje: metP?.diario[D.time[0]]?.temperature_2m_max != null ? { max: metP.diario[D.time[0]].temperature_2m_max, min: metP.diario[D.time[0]].temperature_2m_min } : null,
        motivo: metP ? '' : 'Não respondeu agora.' });
    } else if (f.id === 'inmet') {
      fontes.push({ ...f, ok: !!inm, dias: inm ? Object.keys(inm).length : 0, hoje: inm?.[D.time[0]] || null,
        motivo: inm ? '' : 'Sem previsão do INMET para este local agora.' });
    } else {
      fontes.push({ ...f, ok: false, motivo: f.indisponivel });
    }
  }
  out.consenso = {
    fontes,
    nFontes: fontes.filter((f) => f.ok).length,
    dias: faixas,
    agora,
    geradoEm: Date.now(),
  };
  return out;
}

// Limpa previsões antigas guardadas no aparelho (cada cidade aberta deixava uma cópia)
function limparCacheVelho() {
  try {
    const agora = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!/^wc:(prev\d*|cons\d*|met|inmetprev|ar\d*|grade\d*):/.test(k)) continue;
      const v = store.get(k);
      if (!v?.t || agora - v.t > 24 * 3600 * 1000 || /^wc:(prev\d*|cons1|cons2|cons3|grade\d*):/.test(k)) localStorage.removeItem(k);
    }
  } catch { /* ok */ }
}
let limpo = false;

// Previsão final. `cidade.id` (código IBGE) permite incluir o INMET.
export function previsaoConsenso(lat, lon, geocode) {
  if (!limpo) { limpo = true; limparCacheVelho(); }
  const chave = `wc:cons4:${(+lat).toFixed(2)},${(+lon).toFixed(2)}`;
  return comCache(chave, 20 * 60 * 1000, async () => {
    const [b, multi, met, inm] = await Promise.allSettled([
      base(lat, lon),
      variosModelos(lat, lon),
      metNorway(lat, lon),
      /^\d{7}$/.test(String(geocode || '')) ? inmet(String(geocode)) : Promise.reject(new Error('sem código IBGE')),
    ]);
    if (multi.status === 'rejected') console.warn('modelos', multi.reason);
    if (met.status === 'rejected') console.warn('MET Norway', met.reason);
    if (inm.status === 'rejected') console.info('INMET previsão', inm.reason?.message);
    let principal = b.status === 'fulfilled' ? b.value : null;
    if (!principal) {
      // Open-Meteo fora (ex.: limite de consultas): usa a MET Norway como base, se ela respondeu
      if (met.status !== 'fulfilled') throw b.reason;
      console.warn('Open-Meteo indisponível; previsão só com MET Norway', b.reason?.message);
      principal = baseDeMET(met.value, +lat, +lon, geocode);
    }
    const r = montarConsenso(
      principal,
      multi.status === 'fulfilled' ? multi.value.dados : null,
      multi.status === 'fulfilled' ? multi.value.lista : [],
      met.status === 'fulfilled' ? met.value : null,
      inm.status === 'fulfilled' ? inm.value : null,
    );
    if (principal.soMET) {
      // Com uma fonte só, a chance de chuva é estimada pelo volume previsto (em vez de só 0% ou 100%)
      r.soMET = true;
      const chance = (mm) => (mm == null ? null : mm < 0.1 ? 10 : mm < 0.5 ? 40 : mm < 2 ? 65 : 85);
      r.hourly.precipitation_probability = r.hourly.precipitation.map(chance);
      r.daily.precipitation_probability_max = r.daily.time.map((dia) => {
        const v = r.hourly.time.map((t, k) => (t.startsWith(dia) ? r.hourly.precipitation_probability[k] : null)).filter((x) => x != null);
        return v.length ? Math.max(...v) : null;
      });
    }
    return r;
  }, 24 * 3600 * 1000);
}

// Exportado para testes
export const _teste = { medianaPonderada, mediaAparada, mediaAngular, codigoConsenso, codigoCoerente, prepararMET, montarConsenso };
