// Lê os alertas gerados pelo coletor (alertas.json + cópia do INMET) no formato comum do app
// e decide quais cidades cada alerta atinge (mesma regra de js/dados.js → alertaAfetaCidade).
import fs from 'node:fs';
import path from 'node:path';

export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const UF_POR_CODIGO = { 11: 'RO', 12: 'AC', 13: 'AM', 14: 'RR', 15: 'PA', 16: 'AP', 17: 'TO', 21: 'MA', 22: 'PI', 23: 'CE', 24: 'RN', 25: 'PB', 26: 'PE', 27: 'AL', 28: 'SE', 29: 'BA', 31: 'MG', 32: 'ES', 33: 'RJ', 35: 'SP', 41: 'PR', 42: 'SC', 43: 'RS', 50: 'MS', 51: 'MT', 52: 'GO', 53: 'DF' };

function nivelINMET(sev) {
  const s = norm(sev);
  if (s.includes('grande')) return 3;
  if (s === 'perigo') return 2;
  return 1;
}

// Polígonos: GeoJSON (INMET) ou lista [[lat,lon],...] (coletor)
function poligonosINMET(v) {
  try {
    const g = typeof v === 'string' ? JSON.parse(v) : v;
    if (!g?.coordinates) return [];
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    return polys.map((p) => p[0].map(([lon, lat]) => [lat, lon]));
  } catch { return []; }
}

const lista = (v) => {
  if (Array.isArray(v)) return v.map(String);
  const s = String(v ?? '').trim();
  if (s.startsWith('[')) { // o INMET às vezes manda a lista como texto "['a', 'b']"
    return [...s.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? m[2]);
  }
  return s ? s.split(/\n/) : [];
};

function dataINMET(iso) {
  // "2026-11-26 09:10" é horário de Brasília
  const m = String(iso ?? '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return m ? new Date(`${m[1]}T${m[2]}:00-03:00`) : null;
}

export function normalizarINMET(a) {
  const geocodes = String(Array.isArray(a.geocodes) ? a.geocodes.join(',') : a.geocodes ?? '').split(/\D+/).filter((c) => c.length >= 6);
  const estados = [...new Set(geocodes.map((g) => UF_POR_CODIGO[g.slice(0, 2)]).filter(Boolean))];
  return {
    id: `inmet-${a.id ?? `${a.descricao}-${a.inicio}`}`,
    fonte: 'INMET',
    titulo: a.descricao || 'Aviso meteorológico',
    evento: a.descricao || '',
    severidade: a.severidade || 'Aviso',
    nivel: nivelINMET(a.severidade),
    inicio: dataINMET(a.inicio),
    fim: dataINMET(a.fim),
    riscos: lista(a.riscos),
    geocodes,
    estados,
    poligonos: poligonosINMET(a.poligono),
    areaTexto: '',
  };
}

function normalizarColetor(a) {
  return {
    ...a,
    inicio: a.inicio ? new Date(a.inicio) : null,
    fim: a.fim ? new Date(a.fim) : null,
    riscos: a.riscos || [],
    geocodes: (a.geocodes || []).map(String),
    poligonos: a.poligonos || [],
    areaTexto: a.areaTexto || '',
  };
}

const lerJSON = (arq) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return null; } };

// Alertas ativos que atingem terra firme (avisos só para o mar ficam de fora)
export function carregarAlertas(pasta, agora = Date.now()) {
  const alertas = [];
  const col = lerJSON(path.join(pasta, 'alertas.json'));
  if (col?.alertas) alertas.push(...col.alertas.map(normalizarColetor));
  const inm = lerJSON(path.join(pasta, 'inmet.json'));
  if (inm) {
    const brutos = Array.isArray(inm) ? inm : [...(inm.hoje || []), ...(inm.futuro || [])];
    const vistos = new Set();
    for (const a of brutos.map(normalizarINMET)) if (!vistos.has(a.id)) { vistos.add(a.id); alertas.push(a); }
  }
  return alertas.filter((a) => !a.maritimo && (a.nivel || 0) >= 1 && (!a.fim || +a.fim > agora));
}

export function pontoNoPoligono(lat, lon, anel) {
  let dentro = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [yi, xi] = anel[i], [yj, xj] = anel[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

export function alertaAfetaCidade(a, cidade) {
  if (a.maritimo) return false;
  if (cidade.id && a.geocodes.length) {
    const id7 = String(cidade.id), id6 = id7.slice(0, 6);
    return a.geocodes.some((c) => c === id7 || c === id6);
  }
  // Polígono pequeno (ex.: só a margem de um rio) pode não conter o centro da cidade: aí vale o nome da área
  if (cidade.lat != null && a.poligonos.some((p) => pontoNoPoligono(cidade.lat, cidade.lon, p))) return true;
  const texto = norm(a.areaTexto);
  if (!texto) return false;
  const alvo = norm(cidade.nome);
  return texto.split(/[,;]/).some((parte) => {
    const p = parte.trim();
    return p === alvo || p.startsWith(`${alvo} -`) || p.startsWith(`${alvo} (`) || p.startsWith(`${alvo}/`);
  });
}
