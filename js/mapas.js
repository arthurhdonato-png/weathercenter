// Mapas interativos de tempo (camadas calculadas a partir de uma grade de pontos do Open-Meteo)
/* global L */
import { $, num, esc, direcao } from './util.js';
import { contornoBrasil, contornoEstados, gradeMapa, radarQuadros } from './dados.js';

const PASSO = 1.25;
const LAT_N = 6, LAT_S = -34.5, LON_O = -74.5, LON_L = -33.5;
const NY = Math.round((LAT_N - LAT_S) / PASSO) + 1;
const NX = Math.round((LON_L - LON_O) / PASSO) + 1;

// Escalas de cor: [valor, [r,g,b,a]]
const ESCALAS = {
  temp: [[-5, [130, 22, 146, 1]], [0, [25, 50, 220, 1]], [8, [30, 140, 255, 1]], [14, [40, 200, 200, 1]], [19, [100, 210, 80, 1]],
    [24, [240, 230, 50, 1]], [28, [255, 170, 30, 1]], [32, [245, 90, 30, 1]], [36, [210, 20, 40, 1]], [42, [130, 0, 60, 1]]],
  uv: [[0, [62, 167, 45, 1]], [2.5, [140, 200, 40, 1]], [4, [228, 198, 0, 1]], [6.5, [241, 139, 0, 1]], [9, [229, 50, 16, 1]], [12, [181, 103, 164, 1]]],
  vento: [[0, [220, 240, 255, 0.35]], [10, [140, 200, 240, 1]], [20, [60, 170, 120, 1]], [35, [240, 210, 40, 1]], [50, [245, 120, 30, 1]], [70, [210, 30, 60, 1]], [100, [130, 20, 120, 1]]],
  chuva: [[0, [0, 0, 0, 0]], [0.1, [160, 210, 255, 0.55]], [1, [70, 150, 245, 0.85]], [3, [30, 80, 220, 0.95]], [8, [130, 40, 200, 1]], [15, [220, 30, 120, 1]], [30, [180, 0, 0, 1]]],
  umidade: [[0, [170, 90, 30, 1]], [20, [230, 160, 60, 1]], [40, [240, 230, 120, 1]], [60, [120, 210, 140, 1]], [80, [40, 150, 220, 1]], [100, [20, 60, 170, 1]]],
  visib: [[0, [90, 90, 100, 0.95]], [1, [140, 140, 150, 0.9]], [5, [190, 190, 200, 0.7]], [10, [210, 230, 250, 0.45]], [25, [180, 225, 255, 0.25]], [50, [180, 225, 255, 0.15]]],
  pressao: [[995, [120, 40, 160, 1]], [1003, [50, 100, 220, 1]], [1009, [60, 190, 200, 1]], [1013, [140, 210, 100, 1]], [1017, [240, 210, 60, 1]], [1022, [245, 130, 40, 1]], [1030, [200, 30, 40, 1]]],
};

export const CAMADAS = [
  { id: 'temperature_2m', nome: 'Temperatura', un: '°C', escala: 'temp', casas: 0 },
  { id: 'apparent_temperature', nome: 'Sensação térmica', un: '°C', escala: 'temp', casas: 0 },
  { id: 'uv_index', nome: 'Índice UV', un: '', escala: 'uv', casas: 0 },
  { id: 'wind_speed_10m', nome: 'Vento', un: 'km/h', escala: 'vento', casas: 0, setas: true },
  { id: 'precipitation', nome: 'Precipitação', un: 'mm/h', escala: 'chuva', casas: 1 },
  { id: 'relative_humidity_2m', nome: 'Umidade', un: '%', escala: 'umidade', casas: 0 },
  { id: 'visibility', nome: 'Visibilidade', un: 'km', escala: 'visib', casas: 0, fator: 0.001 },
  { id: 'pressure_msl', nome: 'Pressão', un: 'hPa', escala: 'pressao', casas: 0 },
];

