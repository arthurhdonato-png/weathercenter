// Comportamento comum dos mapas do app, que agora ficam no meio da página (não em abas separadas):
//  - só o Brasil aparece: os outros países e o alto-mar ficam cobertos por uma máscara neutra
//    (fica só uma faixa de mar junto à costa) e o mapa não se afasta do território;
//  - rolar a página por cima do mapa rola a página: zoom com Ctrl + rolagem (ou pinça no trackpad)
//    no computador e com dois dedos no celular, como no Google Maps;
//  - botão de tela cheia, onde o mapa volta a responder a um dedo e à rolagem do mouse.
/* global L, polygonClipping */
import { contornoBrasil } from './dados.js';
import { temaEscuro } from './mapaBase.js';

export const LIMITES_BRASIL = [[-34.2, -74.2], [5.6, -34.4]];
// Até onde o mapa pode ser arrastado (inclui o mar territorial e as ilhas oceânicas)
const LIMITES_MAXIMOS = [[-40, -82], [11, -24]];

// Faixa de mar ao longo da costa (lon, lat), parecida com a zona marítima brasileira: deixa o litoral,
// as ilhas próximas e os nomes das cidades da costa inteiros. O lado de dentro passa por terra brasileira.
const MAR = [[-51.6, 4.4], [-50.5, 6.5], [-48, 4.5], [-45.5, 1.2], [-42, -0.3], [-38.5, -1.4], [-34.2, -3.0], [-32, -3.0],
  [-31.8, -4.6], [-32.6, -5.6], [-32.6, -8.5], [-33.6, -11], [-36.5, -14], [-36.8, -18], [-37.8, -21.5], [-40.5, -25.2],
  [-45.5, -27], [-47.2, -29.8], [-49.8, -33.2], [-52.2, -35.4], [-53.37, -33.75], [-52.5, -32], [-50, -20], [-45, -10],
  [-50, 0], [-51.6, 4.4]];
const MUNDO = [[-150, -85], [30, -85], [30, 60], [-150, 60], [-150, -85]];

let geometriaBrasil = null;
// MultiPolígono do Brasil no formato do polygon-clipping: [ [ anel(lon,lat), buracos... ], ... ]
export function brasilMulti() {
  if (!geometriaBrasil) {
    geometriaBrasil = contornoBrasil().then((geo) => {
      const polys = [];
      for (const f of geo.features || [geo]) {
        const g = f.geometry || f;
        if (g.type === 'Polygon') polys.push(g.coordinates);
        else if (g.type === 'MultiPolygon') polys.push(...g.coordinates);
      }
      return polys;
    }).catch((e) => { geometriaBrasil = null; throw e; });
  }
  return geometriaBrasil;
}

let mascaraPromessa = null;
function geometriaMascara() {
  if (!mascaraPromessa) {
    mascaraPromessa = brasilMulti().then((brasil) => polygonClipping.difference([MUNDO], brasil, [MAR]))
      .catch((e) => { mascaraPromessa = null; throw e; });
  }
  return mascaraPromessa;
}

const paraLatLng = (multi) => multi.map((poly) => poly.map((anel) => anel.map(([lon, lat]) => [lat, lon])));
const corFundo = () => getComputedStyle(document.documentElement).getPropertyValue('--mapa-fora').trim() || (temaEscuro() ? '#22211e' : '#ecebe6');

// Cobre tudo o que não é o Brasil; o contorno do país fica marcado com uma linha discreta
export async function mascaraBrasil(mapa) {
  if (!mapa.getPane('mascara')) {
    mapa.createPane('mascara');
    mapa.getPane('mascara').style.zIndex = 655; // acima do mapa de fundo e dos nomes (650)
    mapa.getPane('mascara').style.pointerEvents = 'none';
  }
  try {
    const multi = await geometriaMascara();
    const camada = L.polygon(paraLatLng(multi), {
      pane: 'mascara', interactive: false, stroke: true, color: temaEscuro() ? '#6d6a62' : '#b9b5aa', weight: 1, opacity: 0.9,
      fillColor: corFundo(), fillOpacity: 1, smoothFactor: 0.5,
    }).addTo(mapa);
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => camada.setStyle({ fillColor: corFundo() }));
    return camada;
  } catch (e) {
    console.warn('Máscara do Brasil indisponível', e);
    return null;
  }
}

