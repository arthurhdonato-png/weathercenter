// Cena animada do tempo agora: uma casa (o local escolhido) com sol, lua, nuvens, neblina, vento, chuva ou raios.
// A chuva cai mais rápido e com mais gotas quanto mais forte ela é. O que ainda não chegou aparece ao lado da casa,
// do lado de onde vem e mais longe ou mais perto conforme a distância real:
//  - chuva: radar do RainViewer (distância, intensidade, velocidade e hora estimada de chegada);
//  - temporal: tempestades acompanhadas pelo detector do WeatherCenter (raios por satélite, com rumo e
//    velocidade) ou, sem elas, trovoada prevista para as próximas 12 horas;
//  - vento forte: rajadas previstas para as próximas 12 horas, vindo da direção prevista.
import { $, esc, num, tempo } from './util.js';
import { radarQuadros } from './dados.js';

const RAIO_KM = 150;      // até onde o radar procura chuva
const ZOOM = 6;           // quadros de 256 px no zoom 6: ~2,4 km por pixel no equador
const ALFA_CHUVA = 255;   // no esquema de cores 2 do RainViewer, garoa muito fraca é semitransparente
const RAIO_TEMPORAL_KM = 250;

// Intensidade da chuva: 1 fraca, 2 moderada, 3 forte, 4 muito forte (a animação acompanha)
export const INTENSIDADE = [
  null,
  { nome: 'fraca', gotas: 6, dur: 1.15, larg: 1.8 },
  { nome: 'moderada', gotas: 11, dur: 0.85, larg: 2.2 },
  { nome: 'forte', gotas: 18, dur: 0.6, larg: 2.5 },
  { nome: 'muito forte', gotas: 26, dur: 0.42, larg: 2.8 },
];
// Por mm/h (classes usuais da meteorologia: até 2,5 fraca, até 10 moderada, até 50 forte)
export const intensidadeMm = (mm) => (!(mm > 0) ? 0 : mm < 2.5 ? 1 : mm < 10 ? 2 : mm < 50 ? 3 : 4);
const intensidadeCodigo = (c) => ({ 51: 1, 53: 1, 55: 2, 56: 1, 57: 2, 61: 1, 63: 2, 65: 3, 66: 1, 67: 3, 80: 1, 81: 2, 82: 4, 95: 3, 96: 4, 99: 4 }[c] || 0);
// Cor do radar (esquema "Universal Blue"): azul claro = fraca, azul escuro = moderada/forte, amarelo e laranja = muito forte
function intensidadePixel(d, i) {
  if (d[i + 3] < ALFA_CHUVA) return 0;
  const r = d[i], g = d[i + 1];
  if (r >= 200) return 4;
  if (g >= 170) return 1;
  if (g >= 110) return 2;
  return 3;
}

/* ======================= Radar: chuva mais próxima ======================= */
const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z * 256;
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z * 256;
};

function carregarImagem(url) {
  return new Promise((ok, falha) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => ok(img);
    img.onerror = () => falha(new Error('quadro do radar'));
    img.src = url;
  });
}

