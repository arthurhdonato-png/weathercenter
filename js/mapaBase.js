// Mapa de fundo dos mapas do app: ruas, limites, rios e nomes de lugares (estilo mapa de navegação).
//
// Usa os mapas vetoriais gratuitos do OpenFreeMap (dados do OpenStreetMap, sem chave e sem limite),
// desenhados pela MapLibre dentro do Leaflet. São duas camadas:
//   1) o fundo (terra, água, ruas, limites), por baixo das camadas de tempo e alertas;
//   2) os nomes e os limites, por cima delas, para continuarem legíveis.
// Se o aparelho não tiver WebGL, cai para os quadros do OpenStreetMap.
/* global L, maplibregl */
import { contornoEstados } from './dados.js';

const ESTILO = {
  claro: 'https://tiles.openfreemap.org/styles/liberty',
  escuro: 'https://tiles.openfreemap.org/styles/dark',
};
const ATRIBUICAO = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · '
  + '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

export const temaEscuro = () => document.documentElement.dataset.tema === 'escuro'
  || (document.documentElement.dataset.tema !== 'claro' && matchMedia('(prefers-color-scheme: dark)').matches);

// A MapLibre é grande (cerca de 1 MB): só é baixada quando um mapa é aberto
let carregandoGL = null;
function carregarScript(src) {
  return new Promise((ok, falha) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => falha(new Error(`não carregou ${src}`));
    document.head.appendChild(s);
  });
}
function carregarMapLibre() {
  if (!carregandoGL) {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'vendor/maplibre/maplibre-gl.css';
    document.head.appendChild(css);
    carregandoGL = carregarScript('vendor/maplibre/maplibre-gl.js')
      .then(() => carregarScript('vendor/maplibre/leaflet-maplibre-gl.js'))
      .catch((e) => { carregandoGL = null; throw e; });
  }
  return carregandoGL;
}

function suportaWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

// Nomes em português quando o OpenStreetMap tiver; senão o nome local
const NOME_PT = ['coalesce', ['get', 'name:pt'], ['get', 'name:latin'], ['get', 'name']];

const estilos = new Map();
function baixarEstilo(url) {
  if (!estilos.has(url)) {
    estilos.set(url, fetch(url).then((r) => {
      if (!r.ok) throw new Error(`estilo HTTP ${r.status}`);
      return r.json();
    }).catch((e) => { estilos.delete(url); throw e; }));
  }
  return estilos.get(url);
}

const ehRotulo = (l) => l.type === 'symbol';
const ehLimite = (l) => l.type === 'line' && /boundary/.test(l.id);

function prepararEstilos(original, escuro) {
  const base = structuredClone(original);
  for (const l of base.layers) {
    if (l.type === 'symbol' && JSON.stringify(l.layout?.['text-field'] || '').includes('name')) l.layout['text-field'] = NOME_PT;
  }
  const fonteVetorial = Object.keys(base.sources).find((k) => base.sources[k].type === 'vector');
  // Limites dos municípios (quando o OpenStreetMap tiver), só de perto
  const limitesMunicipios = fonteVetorial ? [{
    id: 'wc-limite-municipio', type: 'line', source: fonteVetorial, 'source-layer': 'boundary', minzoom: 7,
    filter: ['all', ['==', ['get', 'admin_level'], 8], ['!=', ['get', 'maritime'], 1]],
    paint: { 'line-color': escuro ? 'rgba(200,200,190,.28)' : 'rgba(90,90,100,.35)', 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.5, 12, 1.2], 'line-dasharray': [3, 2] },
  }] : [];
  const camadasFundo = base.layers.filter((l) => !ehRotulo(l) && !ehLimite(l));
  const camadasTopo = base.layers.filter((l) => ehRotulo(l) || ehLimite(l));
  return {
    fundo: { ...base, layers: camadasFundo },
    topo: { ...base, layers: [...limitesMunicipios, ...camadasTopo] },
  };
}

// Devolve { vetorial: true|false }
export async function basemap(mapa) {
  if (!mapa.getPane('rotulos')) {
    mapa.createPane('rotulos');
    mapa.getPane('rotulos').style.zIndex = 650;
    mapa.getPane('rotulos').style.pointerEvents = 'none';
  }
  const escuro = temaEscuro();
  if (suportaWebGL()) {
    try {
      await carregarMapLibre();
      const { fundo, topo } = prepararEstilos(await baixarEstilo(escuro ? ESTILO.escuro : ESTILO.claro), escuro);
      const opcoes = { interactive: false, attributionControl: false, fadeDuration: 150, maxTileCacheZoomLevels: 6 };
      const cFundo = L.maplibreGL({ ...opcoes, style: fundo, pane: 'tilePane', attribution: ATRIBUICAO }).addTo(mapa);
      const cTopo = L.maplibreGL({ ...opcoes, style: topo, pane: 'rotulos' }).addTo(mapa);
      // Troca de tema (botão do topo ou aparelho): troca o estilo do mapa sem recriar nada
      document.addEventListener('wc:tema', async () => {
        try {
          const esc = temaEscuro();
          const novo = prepararEstilos(await baixarEstilo(esc ? ESTILO.escuro : ESTILO.claro), esc);
          cFundo.getMaplibreMap()?.setStyle(novo.fundo);
          cTopo.getMaplibreMap()?.setStyle(novo.topo);
        } catch (e) { console.warn('troca de tema do mapa', e); }
      });
      return { vetorial: true };
    } catch (e) {
      console.warn('Mapa vetorial indisponível, usando quadros do OpenStreetMap', e);
    }
  }
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(mapa);
  linhasEstados(mapa);
  return { vetorial: false };
}

export async function linhasEstados(mapa) {
  if (!mapa.getPane('linhas')) mapa.createPane('linhas').style.zIndex = 400;
  try {
    const geo = await contornoEstados();
    const cor = () => (temaEscuro() ? '#8a96a3' : '#4d5763');
    const camada = L.geoJSON(geo, { interactive: false, style: { color: cor(), weight: 1, opacity: 0.6, fill: false }, pane: 'linhas' }).addTo(mapa);
    document.addEventListener('wc:tema', () => camada.setStyle({ color: cor() }));
  } catch (e) { console.warn('Contorno dos estados indisponível', e); }
}