/* ======================= Gestos numa página que rola ======================= */
const ehToque = () => matchMedia('(pointer: coarse)').matches || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
const ehMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function prepararMapa(mapa, tela) {
  const container = mapa.getContainer();
  mapa.setMaxBounds(LIMITES_MAXIMOS);
  mapa.options.maxBoundsViscosity = 0.8;
  mapa.scrollWheelZoom.disable();

  const dica = document.createElement('div');
  dica.className = 'mapa-dica';
  dica.setAttribute('aria-hidden', 'true');
  tela.appendChild(dica);
  let timerDica = null;
  const mostrarDica = (texto) => {
    dica.textContent = texto;
    dica.classList.add('visivel');
    clearTimeout(timerDica);
    timerDica = setTimeout(() => dica.classList.remove('visivel'), 1300);
  };
  const esconderDica = () => { clearTimeout(timerDica); dica.classList.remove('visivel'); };
  const cheia = () => tela.classList.contains('mapa-cheia');

  // Computador: Ctrl/⌘ + rolagem (e a pinça do trackpad, que chega como Ctrl + rolagem) dá zoom
  let acumulado = 0, quadro = null, ultimoPonto = null;
  container.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey || cheia())) {
      mostrarDica(`Use ${ehMac() ? '⌘' : 'Ctrl'} + rolagem para aproximar o mapa`);
      return; // a página rola normalmente
    }
    e.preventDefault();
    esconderDica();
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    acumulado += -px / (e.ctrlKey && Math.abs(px) < 50 ? 60 : 220);
    ultimoPonto = mapa.mouseEventToContainerPoint(e);
    if (!quadro) {
      quadro = requestAnimationFrame(() => {
        quadro = null;
        const z = Math.max(mapa.getMinZoom(), Math.min(mapa.getMaxZoom(), mapa.getZoom() + acumulado));
        acumulado = 0;
        mapa.setZoomAround(ultimoPonto, z, { animate: false });
      });
    }
  }, { passive: false });

  // Celular: um dedo rola a página; dois dedos movem e aproximam o mapa
  if (ehToque()) {
    mapa.dragging.disable();
    if (mapa.tap) mapa.tap.disable();
    const tratar = (e) => {
      if (cheia()) return;
      if (e.touches.length >= 2) { mapa.dragging.enable(); esconderDica(); }
      else {
        mapa.dragging.disable();
        if (e.type === 'touchmove') mostrarDica('Use dois dedos para mover o mapa');
      }
    };
    container.addEventListener('touchstart', tratar, { passive: true, capture: true });
    container.addEventListener('touchmove', tratar, { passive: true, capture: true });
    container.addEventListener('touchend', (e) => { if (!cheia() && e.touches.length < 2) setTimeout(() => { if (!cheia()) mapa.dragging.disable(); }, 0); }, { passive: true, capture: true });
  }

  // Tela cheia
  const botao = document.createElement('button');
  botao.type = 'button';
  botao.className = 'mapa-flutuante btn-cheia';
  const icone = (abrir) => (abrir
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>');
  const atualizarBotao = () => {
    const c = cheia();
    botao.innerHTML = icone(!c);
    botao.setAttribute('aria-label', c ? 'Sair da tela cheia' : 'Abrir o mapa em tela cheia');
    botao.title = c ? 'Sair da tela cheia (Esc)' : 'Tela cheia';
  };
  const alternar = (ligar = !cheia()) => {
    tela.classList.toggle('mapa-cheia', ligar);
    document.body.classList.toggle('com-mapa-cheio', ligar);
    if (ligar || !ehToque()) mapa.dragging.enable(); else mapa.dragging.disable();
    atualizarBotao();
    requestAnimationFrame(() => mapa.invalidateSize());
  };
  botao.addEventListener('click', () => alternar());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cheia()) alternar(false); });
  atualizarBotao();
  tela.appendChild(botao);
  return { alternarTelaCheia: alternar };
}
