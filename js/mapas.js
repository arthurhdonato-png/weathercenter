// Mapas do tempo: camadas suaves calculadas a partir de uma grade de previsões (Open-Meteo),
// animação das próximas 24 horas, partículas de vento e radar de chuva animado (RainViewer).
/* global L */
import { $, num, esc, direcao, getJSON, ehLimite } from './util.js';
import { contornoBrasilLargo, gradeMapa, radarQuadros } from './dados.js';
import { basemap, temaEscuro } from './mapaBase.js';
import { mascaraBrasil, prepararMapa, LIMITES_BRASIL } from './mapaControles.js';

export { basemap, linhasEstados } from './mapaBase.js';

// Grade de previsões (cerca de 195 km entre pontos) e grade fina interpolada (cerca de 28 km)
// 1,75° entre pontos: cerca de 330 pontos no Brasil. Cada ponto conta como uma consulta na Open-Meteo,
// que aceita 600 por minuto; com 1,25° (≈600 pontos) o mapa sozinho esgotava o limite e travava a previsão.
const PASSO = 1.75;
const LAT_N = 6, LAT_S = -34.5, LON_O = -74.5, LON_L = -33.5;
const NY = Math.ceil((LAT_N - LAT_S) / PASSO) + 1;
const NX = Math.ceil((LON_L - LON_O) / PASSO) + 1;
const F = 7;
const FY = (NY - 1) * F + 1, FX = (NX - 1) * F + 1;

// Escalas de cor: [valor, [r,g,b,a]]
const ESCALAS = {
  temp: [[-5, [94, 60, 153, 1]], [0, [59, 82, 196, 1]], [8, [52, 136, 214, 1]], [14, [72, 186, 196, 1]], [19, [120, 198, 121, 1]],
    [24, [236, 220, 96, 1]], [28, [246, 166, 70, 1]], [32, [232, 100, 64, 1]], [36, [200, 48, 66, 1]], [42, [128, 20, 72, 1]]],
  uv: [[0, [92, 170, 98, 1]], [2.5, [160, 200, 80, 1]], [4, [232, 204, 72, 1]], [6.5, [240, 146, 58, 1]], [9, [220, 70, 60, 1]], [12, [150, 80, 160, 1]]],
  vento: [[0, [80, 110, 150, 0.15]], [10, [96, 160, 210, 0.7]], [20, [90, 190, 150, 0.85]], [35, [232, 206, 80, 0.95]], [50, [240, 140, 60, 1]], [70, [214, 60, 74, 1]], [100, [130, 40, 130, 1]]],
  chuva: [[0, [0, 0, 0, 0]], [0.1, [140, 200, 250, 0.45]], [1, [70, 150, 235, 0.8]], [3, [40, 90, 210, 0.9]], [8, [120, 60, 200, 0.95]], [15, [210, 50, 130, 1]], [30, [170, 20, 30, 1]]],
  nuvens: [[0, [0, 0, 0, 0]], [20, [200, 205, 215, 0.12]], [50, [205, 210, 220, 0.45]], [80, [225, 228, 235, 0.75]], [100, [245, 246, 250, 0.9]]],
  umidade: [[0, [170, 100, 50, 1]], [20, [220, 160, 80, 1]], [40, [232, 220, 130, 1]], [60, [130, 200, 150, 1]], [80, [60, 150, 210, 1]], [100, [40, 70, 160, 1]]],
  visib: [[0, [90, 90, 100, 0.95]], [1, [140, 140, 150, 0.85]], [5, [190, 190, 200, 0.6]], [10, [210, 230, 250, 0.35]], [25, [180, 225, 255, 0.15]], [50, [180, 225, 255, 0.05]]],
  pressao: [[995, [110, 60, 160, 1]], [1003, [60, 110, 210, 1]], [1009, [70, 180, 200, 1]], [1013, [140, 200, 120, 1]], [1017, [232, 204, 90, 1]], [1022, [240, 140, 60, 1]], [1030, [200, 50, 60, 1]]],
};

