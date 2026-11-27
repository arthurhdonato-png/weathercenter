// Cena animada do tempo agora: uma casa (o local escolhido) com sol, lua, nuvens, neblina, chuva ou raios.
// Se a chuva ainda não chegou, o radar (RainViewer) mostra onde está a chuva mais próxima: a nuvem de chuva
// aparece ao lado da casa, mais longe ou mais perto conforme a distância real, do lado de onde ela está,
// e se está se aproximando (comparando com o radar de 30 minutos antes).
import { $, esc, num, tempo } from './util.js';
import { radarQuadros } from './dados.js';

const RAIO_KM = 150;      // até onde o radar procura chuva
const ZOOM = 6;           // quadros de 256 px no zoom 6: ~2,4 km por pixel no equador
const ALFA_CHUVA = 255;   // no esquema de cores 2 do RainViewer, garoa muito fraca é semitransparente

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
  if (!melhor || melhor.d * kmPorPx > RAIO_KM) return null;
  const rumo = ((Math.atan2(melhor.dx, -melhor.dy) * 180) / Math.PI + 360) % 360; // 0 = norte, 90 = leste
  return { km: melhor.d * kmPorPx, rumo, dx: melhor.dx };
}

const PONTOS = ['norte', 'nordeste', 'leste', 'sudeste', 'sul', 'sudoeste', 'oeste', 'noroeste'];
const lado = (rumo) => PONTOS[Math.round(rumo / 45) % 8];

let radarCache = null;
async function radarAgora(lat, lon) {
  const chave = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (radarCache && radarCache.chave === chave && Date.now() - radarCache.t < 8 * 60 * 1000) return radarCache.v;
  const { host, quadros } = await radarQuadros();
  const passados = quadros.filter((q) => q.path && q.time * 1000 <= Date.now() + 60000);
  if (!passados.length) throw new Error('sem radar');
  const ultimo = passados[passados.length - 1];
  const antes = passados.find((q) => q.time >= ultimo.time - 30 * 60) || null;
  const [agora, anterior] = await Promise.all([
    chuvaMaisProxima(host, ultimo.path, lat, lon),
    antes && antes !== ultimo ? chuvaMaisProxima(host, antes.path, lat, lon).catch(() => null) : null,
  ]);
  let aproximando = null, minutos = null;
  if (agora && anterior) {
    const dt = (ultimo.time - antes.time) / 60;
    const ganho = anterior.km - agora.km;
    aproximando = ganho > 2;
    if (aproximando && dt > 0) {
      const v = ganho / dt; // km por minuto
      minutos = Math.round(agora.km / v);
      if (minutos > 300) minutos = null;
    }
  }
  const v = { chuva: agora, aproximando, minutos, hora: new Date(ultimo.time * 1000) };
  radarCache = { chave, t: Date.now(), v };
  return v;
}

/* ======================= Desenho ======================= */
const nuvem = (x, y, s = 1, cls = '') => `<g class="cn-nuvem ${cls}" transform="translate(${x} ${y}) scale(${s})">
  <path d="M-34 14 a16 16 0 0 1 4 -31 a22 22 0 0 1 41 -6 a17 17 0 0 1 25 15 a14 14 0 0 1 -2 28 z"/></g>`;

function gotas(x, y, largura, n, forte) {
  let g = '';
  for (let i = 0; i < n; i++) {
    const gx = x - largura / 2 + (largura * (i + 0.5)) / n + ((i * 37) % 7) - 3;
    const atraso = ((i * 0.23) % 1).toFixed(2);
    g += `<line class="cn-gota" x1="${gx.toFixed(1)}" y1="${y}" x2="${(gx - 3).toFixed(1)}" y2="${y + (forte ? 12 : 9)}" style="animation-delay:-${atraso}s"/>`;
  }
  return `<g class="cn-chuva${forte ? ' forte' : ''}">${g}</g>`;
}

const raio = (x, y) => `<path class="cn-raio" d="M${x} ${y} l-8 18 h7 l-5 16 l14 -21 h-7 l6 -13 z"/>`;

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

// Situação do céu agora, pela previsão por consenso
function ceuAgora(prev) {
  const c = prev.current || {};
  const code = c.weather_code ?? 0;
  const chuvaMm = c.precipitation ?? 0;
  return {
    dia: c.is_day === 1,
    nuvens: c.cloud_cover ?? (code >= 3 ? 90 : code === 2 ? 50 : 10),
    chove: (code >= 51 && code !== 71 && code !== 73 && code !== 75 && code !== 77) || chuvaMm >= 0.2,
    forte: code === 65 || code === 82 || code >= 95 || chuvaMm >= 4,
    trovoada: code >= 95,
    neblina: code === 45 || code === 48,
    desc: tempo(code, c.is_day === 1).desc,
  };
}