function cor(escala, v) {
  const s = ESCALAS[escala];
  if (v <= s[0][0]) return s[0][1];
  for (let i = 1; i < s.length; i++) {
    if (v <= s[i][0]) {
      const [v0, c0] = s[i - 1], [v1, c1] = s[i];
      const f = (v - v0) / (v1 - v0);
      return c0.map((c, k) => c + (c1[k] - c) * f);
    }
  }
  return s[s.length - 1][1];
}

const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const invMerc = (y) => (Math.atan(Math.exp(y)) * 360) / Math.PI - 90;

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
  mapa: null, overlay: null, radar: null, aneis: null, grade: null, indice: null,
  camada: CAMADAS[0], hora: 0, horaBase: 0, pronto: false,
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

function valorNaGrade(gy, gx, valores, t, fator = 1) {
  const y0 = Math.floor(gy), x0 = Math.floor(gx);
  const fy = gy - y0, fx = gx - x0;
  let soma = 0, peso = 0;
  for (const [dy, dx, w] of [[0, 0, (1 - fy) * (1 - fx)], [0, 1, (1 - fy) * fx], [1, 0, fy * (1 - fx)], [1, 1, fy * fx]]) {
    const y = y0 + dy, x = x0 + dx;
    if (y < 0 || y >= NY || x < 0 || x >= NX) continue;
    const k = estado.indice[y * NX + x];
    if (k < 0) continue;
    const v = valores[k]?.[t];
    if (v == null) continue;
    soma += v * w; peso += w;
  }
  return peso > 0.05 ? (soma / peso) * fator : null;
}

export function valorEm(lat, lon) {
  if (!estado.grade) return null;
  const c = estado.camada;
  return valorNaGrade((LAT_N - lat) / PASSO, (lon - LON_O) / PASSO, estado.grade.valores[c.id], estado.horaBase + estado.hora, c.fator);
}