// Lê os quadros do radar em volta do ponto e devolve a chuva mais próxima: { km, rumo } ou null
async function chuvaMaisProxima(host, caminho, lat, lon) {
  const px = lon2x(lon, ZOOM), py = lat2y(lat, ZOOM);
  const kmPorPx = (40075 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** ZOOM);
  const r = Math.ceil(RAIO_KM / kmPorPx);
  const x0 = Math.floor((px - r) / 256), x1 = Math.floor((px + r) / 256);
  const y0 = Math.floor((py - r) / 256), y1 = Math.floor((py + r) / 256);
  const W = (x1 - x0 + 1) * 256, H = (y1 - y0 + 1) * 256;
  const tela = document.createElement('canvas');
  tela.width = W; tela.height = H;
  const ctx = tela.getContext('2d', { willReadFrequently: true });
  const pedidos = [];
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      pedidos.push(carregarImagem(`${host}${caminho}/256/${ZOOM}/${tx}/${ty}/2/0_0.png`)
        .then((img) => ctx.drawImage(img, (tx - x0) * 256, (ty - y0) * 256)));
    }
  }
  await Promise.all(pedidos);
  const dados = ctx.getImageData(0, 0, W, H).data;
  const cx = px - x0 * 256, cy = py - y0 * 256;
  let melhor = null;
  for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(H, cy + r); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(W, cx + r); x++) {
      if (dados[(y * W + x) * 4 + 3] < ALFA_CHUVA) continue;
      // Exige um vizinho com chuva também (ignora pixel solto, que costuma ser ruído)
      const viz = (dx, dy) => { const xx = x + dx, yy = y + dy; return xx >= 0 && yy >= 0 && xx < W && yy < H && dados[(yy * W + xx) * 4 + 3] >= ALFA_CHUVA; };
      if (!(viz(1, 0) || viz(-1, 0) || viz(0, 1) || viz(0, -1))) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (!melhor || d < melhor.d) melhor = { d, dx: x - cx, dy: y - cy };
    }
  }
  // Intensidade no próprio local (raio de ~4 km) e na chuva mais próxima (a parte mais forte num raio de ~15 km)
  const maxEm = (x0c, y0c, raioPx) => {
    let m = 0;
    for (let y = Math.max(0, Math.floor(y0c - raioPx)); y <= Math.min(H - 1, y0c + raioPx); y++) {
      for (let x = Math.max(0, Math.floor(x0c - raioPx)); x <= Math.min(W - 1, x0c + raioPx); x++) {
        if ((x - x0c) ** 2 + (y - y0c) ** 2 <= raioPx * raioPx) m = Math.max(m, intensidadePixel(dados, (y * W + x) * 4));
      }
    }
    return m;
  };
  const aqui = maxEm(cx, cy, Math.max(1, 4 / kmPorPx));
  if (!melhor || melhor.d * kmPorPx > RAIO_KM) return { chuva: null, aqui };
  const rumo = ((Math.atan2(melhor.dx, -melhor.dy) * 180) / Math.PI + 360) % 360; // 0 = norte, 90 = leste
  const intens = Math.max(1, maxEm(cx + melhor.dx, cy + melhor.dy, 15 / kmPorPx));
  return { chuva: { km: melhor.d * kmPorPx, rumo, dx: melhor.dx, intens }, aqui };
}

const PONTOS = ['norte', 'nordeste', 'leste', 'sudeste', 'sul', 'sudoeste', 'oeste', 'noroeste'];
const ponto = (rumo) => PONTOS[Math.round((((rumo % 360) + 360) % 360) / 45) % 8];
const doLado = (rumo) => `do ${ponto(rumo)}`; // "vindo do oeste"
const aPonto = (rumo) => { const p = ponto(rumo); return `${p === 'norte' || p === 'sul' ? 'ao' : 'a'} ${p}`; }; // "a oeste", "ao norte"
const fmtMin = (m) => (m == null ? '' : m < 2 ? 'agora' : m < 60 ? `${Math.round(m / 5) * 5 || m} min` : `${Math.floor(m / 60)} h${m % 60 >= 10 ? ` ${Math.round((m % 60) / 5) * 5} min` : ''}`);
const chegaTxt = (m) => (m < 5 ? 'chegando agora' : `chega em ~${fmtMin(m)}`);
const horaMais = (min) => new Date(Date.now() + min * 60000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

// Distância e rumo entre dois pontos
function distancia(lat1, lon1, lat2, lon2) {
  const R = 6371, f1 = (lat1 * Math.PI) / 180, f2 = (lat2 * Math.PI) / 180;
  const df = f2 - f1, dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(a));
  const y = Math.sin(dl) * Math.cos(f2), x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return { km, rumo: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360 };
}
const difAng = (a, b) => { const d = Math.abs((((a - b) % 360) + 360) % 360); return d > 180 ? 360 - d : d; };