function desenhar(el, prev, cidade, radar) {
  const ceu = ceuAgora(prev);
  // A cena ocupa toda a largura do cartão: a largura do desenho acompanha a proporção da tela
  const altura = Math.min(220, Math.max(150, innerWidth * 0.17));
  const W = Math.max(340, Math.round((160 * Math.max(300, el.clientWidth - 32)) / altura));
  const CASA = Math.round(W / 2), CHAO = 144;
  let fundo = '', perto = '', longe = '', legenda = '';
  if (!ceu.dia) fundo += estrelas(W);
  const ch = radar?.chuva;
  const chuvaAoLado = !!(ch && !ceu.chove && ch.km >= 4);
  const ladoAstro = chuvaAoLado && ch.dx >= 0 ? -1 : 1; // sol/lua do lado oposto ao da chuva
  // Sobre a casa: o tempo de agora
  if (ceu.chove) {
    perto += nuvem(CASA + 4, 26, 1.1, 'escura') + gotas(CASA + 4, 46, 96, ceu.forte ? 13 : 9, ceu.forte);
    if (ceu.trovoada) perto += raio(CASA + 40, 40);
  } else if (ceu.neblina) {
    perto += `<g class="cn-neblina"><line x1="${CASA - 100}" y1="100" x2="${CASA + 100}" y2="100"/><line x1="${CASA - 80}" y1="114" x2="${CASA + 120}" y2="114"/><line x1="${CASA - 110}" y1="128" x2="${CASA + 80}" y2="128"/></g>`;
  } else {
    const astro = ceu.dia ? sol(CASA + 70 * ladoAstro, 44) : lua(CASA + 70 * ladoAstro, 44);
    if (ceu.nuvens < 35) perto += astro;
    else if (ceu.nuvens < 80) perto += astro + nuvem(CASA + 40 * ladoAstro, 54, 0.8, 'deriva');
    else perto += nuvem(CASA - 20, 40, 0.9, 'deriva') + nuvem(CASA + 50, 52, 1, 'deriva lenta');
  }
  // Ao lado: a chuva mais próxima pelo radar, se ainda não chegou
  let texto = `${esc(ceu.desc)} agora em ${esc(cidade.nome)}.`;
  if (chuvaAoLado) {
    const direita = ch.dx >= 0;
    const maximo = Math.max(140, CASA - 45);
    const desloc = 85 + (Math.min(ch.km, RAIO_KM) / RAIO_KM) * (maximo - 85); // mais longe = mais afastada da casa
    const x = CASA + (direita ? desloc : -desloc);
    longe += nuvem(x, 44, 0.95, 'escura') + gotas(x, 64, 70, 7, false);
    const xm = (x + CASA) / 2;
    const seta = radar.aproximando ? (direita ? `<path class="cn-seta" d="M${CASA + 46} 136 l9 -5 v10 z"/>` : `<path class="cn-seta" d="M${CASA - 46} 136 l-9 -5 v10 z"/>`) : '';
    longe += `<line class="cn-dist" x1="${CASA + (direita ? 46 : -46)}" y1="136" x2="${x + (direita ? -20 : 20)}" y2="136"/>${seta}
      <text class="cn-km" x="${xm}" y="130">${num(ch.km, 0)} km</text>`;
    texto = `${esc(ceu.desc)} agora em ${esc(cidade.nome)}. <strong>Chuva a cerca de ${num(ch.km, 0)} km, a ${lado(ch.rumo)}</strong>`
      + (radar.aproximando ? `, se aproximando${radar.minutos ? ` (pode chegar em uns ${radar.minutos < 60 ? `${radar.minutos} min` : `${Math.floor(radar.minutos / 60)} h${radar.minutos % 60 >= 10 ? ` ${radar.minutos % 60} min` : ''}`})` : ''}` : radar.aproximando === false ? ', sem se aproximar agora' : '')
      + '.';
  } else if (radar && !ch && !ceu.chove) {
    texto += ` Nenhuma chuva no radar num raio de ${RAIO_KM} km.`;
  } else if (ceu.chove) {
    texto = `<strong>${esc(ceu.desc)} agora em ${esc(cidade.nome)}.</strong>`;
  }
  if (radar?.hora) legenda = `Radar RainViewer das ${radar.hora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · a distância na cena é proporcional (até ${RAIO_KM} km)`;
  else if (radar === undefined) legenda = 'Consultando o radar…';
  else legenda = 'Radar indisponível agora: a cena mostra só a previsão para o local.';
  const classe = `cena-svg${ceu.dia ? ' dia' : ' noite'}${ceu.chove ? ' chovendo' : ''}${ceu.trovoada ? ' trovoada' : ''}`;
  el.innerHTML = `<div class="cartao-topo"><h2 class="rotulo">Agora no seu local</h2><p class="resumo-horas">${legenda}</p></div>
    <svg class="${classe}" viewBox="0 0 ${W} 160" role="img" aria-label="${esc(texto.replace(/<[^>]+>/g, ''))}">
      ${fundo}
      <line class="cn-chao" x1="0" y1="${CHAO}" x2="${W}" y2="${CHAO}"/>
      ${longe}${perto}${casa(CASA)}
    </svg>
    <p class="cena-texto">${texto}</p>`;
}

let geracao = 0;
let timer = null;
let ultimo = null; // { prev, cidade, radar } para redesenhar quando a largura muda
if ('ResizeObserver' in window) {
  let largura = 0;
  const obs = new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (Math.abs(w - largura) < 24) return;
    largura = w;
    if (ultimo) desenhar($('c-cena'), ultimo.prev, ultimo.cidade, ultimo.radar);
  });
  const el = document.getElementById('c-cena');
  if (el) obs.observe(el);
}
export async function renderCena(prev, cidade) {
  const el = $('c-cena');
  if (!el) return;
  const minha = ++geracao;
  el.hidden = false;
  ultimo = { prev, cidade, radar: undefined };
  desenhar(el, prev, cidade, undefined);
  const atualizar = async () => {
    let radar = null;
    try { radar = await radarAgora(cidade.lat, cidade.lon); } catch (e) { console.warn('radar da cena', e); }
    if (minha !== geracao) return;
    ultimo = { prev, cidade, radar };
    desenhar(el, prev, cidade, radar);
  };
  await atualizar();
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden && minha === geracao) atualizar(); }, 10 * 60 * 1000);
}