export const CAMADAS = [
  { id: 'temperature_2m', nome: 'Temperatura', un: '°C', escala: 'temp', casas: 0, curto: '°' },
  { id: 'precipitation', nome: 'Chuva', un: 'mm/h', escala: 'chuva', casas: 1, curto: ' mm' },
  { id: 'wind_speed_10m', nome: 'Vento', un: 'km/h', escala: 'vento', casas: 0, particulas: true, curto: '' },
  { id: 'cloud_cover', nome: 'Nuvens', un: '%', escala: 'nuvens', casas: 0, curto: '%' },
  { id: 'apparent_temperature', nome: 'Sensação', un: '°C', escala: 'temp', casas: 0, curto: '°' },
  { id: 'relative_humidity_2m', nome: 'Umidade', un: '%', escala: 'umidade', casas: 0, curto: '%' },
  { id: 'uv_index', nome: 'UV', un: '', escala: 'uv', casas: 0, curto: '' },
  { id: 'pressure_msl', nome: 'Pressão', un: 'hPa', escala: 'pressao', casas: 0, curto: '' },
  { id: 'visibility', nome: 'Visibilidade', un: 'km', escala: 'visib', casas: 0, fator: 0.001, curto: ' km' },
];

// Tabela de cores pré-calculada (rápida para desenhar quadro a quadro)
const tabelas = {};
function tabelaCores(escala) {
  if (tabelas[escala]) return tabelas[escala];
  const s = ESCALAS[escala];
  const min = s[0][0], max = s[s.length - 1][0];
  const N = 512;
  const t = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) {
    const v = min + ((max - min) * i) / (N - 1);
    let c = s[s.length - 1][1];
    for (let k = 1; k < s.length; k++) {
      if (v <= s[k][0]) {
        const [v0, c0] = s[k - 1], [v1, c1] = s[k];
        const f = (v - v0) / (v1 - v0);
        c = c0.map((x, j) => x + (c1[j] - x) * f);
        break;
      }
    }
    t[i * 4] = c[0]; t[i * 4 + 1] = c[1]; t[i * 4 + 2] = c[2]; t[i * 4 + 3] = c[3] * 255;
  }
  return (tabelas[escala] = { t, min, max, N });
}

/* ======================= Grade e interpolação ======================= */
function aneisDe(geo) {
  const aneis = [];
  for (const f of geo.features || [geo]) {
    const g = f.geometry || f;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const p of polys) aneis.push(p[0]);
  }
  return aneis; // [ [ [lon,lat], ... ], ... ]
}
function dentro(lon, lat, aneis) {
  let d = false;
  for (const anel of aneis) {
    for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
      const [xi, yi] = anel[i], [xj, yj] = anel[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) d = !d;
    }
  }
  return d;
}

const estado = {
  mapa: null, grade: null, indice: null, aneis: null, mascara: null,
  camada: CAMADAS[0], hora: 0, horaBase: 0, maxHora: 24, tocando: false,
  campo: null, particulas: null, radar: null, valores: null, visivel: true,
};

function montarGrade(aneis) {
  const pontos = [];
  const indice = new Int32Array(NX * NY).fill(-1);
  for (let iy = 0; iy < NY; iy++) {
    for (let ix = 0; ix < NX; ix++) {
      const lat = LAT_N - iy * PASSO, lon = LON_O + ix * PASSO;
      let ok = !aneis;
      if (aneis) {
        for (const [dy, dx] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          if (dentro(lon + dx * PASSO * 0.9, lat + dy * PASSO * 0.9, aneis)) { ok = true; break; }
        }
      }
      if (ok) { indice[iy * NX + ix] = pontos.length; pontos.push([lat, lon]); }
    }
  }
  return { pontos, indice };
}

// Máscara suave do território (1 dentro do Brasil, 0 fora) na grade fina
function montarMascara(aneis) {
  const m = new Float32Array(FX * FY);
  if (!aneis) return m.fill(1);
  for (let y = 0; y < FY; y++) {
    const lat = LAT_N - (y * PASSO) / F;
    for (let x = 0; x < FX; x++) m[y * FX + x] = dentro(LON_O + (x * PASSO) / F, lat, aneis) ? 1 : 0;
  }
  return m;
}

// Catmull-Rom: curva suave que passa pelos pontos da grade (sem "manchas" quadradas)
const cr = (p0, p1, p2, p3, t) => 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);