let radarCache = null;
async function radarAgora(lat, lon) {
  const chave = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (radarCache && radarCache.chave === chave && Date.now() - radarCache.t < 8 * 60 * 1000) return radarCache.v;
  const { host, quadros } = await radarQuadros();
  const passados = quadros.filter((q) => q.path && q.time * 1000 <= Date.now() + 60000);
  if (!passados.length) throw new Error('sem radar');
  const ultimo = passados[passados.length - 1];
  const antes = passados.find((q) => q.time >= ultimo.time - 30 * 60) || null;
  const [leitura, anteriorL] = await Promise.all([
    chuvaMaisProxima(host, ultimo.path, lat, lon),
    antes && antes !== ultimo ? chuvaMaisProxima(host, antes.path, lat, lon).catch(() => null) : null,
  ]);
  const agora = leitura.chuva, anterior = anteriorL?.chuva;
  let aproximando = null, minutos = null, kmh = null;
  if (agora && anterior) {
    const dt = (ultimo.time - antes.time) / 60;
    const ganho = anterior.km - agora.km;
    aproximando = ganho > 2;
    if (aproximando && dt > 0) {
      const v = ganho / dt; // km por minuto
      kmh = Math.round(v * 60);
      minutos = Math.round(agora.km / v);
      if (minutos > 300) minutos = null;
    }
  }
  const v = { chuva: agora, aqui: leitura.aqui, aproximando, minutos, kmh, hora: new Date(ultimo.time * 1000) };
  radarCache = { chave, t: Date.now(), v };
  return v;
}


/* ======================= O que vem por aí (tempestades e vento) ======================= */
// Tempestade acompanhada pelo detector (raios por satélite): a mais próxima que esteja vindo para cá
function tempestadeProxima(alertas, cidade) {
  let melhor = null;
  for (const a of alertas || []) {
    const d = a.detalhes;
    if (a.oficial !== false || !Array.isArray(d?.centro)) continue;
    const { km, rumo } = distancia(cidade.lat, cidade.lon, d.centro[0], d.centro[1]);
    if (km > RAIO_TEMPORAL_KM) continue;
    const v = Number(d.velocidadeKmh) || 0;
    const paraCa = (rumo + 180) % 360; // rumo que a tempestade precisa seguir para chegar aqui
    const desvio = d.rumoGraus != null ? difAng(d.rumoGraus, paraCa) : 180;
    let minutos = cidade.id != null ? d.chegadaMin?.[String(cidade.id)] ?? null : null;
    if (minutos == null && v >= 5 && desvio < 50) minutos = Math.round((km / (v * Math.cos((desvio * Math.PI) / 180))) * 60);
    if (minutos != null && minutos > 360) minutos = null;
    const aproxima = minutos != null || (v >= 5 && desvio < 50);
    const item = { km, rumo, kmh: v, minutos, aproxima, titulo: a.evento || a.titulo, nivel: a.nivel, cor: a.cor, raiosMin: d.raiosPorMin };
    // Prioridade: a que chega antes; depois a mais perto que se aproxima; depois a mais perto
    const nota = (x) => (x.minutos != null ? x.minutos : x.aproxima ? 1000 + x.km : 5000 + x.km);
    if (!melhor || nota(item) < nota(melhor)) melhor = item;
  }
  return melhor;
}

// Previsão das próximas 12 horas: primeira hora com trovoada e primeira hora com rajadas fortes
function previstoProximo(prev) {
  const h = prev.hourly, c = prev.current || {};
  if (!h?.time) return {};
  const i0 = Math.max(0, h.time.findIndex((t) => t.slice(0, 13) === String(c.time || '').slice(0, 13)));
  let temporal = null, vento = null;
  for (let k = 1; k <= 12 && i0 + k < h.time.length; k++) {
    const i = i0 + k;
    if (!temporal && h.weather_code[i] >= 95) temporal = { horas: k, hora: h.time[i].slice(11, 16), dir: h.wind_direction_10m?.[i] };
    if (!vento && h.wind_gusts_10m?.[i] >= 50) {
      let max = 0;
      for (let j = i; j <= Math.min(i0 + 12, h.time.length - 1); j++) max = Math.max(max, h.wind_gusts_10m[j] || 0);
      vento = { horas: k, hora: h.time[i].slice(11, 16), dir: h.wind_direction_10m?.[i], rajada: max };
    }
  }
  return { temporal, vento };
}

/* ======================= Desenho ======================= */
const nuvem = (x, y, s = 1, cls = '') => `<g class="cn-nuvem ${cls}" transform="translate(${x} ${y}) scale(${s})">
  <path d="M-34 14 a16 16 0 0 1 4 -31 a22 22 0 0 1 41 -6 a17 17 0 0 1 25 15 a14 14 0 0 1 -2 28 z"/></g>`;