function desenhar() {
  if (!estado.grade || !estado.mapa) return;
  const c = estado.camada;
  const t = estado.horaBase + estado.hora;
  const valores = estado.grade.valores[c.id];
  const W = 560, H = 600;
  const yN = merc(LAT_N), yS = merc(LAT_S);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let py = 0; py < H; py++) {
    const lat = invMerc(yN - ((py + 0.5) / H) * (yN - yS));
    const gy = (LAT_N - lat) / PASSO;
    for (let px = 0; px < W; px++) {
      const lon = LON_O + ((px + 0.5) / W) * (LON_L - LON_O);
      const v = valorNaGrade(gy, (lon - LON_O) / PASSO, valores, t, c.fator);
      if (v == null) continue;
      const [r, g, b, a] = cor(c.escala, v);
      const o = (py * W + px) * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = a * 200;
    }
  }
  ctx.putImageData(img, 0, 0);
  const pxDe = (lon, lat) => [((lon - LON_O) / (LON_L - LON_O)) * W, ((yN - merc(lat)) / (yN - yS)) * H];

  if (c.setas) {
    const dirs = estado.grade.valores.wind_direction_10m;
    ctx.strokeStyle = 'rgba(20,30,50,.75)'; ctx.fillStyle = 'rgba(20,30,50,.75)'; ctx.lineWidth = 1.3;
    for (let iy = 0; iy < NY; iy++) {
      for (let ix = 0; ix < NX; ix++) {
        const k = estado.indice[iy * NX + ix];
        if (k < 0) continue;
        const lat = LAT_N - iy * PASSO, lon = LON_O + ix * PASSO;
        if (estado.aneis && !dentro(lon, lat, estado.aneis)) continue;
        const d = dirs[k]?.[t]; if (d == null) continue;
        const [x, y] = pxDe(lon, lat);
        const ang = ((d + 180) * Math.PI) / 180; // para onde o vento sopra
        const dx = Math.sin(ang) * 6, dy = -Math.cos(ang) * 6;
        ctx.beginPath(); ctx.moveTo(x - dx, y - dy); ctx.lineTo(x + dx, y + dy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x + dx, y + dy);
        ctx.lineTo(x + dx - Math.sin(ang - 0.5) * 4, y + dy + Math.cos(ang - 0.5) * 4);
        ctx.lineTo(x + dx - Math.sin(ang + 0.5) * 4, y + dy + Math.cos(ang + 0.5) * 4);
        ctx.closePath(); ctx.fill();
      }
    }
  }

  // Recorta pelo contorno do Brasil
  if (estado.aneis) {
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    for (const anel of estado.aneis) {
      anel.forEach(([lon, lat], i) => { const [x, y] = pxDe(lon, lat); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }

  const url = cv.toDataURL();
  const limites = [[LAT_S, LON_O], [LAT_N, LON_L]];
  if (estado.overlay) estado.overlay.setUrl(url);
  else estado.overlay = L.imageOverlay(url, limites, { opacity: 0.85, pane: 'camadaTempo', interactive: false }).addTo(estado.mapa);
  renderLegenda();
  renderHora();
}

function renderLegenda() {
  const c = estado.camada;
  const s = ESCALAS[c.escala];
  const min = s[0][0], max = s[s.length - 1][0];
  const grad = s.map(([v, [r, g, b, a]]) => `rgba(${r},${g},${b},${Math.max(a, 0.25)}) ${((v - min) / (max - min)) * 100}%`).join(',');
  const marcas = [s[0], s[Math.floor(s.length / 3)], s[Math.floor((2 * s.length) / 3)], s[s.length - 1]].map(([v]) => v);
  $('mapa-legenda').innerHTML = `<div class="leg-titulo">${esc(c.nome)}${c.un ? ` (${c.un})` : ''}</div>
    <div class="leg-barra" style="background:linear-gradient(90deg,${grad})"></div>
    <div class="leg-marcas">${marcas.map((m) => `<span>${m}</span>`).join('')}</div>`;
}

function renderHora() {
  const iso = estado.grade.tempo[estado.horaBase + estado.hora];
  const d = new Date(`${iso}:00Z`);
  $('mapa-hora-rotulo').textContent = estado.hora === 0
    ? `Agora · ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

async function carregarDados() {
  const st = $('mapa-status');
  st.textContent = 'Carregando dados do mapa…';
  st.hidden = false;
  try {
    let aneis = null;
    try { aneis = aneisDe(await contornoBrasil()); } catch (e) { console.warn('Contorno do Brasil indisponível', e); }
    estado.aneis = aneis;
    const g = montarGrade(aneis);
    estado.indice = g.indice;
    estado.grade = await gradeMapa(g.pontos);
    const agora = new Date(); agora.setUTCMinutes(0, 0, 0);
    const isoAgora = agora.toISOString().slice(0, 13);
    const i = estado.grade.tempo.findIndex((t) => t.slice(0, 13) >= isoAgora);
    estado.horaBase = Math.max(0, i);
    const maxH = Math.min(24, estado.grade.tempo.length - 1 - estado.horaBase);
    $('mapa-hora').max = String(maxH);
    st.hidden = true;
    desenhar();
  } catch (e) {
    console.error(e);
    st.textContent = 'Não foi possível carregar os dados do mapa agora. Tente novamente mais tarde.';
  }
}

async function alternarRadar(ligar) {
  if (estado.radar) { estado.mapa.removeLayer(estado.radar); estado.radar = null; }
  if (!ligar) return;
  try {
    const { host, quadros } = await radarQuadros();
    const ultimo = quadros.filter((q) => q.path).pop();
    if (!ultimo) throw new Error('sem quadros');
    estado.radar = L.tileLayer(`${host}${ultimo.path}/256/{z}/{x}/{y}/2/1_1.png`, {
      opacity: 0.8, maxNativeZoom: 7, maxZoom: 12, pane: 'camadaRadar',
      attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>',
    }).addTo(estado.mapa);
    $('radar-info').textContent = `Radar de ${new Date(ultimo.time * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (e) {
    console.warn(e);
    $('radar-info').textContent = 'Radar indisponível agora.';
    $('radar-check').checked = false;
  }
}

// rotulos: false = sem os nomes do mapa de fundo (o mapa de alertas escreve os próprios nomes de cidades)
export function basemap(mapa, { rotulos = true } = {}) {
  const escuro = matchMedia('(prefers-color-scheme: dark)').matches;
  const estilo = escuro ? 'dark' : 'light';
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/${estilo}_nolabels/{z}/{x}/{y}{r}.png`, {
    subdomains: 'abcd', maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
  }).addTo(mapa);
  if (!rotulos) return;
  mapa.createPane('rotulos');
  mapa.getPane('rotulos').style.zIndex = 650;
  mapa.getPane('rotulos').style.pointerEvents = 'none';
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/${estilo}_only_labels/{z}/{x}/{y}{r}.png`, { subdomains: 'abcd', maxZoom: 18, pane: 'rotulos' }).addTo(mapa);
}

export async function linhasEstados(mapa) {
  try {
    const geo = await contornoEstados();
    L.geoJSON(geo, { interactive: false, style: { color: getComputedStyle(document.body).getPropertyValue('--linha-mapa').trim() || '#555', weight: 1, opacity: 0.6, fill: false }, pane: 'linhas' }).addTo(mapa);
  } catch (e) { console.warn('Contorno dos estados indisponível', e); }
}

export function iniciarMapas(abrirPonto) {
  if (estado.mapa) { estado.mapa.invalidateSize(); return; }
  const mapa = L.map('mapa-tempo', { zoomControl: true, attributionControl: true, minZoom: 3, maxZoom: 11, zoomSnap: 0.5 })
    .fitBounds([[-33.8, -74], [5.3, -34.8]]);
  estado.mapa = mapa;
  mapa.createPane('camadaTempo').style.zIndex = 380;
  mapa.createPane('camadaRadar').style.zIndex = 390;
  mapa.createPane('linhas').style.zIndex = 400;
  basemap(mapa);
  linhasEstados(mapa);

  $('mapa-camadas').innerHTML = CAMADAS.map((c, i) => `<button type="button" data-i="${i}" class="chip${i === 0 ? ' ativo' : ''}">${c.nome}</button>`).join('');
  $('mapa-camadas').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    estado.camada = CAMADAS[+b.dataset.i];
    [...$('mapa-camadas').children].forEach((x) => x.classList.toggle('ativo', x === b));
    desenhar();
  });
  $('mapa-hora').addEventListener('input', (e) => { estado.hora = +e.target.value; desenhar(); });
  $('radar-check').addEventListener('change', (e) => alternarRadar(e.target.checked));

  mapa.on('click', (e) => {
    const { lat, lng } = e.latlng;
    const v = valorEm(lat, lng);
    const c = estado.camada;
    const conteudo = document.createElement('div');
    conteudo.className = 'popup';
    let texto = v == null ? 'Sem dados neste ponto.' : `<strong>${num(v, c.casas)} ${c.un}</strong> ${esc(c.nome.toLowerCase())}`;
    if (v != null && c.setas) {
      const k = (LAT_N - lat) / PASSO, j = (lng - LON_O) / PASSO;
      const d = valorNaGrade(k, j, estado.grade.valores.wind_direction_10m, estado.horaBase + estado.hora);
      if (d != null) texto += ` vindo de ${direcao(d)}`;
    }
    conteudo.innerHTML = `<p>${texto}</p><p class="pequeno">Valor aproximado da região</p><button type="button" class="btn">Ver previsão deste ponto</button>`;
    conteudo.querySelector('button').addEventListener('click', () => { mapa.closePopup(); abrirPonto(lat, lng); });
    L.popup().setLatLng(e.latlng).setContent(conteudo).openOn(mapa);
  });

  carregarDados();
}