// Campo fino (Float32Array FX*FY) de uma variável numa hora; NaN onde não há dados
const camposCache = new Map();
function campoFino(id, t, fator = 1) {
  const chave = `${id}:${t}`;
  if (camposCache.has(chave)) return camposCache.get(chave);
  const valores = estado.grade.valores[id];
  const g = (iy, ix) => {
    if (iy < 0 || iy >= NY || ix < 0 || ix >= NX) return NaN;
    const k = estado.indice[iy * NX + ix];
    const v = k < 0 ? null : valores?.[k]?.[t];
    return v == null ? NaN : v * fator;
  };
  // Preenche buracos da grade grossa com a média dos vizinhos (evita bordas serrilhadas)
  const grossa = new Float32Array(NX * NY);
  for (let iy = 0; iy < NY; iy++) {
    for (let ix = 0; ix < NX; ix++) {
      let v = g(iy, ix);
      if (Number.isNaN(v)) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const w = g(iy + dy, ix + dx); if (!Number.isNaN(w)) { s += w; n++; } }
        v = n ? s / n : NaN;
      }
      grossa[iy * NX + ix] = v;
    }
  }
  const G = (iy, ix) => grossa[Math.min(NY - 1, Math.max(0, iy)) * NX + Math.min(NX - 1, Math.max(0, ix))];
  const fino = new Float32Array(FX * FY);
  const linha = [0, 0, 0, 0];
  const minimo = id === 'precipitation' || id === 'cloud_cover' || id === 'uv_index' || id === 'wind_speed_10m' ? 0 : -Infinity;
  for (let y = 0; y < FY; y++) {
    const iy = Math.floor(y / F), fy = (y % F) / F;
    for (let x = 0; x < FX; x++) {
      const ix = Math.floor(x / F), fx = (x % F) / F;
      let ok = true;
      for (let k = -1; k <= 2; k++) {
        const a = G(iy + k, ix - 1), b = G(iy + k, ix), c = G(iy + k, ix + 1), d = G(iy + k, ix + 2);
        if (Number.isNaN(a + b + c + d)) { ok = false; break; }
        linha[k + 1] = cr(a, b, c, d, fx);
      }
      let v;
      if (ok) v = cr(linha[0], linha[1], linha[2], linha[3], fy);
      else {
        // Perto da borda dos dados: interpolação bilinear com o que houver
        let s = 0, w = 0;
        for (const [dy, dx, p] of [[0, 0, (1 - fy) * (1 - fx)], [0, 1, (1 - fy) * fx], [1, 0, fy * (1 - fx)], [1, 1, fy * fx]]) {
          const q = G(iy + dy, ix + dx);
          if (!Number.isNaN(q)) { s += q * p; w += p; }
        }
        v = w > 0.01 ? s / w : NaN;
      }
      fino[y * FX + x] = Math.max(minimo, v);
    }
  }
  if (camposCache.size > 120) camposCache.delete(camposCache.keys().next().value);
  camposCache.set(chave, fino);
  return fino;
}