// Gotas: quanto mais forte a chuva, mais gotas e mais rápidas
function gotas(x, y, largura, intens) {
  const p = INTENSIDADE[Math.max(1, Math.min(4, intens))];
  let g = '';
  for (let i = 0; i < p.gotas; i++) {
    const gx = x - largura / 2 + (largura * (i + 0.5)) / p.gotas + ((i * 37) % 7) - 3;
    const atraso = (((i * 0.37) % 1) * p.dur).toFixed(2);
    const comp = 7 + intens * 2;
    g += `<line class="cn-gota" x1="${gx.toFixed(1)}" y1="${y + ((i * 13) % 9)}" x2="${(gx - 2 - intens).toFixed(1)}" y2="${y + ((i * 13) % 9) + comp}" style="animation-delay:-${atraso}s"/>`;
  }
  return `<g class="cn-chuva" style="--dur:${p.dur}s;--larg:${p.larg}">${g}</g>`;
}

const raio = (x, y, atraso = 0) => `<path class="cn-raio" style="animation-delay:${atraso}s" d="M${x} ${y} l-8 18 h7 l-5 16 l14 -21 h-7 l6 -13 z"/>`;

// Linhas de vento soprando na direção da casa (ou passando por ela)
function vento(x, y, largura, paraDireita, forte) {
  let g = '';
  const n = forte ? 6 : 4;
  for (let i = 0; i < n; i++) {
    const yy = y + i * 11 + ((i * 7) % 5);
    const comp = 26 + ((i * 17) % 22);
    const xx = x - largura / 2 + ((i * 53) % Math.max(1, largura - comp));
    g += `<path class="cn-vento-linha" d="M${xx.toFixed(0)} ${yy} q ${comp / 2} -6 ${comp} 0" style="animation-delay:-${(i * 0.31).toFixed(2)}s"/>`;
  }
  return `<g class="cn-vento ${paraDireita ? 'p-dir' : 'p-esq'}${forte ? ' forte' : ''}">${g}</g>`;
}

function sol(x, y) {
  let raios = '';
  for (let i = 0; i < 8; i++) raios += `<line x1="0" y1="-24" x2="0" y2="-31" transform="rotate(${i * 45})"/>`;
  return `<g class="cn-sol" transform="translate(${x} ${y})"><g class="cn-raios">${raios}</g><circle r="16"/></g>`;
}
const lua = (x, y) => `<g class="cn-lua" transform="translate(${x} ${y})"><path d="M8 -15 a17 17 0 1 0 9 26 a13 13 0 0 1 -9 -26 z"/></g>`;
const estrelas = (W) => [[0.1, 30], [0.23, 18], [0.42, 12], [0.7, 26], [0.85, 44], [0.94, 16]]
  .map(([f, y], i) => `<circle class="cn-estrela" cx="${(f * W).toFixed(0)}" cy="${y}" r="1.4" style="animation-delay:${i * 0.5}s"/>`).join('');

const casa = (x) => `<g class="cn-casa" transform="translate(${x} 0)">
  <path class="cn-telhado" d="M-36 108 L0 78 L36 108"/>
  <rect class="cn-parede" x="-28" y="104" width="56" height="40" rx="2"/>
  <rect class="cn-porta" x="-7" y="120" width="14" height="24" rx="2"/>
  <rect class="cn-janela" x="-22" y="113" width="10" height="10" rx="1.5"/>
  <rect class="cn-janela" x="12" y="113" width="10" height="10" rx="1.5"/>
  <circle class="cn-pino" cx="0" cy="62" r="4"/><circle class="cn-pino-onda" cx="0" cy="62" r="4"/>
</g>`;

// Situação do céu agora: previsão por consenso, confirmada pelo radar quando houver
function ceuAgora(prev, radar) {
  const c = prev.current || {};
  const code = c.weather_code ?? 0;
  const mm = c.precipitation ?? 0;
  const neve = [71, 73, 75, 77, 85, 86].includes(code);
  let intens = Math.max(intensidadeMm(mm), neve ? 0 : intensidadeCodigo(code), radar?.aqui || 0);
  const chove = intens > 0 && !neve;
  if (!chove) intens = 0;
  return {
    dia: c.is_day === 1, intens, mm, chove,
    nuvens: c.cloud_cover ?? (code >= 3 ? 90 : code === 2 ? 50 : 10),
    trovoada: code >= 95,
    neblina: code === 45 || code === 48,
    ventoForte: (c.wind_gusts_10m ?? 0) >= 50 || (c.wind_speed_10m ?? 0) >= 35,
    rajada: c.wind_gusts_10m, dirVento: c.wind_direction_10m,
    desc: tempo(code, c.is_day === 1).desc,
  };
}