function amostra(campo, fy, fx) {
  if (fy < 0 || fx < 0 || fy > FY - 1 || fx > FX - 1) return NaN;
  const y0 = Math.floor(fy), x0 = Math.floor(fx);
  const y1 = Math.min(FY - 1, y0 + 1), x1 = Math.min(FX - 1, x0 + 1);
  const ty = fy - y0, tx = fx - x0;
  const a = campo[y0 * FX + x0], b = campo[y0 * FX + x1], c = campo[y1 * FX + x0], d = campo[y1 * FX + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}
const paraFino = (lat, lon) => [((LAT_N - lat) / PASSO) * F, ((lon - LON_O) / PASSO) * F];

// Valor de uma camada num ponto e num instante (horas podem ser fracionárias)
function valorCampo(c, lat, lon, h) {
  const t0 = Math.floor(h), f = h - t0;
  const [fy, fx] = paraFino(lat, lon);
  const a = amostra(campoFino(c.id, estado.horaBase + t0, c.fator), fy, fx);
  if (f < 0.01) return a;
  const b = amostra(campoFino(c.id, estado.horaBase + Math.min(t0 + 1, estado.maxHora), c.fator), fy, fx);
  return a + (b - a) * f;
}
export function valorEm(lat, lon) {
  if (!estado.grade) return null;
  const v = valorCampo(estado.camada, lat, lon, estado.hora);
  return Number.isNaN(v) ? null : v;
}

/* ======================= Camada de cor (canvas do tamanho da tela) ======================= */
const CamadaCampo = L.Layer.extend({
  onAdd(mapa) {
    this._canvas = L.DomUtil.create('canvas', 'camada-campo leaflet-zoom-animated');
    mapa.getPane('camadaTempo').appendChild(this._canvas);
    mapa.on('moveend zoomend resize viewreset', this._reset, this);
    mapa.on('zoomanim', this._animarZoom, this);
    this._reset();
  },
  onRemove(mapa) {
    this._canvas.remove();
    mapa.off('moveend zoomend resize viewreset', this._reset, this);
    mapa.off('zoomanim', this._animarZoom, this);
  },
  _animarZoom(e) {
    if (!this._limites) return;
    const escala = this._map.getZoomScale(e.zoom);
    const pos = this._map._latLngBoundsToNewLayerBounds(this._limites, e.zoom, e.center).min;
    L.DomUtil.setTransform(this._canvas, pos, escala);
  },
  _reset() {
    const mapa = this._map;
    const tam = mapa.getSize();
    this._limites = mapa.getBounds();
    L.DomUtil.setPosition(this._canvas, mapa.containerPointToLayerPoint([0, 0]));
    // Meia resolução da tela (o navegador suaviza ao ampliar): leve e sem serrilhado
    const q = Math.min(0.6 * (window.devicePixelRatio || 1), 1);
    this._canvas.width = Math.max(1, Math.round(tam.x * q));
    this._canvas.height = Math.max(1, Math.round(tam.y * q));
    this._canvas.style.width = `${tam.x}px`;
    this._canvas.style.height = `${tam.y}px`;
    // Coordenadas de cada coluna e linha na grade fina
    const W = this._canvas.width, H = this._canvas.height;
    this._fx = new Float32Array(W);
    this._fy = new Float32Array(H);
    for (let x = 0; x < W; x++) this._fx[x] = paraFino(0, mapa.containerPointToLatLng([((x + 0.5) / W) * tam.x, 0]).lng)[1];
    for (let y = 0; y < H; y++) this._fy[y] = paraFino(mapa.containerPointToLatLng([0, ((y + 0.5) / H) * tam.y]).lat, 0)[0];
    this._img = null;
    this.redesenhar();
  },
  redesenhar() {
    if (!estado.grade || !this._map) return;
    const c = estado.camada;
    const W = this._canvas.width, H = this._canvas.height;
    const ctx = this._canvas.getContext('2d');
    if (!this._img || this._img.width !== W) this._img = ctx.createImageData(W, H);
    const d = this._img.data;
    const h = estado.hora, t0 = Math.floor(h), fr = h - t0;
    const A = campoFino(c.id, estado.horaBase + t0, c.fator);
    const B = fr > 0.01 ? campoFino(c.id, estado.horaBase + Math.min(t0 + 1, estado.maxHora), c.fator) : null;
    const M = estado.mascara;
    const { t: tab, min, max, N } = tabelaCores(c.escala);
    const k = (N - 1) / (max - min);
    const opac = c.escala === 'nuvens' ? 1 : 0.78;
    for (let y = 0; y < H; y++) {
      const fy = this._fy[y];
      const linhaFora = fy < 0 || fy > FY - 1;
      const y0 = Math.floor(fy), y1 = Math.min(FY - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const fx = this._fx[x];
        if (linhaFora || fx < 0 || fx > FX - 1) { d[o + 3] = 0; continue; }
        const x0 = Math.floor(fx), x1 = Math.min(FX - 1, x0 + 1), tx = fx - x0;
        const i00 = y0 * FX + x0, i01 = y0 * FX + x1, i10 = y1 * FX + x0, i11 = y1 * FX + x1;
        const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty), w10 = (1 - tx) * ty, w11 = tx * ty;
        const m = M[i00] * w00 + M[i01] * w01 + M[i10] * w10 + M[i11] * w11;
        if (m < 0.02) { d[o + 3] = 0; continue; }
        let v = A[i00] * w00 + A[i01] * w01 + A[i10] * w10 + A[i11] * w11;
        if (B) v += ((B[i00] * w00 + B[i01] * w01 + B[i10] * w10 + B[i11] * w11) - v) * fr;
        if (Number.isNaN(v)) { d[o + 3] = 0; continue; }
        const j = Math.max(0, Math.min(N - 1, Math.round((v - min) * k))) * 4;
        d[o] = tab[j]; d[o + 1] = tab[j + 1]; d[o + 2] = tab[j + 2];
        d[o + 3] = tab[j + 3] * opac * Math.min(1, m * 1.6);
      }
    }
    ctx.putImageData(this._img, 0, 0);
  },
});

/* ======================= Partículas de vento ======================= */
const CamadaVento = L.Layer.extend({
  onAdd(mapa) {
    this._canvas = L.DomUtil.create('canvas', 'camada-vento');
    mapa.getPane('camadaVento').appendChild(this._canvas);
    mapa.on('movestart zoomstart', this._parar, this);
    mapa.on('moveend zoomend resize', this._reset, this);
    this._reset();
  },
  onRemove(mapa) {
    this._parar();
    this._canvas.remove();
    mapa.off('movestart zoomstart', this._parar, this);
    mapa.off('moveend zoomend resize', this._reset, this);
  },
  _parar() {
    cancelAnimationFrame(this._quadro);
    this._quadro = null;
    if (this._canvas) this._canvas.getContext('2d').clearRect(0, 0, this._canvas.width, this._canvas.height);
  },
  _reset() {
    this._parar();
    const mapa = this._map;
    const tam = mapa.getSize();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    L.DomUtil.setPosition(this._canvas, mapa.containerPointToLayerPoint([0, 0]));
    this._canvas.width = tam.x * dpr; this._canvas.height = tam.y * dpr;
    this._canvas.style.width = `${tam.x}px`; this._canvas.style.height = `${tam.y}px`;
    this._dpr = dpr; this._tam = tam;
    const n = Math.round(Math.min(2600, (tam.x * tam.y) / 420));
    this._p = Array.from({ length: n }, () => this._nova({}));
    if (estado.visivel && !matchMedia('(prefers-reduced-motion: reduce)').matches) this._quadro = requestAnimationFrame(() => this._passo());
  },
  _nova(p) {
    p.x = Math.random() * this._tam.x; p.y = Math.random() * this._tam.y; p.idade = Math.floor(Math.random() * 80);
    return p;
  },
  _passo() {
    const ctx = this._canvas.getContext('2d');
    const mapa = this._map;
    if (!estado.grade || !mapa) return;
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    // Apaga devagar o quadro anterior: forma o rastro
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,0.9)';
    ctx.fillRect(0, 0, this._tam.x, this._tam.y);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = temaEscuro() ? 'rgba(255,255,255,0.7)' : 'rgba(30,32,38,0.55)';
    ctx.beginPath();
    const h = estado.hora, hb = estado.horaBase;
    const t0 = Math.floor(h), fr = h - t0;
    const S0 = campoFino('wind_speed_10m', hb + t0), D0 = campoFino('wind_direction_10m', hb + t0);
    const S1 = fr > 0.01 ? campoFino('wind_speed_10m', hb + Math.min(t0 + 1, estado.maxHora)) : null;
    for (const p of this._p) {
      if (p.idade++ > 90) { this._nova(p); p.idade = 0; continue; }
      const ll = mapa.containerPointToLatLng([p.x, p.y]);
      const [fy, fx] = paraFino(ll.lat, ll.lng);
      const m = amostra(estado.mascara, fy, fx);
      let s = amostra(S0, fy, fx);
      if (S1) s += (amostra(S1, fy, fx) - s) * fr;
      const dir = amostra(D0, fy, fx);
      if (!(m > 0.3) || Number.isNaN(s) || Number.isNaN(dir)) { this._nova(p); continue; }
      // Direção meteorológica = de onde o vento vem; a partícula vai para o lado oposto
      const ang = ((dir + 180) * Math.PI) / 180;
      const vel = 0.25 + s * 0.12; // pixels por quadro, igual em qualquer zoom
      const nx = p.x + Math.sin(ang) * vel, ny = p.y - Math.cos(ang) * vel;
      ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny);
      p.x = nx; p.y = ny;
      if (nx < 0 || ny < 0 || nx > this._tam.x || ny > this._tam.y) this._nova(p);
    }
    ctx.stroke();
    this._quadro = requestAnimationFrame(() => this._passo());
  },
});