// Posição de algo ao lado da casa: fração (0 = encostado, 1 = na borda) → x
const posLado = (CASA, frac, direita) => {
  const maximo = Math.max(140, CASA - 45);
  const desloc = 85 + Math.min(1, Math.max(0, frac)) * (maximo - 85);
  return CASA + (direita ? desloc : -desloc);
};
// Lado na cena a partir do rumo (onde está): leste à direita, oeste à esquerda
const ehDireita = (rumo) => Math.sin((rumo * Math.PI) / 180) >= 0;

function regua(CASA, x, direita, rotulo, aproxima, y = 136) {
  const xi = CASA + (direita ? 46 : -46), xf = x + (direita ? -22 : 22);
  const seta = aproxima ? `<path class="cn-seta" d="M${xi} ${y} l${direita ? 9 : -9} -5 v10 z"/>` : '';
  return `<line class="cn-dist${aproxima ? ' chegando' : ''}${direita ? ' de-dir' : ''}" x1="${xi}" y1="${y}" x2="${xf}" y2="${y}"/>${seta}
    <text class="cn-km" x="${(xi + xf) / 2}" y="${y - 6}">${esc(rotulo)}</text>`;
}

function desenhar(el, prev, cidade, radar, alertas) {
  const ceu = ceuAgora(prev, radar);
  const tempestade = tempestadeProxima(alertas, cidade);
  const { temporal: temporalPrev, vento: ventoPrev } = previstoProximo(prev);
  // A cena ocupa toda a largura do cartão: a largura do desenho acompanha a proporção da tela
  const altura = Math.min(220, Math.max(150, innerWidth * 0.17));
  const W = Math.max(340, Math.round((160 * Math.max(300, el.clientWidth - 32)) / altura));
  const CASA = Math.round(W / 2), CHAO = 144;
  let fundo = '', perto = '', longe = '', legenda = '';
  const itens = []; // linhas do quadro "o que vem por aí"
  if (!ceu.dia) fundo += estrelas(W);

  // 1) O que está chegando, ao lado da casa (uma coisa por vez, a mais séria)
  let lado = null; // { direita }
  const ch = radar?.chuva;
  const tempestadeLonge = tempestade && tempestade.km >= 6 ? tempestade : null;
  if (tempestadeLonge && (tempestadeLonge.aproxima || !ch || ch.km > tempestadeLonge.km)) {
    const t = tempestadeLonge;
    const direita = ehDireita(t.rumo);
    const x = posLado(CASA, t.km / RAIO_TEMPORAL_KM, direita);
    longe += `<g class="cn-chegando${t.aproxima ? (direita ? ' vem-esq' : ' vem-dir') : ''}">${nuvem(x, 38, 1.05, 'tempestade')}${gotas(x, 58, 74, 4)}${raio(x + 10, 50)}${raio(x - 16, 54, 1.7)}</g>`;
    longe += regua(CASA, x, direita, `${num(t.km, 0)} km`, t.aproxima);
    lado = { direita };
  } else if (ch && !ceu.chove && ch.km >= 4) {
    const direita = ch.dx >= 0;
    const x = posLado(CASA, ch.km / RAIO_KM, direita);
    const intensa = ch.intens >= 4;
    longe += `<g class="cn-chegando${radar.aproximando ? (direita ? ' vem-esq' : ' vem-dir') : ''}">${nuvem(x, 42, 0.95, intensa ? 'tempestade' : 'escura')}${gotas(x, 62, 70, ch.intens)}${intensa ? raio(x + 12, 54) : ''}</g>`;
    longe += regua(CASA, x, direita, `${num(ch.km, 0)} km`, !!radar.aproximando);
    lado = { direita };
  } else if (temporalPrev && !ceu.trovoada) {
    // Sem tempestade no radar ou no detector: a trovoada prevista aparece ao lado, mais longe quanto mais demora
    const direita = temporalPrev.dir != null ? ehDireita(temporalPrev.dir) : true; // vem do lado de onde sopra o vento
    const x = posLado(CASA, temporalPrev.horas / 12, direita);
    longe += `<g class="cn-chegando prevista">${nuvem(x, 40, 1, 'tempestade')}${gotas(x, 60, 70, 3)}${raio(x + 10, 52)}</g>`;
    longe += regua(CASA, x, direita, `às ${temporalPrev.hora}`, true);
    lado = { direita };
  }

  // 2) Sobre a casa: o tempo de agora
  const ladoAstro = lado?.direita ? -1 : 1; // sol/lua do lado oposto ao que está chegando
  if (ceu.chove) {
    perto += nuvem(CASA + 4, 26, 1.1, ceu.trovoada || ceu.intens >= 4 ? 'tempestade' : 'escura') + gotas(CASA + 4, 46, 100, ceu.intens);
    if (ceu.trovoada) perto += raio(CASA + 40, 40) + raio(CASA - 30, 44, 2.1);
  } else if (ceu.neblina) {
    perto += `<g class="cn-neblina"><line x1="${CASA - 100}" y1="100" x2="${CASA + 100}" y2="100"/><line x1="${CASA - 80}" y1="114" x2="${CASA + 120}" y2="114"/><line x1="${CASA - 110}" y1="128" x2="${CASA + 80}" y2="128"/></g>`;
  } else {
    const astro = ceu.dia ? sol(CASA + 70 * ladoAstro, 44) : lua(CASA + 70 * ladoAstro, 44);
    if (ceu.nuvens < 35) perto += astro;
    else if (ceu.nuvens < 80) perto += astro + nuvem(CASA + 40 * ladoAstro, 54, 0.8, 'deriva');
    else perto += nuvem(CASA - 20, 40, 0.9, 'deriva') + nuvem(CASA + 50, 52, 1, 'deriva lenta');
  }
  // Vento forte agora: linhas passando pela casa, no sentido do vento (de onde sopra para onde vai)
  if (ceu.ventoForte) {
    const paraDireita = ceu.dirVento != null ? !ehDireita(ceu.dirVento) : true;
    perto += vento(CASA, 86, 220, paraDireita, true);
  } else if (ventoPrev) {
    // Vento forte previsto: linhas do lado de onde ele vem, indo em direção à casa
    const direita = ventoPrev.dir != null ? ehDireita(ventoPrev.dir) : true;
    const x = posLado(CASA, ventoPrev.horas / 12, direita);
    longe += vento(x, 92, 90, !direita, ventoPrev.rajada >= 75);
    if (!lado || lado.direita !== direita) longe += regua(CASA, x, direita, `às ${ventoPrev.hora}`, true, 118);
  }

  // 3) Texto: agora e o que vem, com de onde vem, a quantos km e em quanto tempo
  const agoraTxt = ceu.chove
    ? `<strong>Chuva ${INTENSIDADE[ceu.intens].nome}</strong>${ceu.mm >= 0.1 ? ` (cerca de ${num(ceu.mm)} mm/h)` : ''}${ceu.trovoada ? ' com trovoada' : ''}`
    : `<strong>${esc(ceu.desc)}</strong>`;
  itens.push({ tipo: 'agora', html: `Agora em ${esc(cidade.nome)}: ${agoraTxt}${ceu.ventoForte ? `, vento forte ${doLado(ceu.dirVento ?? 0)} com rajadas de ${num(ceu.rajada, 0)} km/h` : ''}.` });
  if (tempestade) {
    const t = tempestade;
    const sobre = t.km < 6;
    itens.push({ tipo: 'temporal', html: sobre
      ? `<strong>Tempestade sobre a cidade agora</strong> (${esc(t.titulo)}), detectada pelos raios.`
      : `<strong>Tempestade a ${num(t.km, 0)} km, ${aPonto(t.rumo)}</strong>`
        + (t.aproxima ? `, vindo para cá a ~${num(t.kmh, 0)} km/h${t.minutos != null ? ` · <strong>${chegaTxt(t.minutos)}</strong>${t.minutos >= 5 ? ` (por volta das ${horaMais(t.minutos)})` : ''}` : ''}` : ', sem vir para cá agora')
        + '. Detectada pelos raios (WeatherCenter).' });
  }
  if (ch && !ceu.chove) {
    itens.push({ tipo: 'chuva', html: `<strong>Chuva ${INTENSIDADE[ch.intens].nome} a ${num(ch.km, 0)} km, ${aPonto(ch.rumo)}</strong>`
      + (radar.aproximando ? `, se aproximando${radar.kmh ? ` a ~${num(radar.kmh, 0)} km/h` : ''}${radar.minutos != null ? ` · <strong>${chegaTxt(radar.minutos)}</strong>${radar.minutos >= 5 ? ` (por volta das ${horaMais(radar.minutos)})` : ''}` : ''}` : radar.aproximando === false ? ', sem se aproximar agora' : '')
      + '.' });
  } else if (radar && !ch && !ceu.chove) {
    itens.push({ tipo: 'ok', html: `Nenhuma chuva no radar num raio de ${RAIO_KM} km.` });
  }
  if (temporalPrev && !tempestade && !ceu.trovoada) {
    itens.push({ tipo: 'temporal', html: `<strong>Temporal previsto por volta das ${temporalPrev.hora}</strong> (em ~${temporalPrev.horas} h)${temporalPrev.dir != null ? `, com vento ${doLado(temporalPrev.dir)}` : ''}. Previsão por consenso de modelos.` });
  }
  if (ventoPrev && !ceu.ventoForte) {
    itens.push({ tipo: 'vento', html: `<strong>Vento forte ${ventoPrev.dir != null ? doLado(ventoPrev.dir) : ''} a partir das ${ventoPrev.hora}</strong> (em ~${ventoPrev.horas} h), rajadas de até ${num(ventoPrev.rajada, 0)} km/h.` });
  }

  if (radar?.hora) legenda = `Radar das ${radar.hora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · na cena, a distância é proporcional (chuva até ${RAIO_KM} km, temporal até ${RAIO_TEMPORAL_KM} km, previsão até 12 h)`;
  else if (radar === undefined) legenda = 'Consultando o radar…';
  else legenda = 'Radar indisponível agora: a cena usa a previsão e o detector de tempestades.';
  const classe = `cena-svg${ceu.dia ? ' dia' : ' noite'}${ceu.chove ? ' chovendo' : ''}${ceu.trovoada || (tempestade && tempestade.km < 6) ? ' trovoada' : ''}`;
  const texto = itens.map((i) => i.html.replace(/<[^>]+>/g, '')).join(' ');
  el.innerHTML = `<div class="cartao-topo"><h2 class="rotulo">Agora no seu local</h2><p class="resumo-horas">${legenda}</p></div>
    <svg class="${classe}" viewBox="0 0 ${W} 160" role="img" aria-label="${esc(texto)}">
      ${fundo}
      <line class="cn-chao" x1="0" y1="${CHAO}" x2="${W}" y2="${CHAO}"/>
      ${longe}${perto}${casa(CASA)}
    </svg>
    <ul class="cena-itens">${itens.map((i) => `<li class="ci-${i.tipo}">${i.html}</li>`).join('')}</ul>`;
}