/* ======================= Valores sobre as cidades ======================= */
let cidades = null;
const listaCidades = () => (cidades ||= getJSON('dados/cidades.json', 30000)
  .then((d) => d.cidades.map(([nome, uf, lat, lon, pop, capital]) => ({ nome, uf, lat, lon, pop, capital })))
  .catch((e) => { cidades = null; throw e; }));

const CamadaValores = L.Layer.extend({
  onAdd(mapa) {
    this._caixa = L.DomUtil.create('div', 'camada-valores');
    mapa.getPane('valores').appendChild(this._caixa);
    mapa.on('moveend zoomend resize', this.redesenhar, this);
    listaCidades().then((l) => { this._lista = l; this.redesenhar(); }).catch(() => {});
  },
  onRemove(mapa) { this._caixa.remove(); mapa.off('moveend zoomend resize', this.redesenhar, this); },
  redesenhar() {
    const mapa = this._map;
    if (!mapa || !this._lista || !estado.grade) return;
    const z = mapa.getZoom();
    const minPop = z < 5 ? Infinity : z < 6 ? 400000 : z < 7 ? 120000 : z < 8 ? 40000 : 10000;
    const tam = mapa.getSize();
    const c = estado.camada;
    const ocupados = [];
    let html = '';
    L.DomUtil.setPosition(this._caixa, mapa.containerPointToLayerPoint([0, 0]));
    for (const cid of this._lista) {
      if (ocupados.length > 70) break;
      if (!cid.capital && cid.pop < minPop) continue;
      const p = mapa.latLngToContainerPoint([cid.lat, cid.lon]);
      if (p.x < 20 || p.y < 20 || p.x > tam.x - 20 || p.y > tam.y - 20) continue;
      const caixa = [p.x - 26, p.y - 34, p.x + 26, p.y + 4];
      if (ocupados.some((o) => caixa[0] < o[2] && caixa[2] > o[0] && caixa[1] < o[3] && caixa[3] > o[1])) continue;
      const v = valorCampo(c, cid.lat, cid.lon, estado.hora);
      if (Number.isNaN(v)) continue;
      ocupados.push(caixa);
      html += `<span class="valor-cidade" style="transform:translate(${Math.round(p.x)}px,${Math.round(p.y)}px)" title="${esc(cid.nome)}">${num(v, c.casas)}${c.curto}</span>`;
    }
    this._caixa.innerHTML = html;
  },
});