let geracao = 0;
let timer = null;
let ultimo = null; // { prev, cidade, radar, alertas } para redesenhar quando a largura muda
if ('ResizeObserver' in window) {
  let largura = 0;
  const obs = new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (Math.abs(w - largura) < 24) return;
    largura = w;
    if (ultimo) desenhar($('c-cena'), ultimo.prev, ultimo.cidade, ultimo.radar, ultimo.alertas);
  });
  const el = document.getElementById('c-cena');
  if (el) obs.observe(el);
}

// alertas: lista de todos os alertas (usa as tempestades acompanhadas pelo detector do WeatherCenter)
export async function renderCena(prev, cidade, alertas = []) {
  const el = $('c-cena');
  if (!el) return;
  const minha = ++geracao;
  el.hidden = false;
  ultimo = { prev, cidade, radar: undefined, alertas };
  desenhar(el, prev, cidade, undefined, alertas);
  const atualizar = async () => {
    let radar = null;
    try { radar = await radarAgora(cidade.lat, cidade.lon); } catch (e) { console.warn('radar da cena', e); }
    if (minha !== geracao) return;
    ultimo = { ...ultimo, radar };
    desenhar(el, ultimo.prev, ultimo.cidade, radar, ultimo.alertas);
  };
  await atualizar();
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden && minha === geracao) atualizar(); }, 10 * 60 * 1000);
}

// Alertas atualizados (a cada 5 min): redesenha com as tempestades novas, sem consultar o radar de novo
export function atualizarAlertasCena(alertas) {
  if (!ultimo) return;
  ultimo = { ...ultimo, alertas };
  desenhar($('c-cena'), ultimo.prev, ultimo.cidade, ultimo.radar, alertas);
}