/* ======================= Radar animado ======================= */
async function ligarRadar(ligar) {
  const r = estado.radar;
  if (r) { clearInterval(r.timer); r.camadas.forEach((c) => estado.mapa.removeLayer(c)); estado.radar = null; }
  $('radar-info').textContent = '';
  if (!ligar) return;
  try {
    const { host, quadros } = await radarQuadros();
    const ultimos = quadros.filter((q) => q.path).slice(-8);
    if (!ultimos.length) throw new Error('sem quadros');
    // Quadros de 512 px (o RainViewer gratuito vai até o zoom 7, que aqui equivale ao zoom 8 do mapa)
    const camadas = ultimos.map((q) => L.tileLayer(`${host}${q.path}/512/{z}/{x}/{y}/2/1_1.png`, {
      tileSize: 512, zoomOffset: -1, minNativeZoom: 1, maxNativeZoom: 8, maxZoom: 16, opacity: 0, pane: 'camadaRadar',
      className: 'radar-quadro', attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>',
    }).addTo(estado.mapa));
    const rad = { camadas, i: camadas.length - 1, timer: null };
    estado.radar = rad;
    const mostrar = (i) => {
      camadas.forEach((c, k) => c.setOpacity(k === i ? 0.85 : 0));
      $('radar-info').textContent = new Date(ultimos[i].time * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    };
    mostrar(rad.i);
    // Passa pelos últimos quadros (de 10 em 10 minutos) com transição suave; para 2 s no mais recente
    let pausa = 0;
    rad.timer = setInterval(() => {
      if (document.hidden) return;
      if (rad.i === camadas.length - 1 && pausa++ < 3) return;
      pausa = 0;
      rad.i = (rad.i + 1) % camadas.length;
      mostrar(rad.i);
    }, 650);
  } catch (e) {
    console.warn(e);
    $('radar-info').textContent = 'indisponível';
    $('radar-check').checked = false;
  }
}

/* ======================= Desenho, legenda e linha do tempo ======================= */
function atualizar() {
  estado.campo?.redesenhar();
  estado.valores?.redesenhar();
  renderHora();
}

function trocarCamada(c) {
  estado.camada = c;
  [...$('mapa-camadas').children].forEach((x) => x.setAttribute('aria-pressed', String(CAMADAS[+x.dataset.i] === c)));
  if (c.particulas && !estado.particulas) estado.particulas = new CamadaVento().addTo(estado.mapa);
  if (!c.particulas && estado.particulas) { estado.mapa.removeLayer(estado.particulas); estado.particulas = null; }
  renderLegenda();
  atualizar();
}

function renderLegenda() {
  const c = estado.camada;
  const s = ESCALAS[c.escala];
  const min = s[0][0], max = s[s.length - 1][0];
  const grad = s.map(([v, [r, g, b, a]]) => `rgba(${r},${g},${b},${Math.max(a, 0.35)}) ${((v - min) / (max - min)) * 100}%`).join(',');
  const marcas = [s[0], s[Math.floor(s.length / 3)], s[Math.floor((2 * s.length) / 3)], s[s.length - 1]].map(([v]) => v);
  $('mapa-legenda').innerHTML = `<div class="leg-titulo">${esc(c.nome)}${c.un ? ` <span>${c.un}</span>` : ''}</div>
    <div class="leg-barra" style="background:linear-gradient(90deg,${grad})"></div>
    <div class="leg-marcas">${marcas.map((m) => `<span>${m}</span>`).join('')}</div>`;
}

function renderHora() {
  if (!estado.grade) return;
  const t = estado.horaBase + estado.hora;
  const iso = estado.grade.tempo[Math.floor(t)];
  const d = new Date(Date.parse(`${iso}:00Z`) + (t - Math.floor(t)) * 3600000);
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  $('mapa-hora-rotulo').textContent = estado.hora < 0.5 && !estado.tocando ? `Agora · ${hora}`
    : `${d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')} ${hora}`;
  $('mapa-hora').value = String(estado.hora);
}

function tocar(sim) {
  estado.tocando = sim;
  const b = $('mapa-tocar');
  b.setAttribute('aria-pressed', String(sim));
  b.setAttribute('aria-label', sim ? 'Pausar animação' : 'Animar as próximas 24 horas');
  b.innerHTML = sim ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3v14H7zM14 5h3v14h-3z"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  if (!sim) { estado.hora = Math.round(estado.hora * 4) / 4; atualizar(); return; }
  let antes = performance.now();
  let ultimoValores = 0;
  const passo = (agora) => {
    if (!estado.tocando) return;
    const dt = Math.min(100, agora - antes); antes = agora;
    estado.hora += dt / 650; // uma hora a cada 0,65 s
    if (estado.hora > estado.maxHora) estado.hora = 0;
    estado.campo?.redesenhar();
    if (agora - ultimoValores > 250) { estado.valores?.redesenhar(); ultimoValores = agora; }
    renderHora();
    requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);
}

async function carregarDados() {
  const st = $('mapa-status');
  st.textContent = 'Carregando dados do mapa…';
  st.hidden = false;
  try {
    let aneis = null;
    try { aneis = aneisDe(await contornoBrasilLargo()); } catch (e) { console.warn('Contorno do Brasil indisponível', e); }
    estado.aneis = aneis;
    const g = montarGrade(aneis);
    estado.indice = g.indice;
    estado.grade = await gradeMapa(g.pontos);
    estado.mascara = montarMascara(aneis);
    const agora = new Date(); agora.setUTCMinutes(0, 0, 0);
    const isoAgora = agora.toISOString().slice(0, 13);
    const i = estado.grade.tempo.findIndex((t) => t.slice(0, 13) >= isoAgora);
    estado.horaBase = Math.max(0, i);
    estado.maxHora = Math.min(24, estado.grade.tempo.length - 1 - estado.horaBase);
    $('mapa-hora').max = String(estado.maxHora);
    st.hidden = true;
    estado.campo = new CamadaCampo().addTo(estado.mapa);
    estado.valores = new CamadaValores().addTo(estado.mapa);
    trocarCamada(estado.camada);
  } catch (e) {
    console.error(e);
    st.textContent = ehLimite(e) ? 'O serviço de previsão recebeu consultas demais da sua rede. O mapa volta em alguns minutos.'
      : 'Não foi possível carregar os dados do mapa agora. Tente novamente mais tarde.';
    setTimeout(() => { if (!estado.grade) carregarDados(); }, 90 * 1000);
  }
}

export function iniciarMapas(abrirPonto) {
  if (estado.mapa) { estado.mapa.invalidateSize(); return; }
  const mapa = L.map('mapa-tempo', { zoomControl: false, attributionControl: true, minZoom: 2.5, maxZoom: 14, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90 })
    .fitBounds(LIMITES_BRASIL);
  L.control.zoom({ position: 'bottomright' }).addTo(mapa);
  mapa.attributionControl.setPrefix(false);
  estado.mapa = mapa;
  mapa.createPane('camadaTempo').style.zIndex = 380;
  mapa.createPane('camadaRadar').style.zIndex = 390;
  mapa.createPane('camadaVento').style.zIndex = 395;
  mapa.getPane('camadaVento').style.pointerEvents = 'none';
  mapa.createPane('valores').style.zIndex = 660;
  mapa.getPane('valores').style.pointerEvents = 'none';
  basemap(mapa);
  mascaraBrasil(mapa);
  prepararMapa(mapa, $('tela-mapa-tempo'));

  $('mapa-camadas').innerHTML = CAMADAS.map((c, i) => `<button type="button" data-i="${i}" aria-pressed="${i === 0}">${c.nome}</button>`).join('');
  $('mapa-camadas').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    trocarCamada(CAMADAS[+b.dataset.i]);
  });
  $('mapa-hora').addEventListener('input', (e) => { tocar(false); estado.hora = +e.target.value; atualizar(); });
  $('mapa-tocar').addEventListener('click', () => tocar(!estado.tocando));
  $('radar-check').addEventListener('change', (e) => ligarRadar(e.target.checked));

  mapa.on('click', (e) => {
    const { lat, lng } = e.latlng;
    const v = valorEm(lat, lng);
    const c = estado.camada;
    const conteudo = document.createElement('div');
    conteudo.className = 'popup';
    let texto = v == null ? 'Sem dados neste ponto.' : `<strong>${num(v, c.casas)} ${c.un}</strong> ${esc(c.nome.toLowerCase())}`;
    if (v != null && c.particulas) {
      const [fy, fx] = paraFino(lat, lng);
      const d = amostra(campoFino('wind_direction_10m', estado.horaBase + Math.floor(estado.hora)), fy, fx);
      if (!Number.isNaN(d)) texto += ` vindo de ${direcao(d)}`;
    }
    conteudo.innerHTML = `<p>${texto}</p><p class="pequeno">Valor aproximado da região</p><button type="button" class="btn">Ver previsão deste ponto</button>`;
    conteudo.querySelector('button').addEventListener('click', () => { mapa.closePopup(); tocar(false); abrirPonto(lat, lng); });
    L.popup().setLatLng(e.latlng).setContent(conteudo).openOn(mapa);
  });

  carregarDados();
}

// Para a animação quando o mapa sai da tela (economiza bateria) e retoma as partículas quando volta
export function pausarMapas() {
  if (estado.tocando) tocar(false);
}
export function mapasVisiveis(visivel) {
  if (estado.visivel === visivel) return;
  estado.visivel = visivel;
  if (!visivel) { pausarMapas(); estado.particulas?._parar(); }
  else if (estado.particulas) estado.particulas._reset();
}
