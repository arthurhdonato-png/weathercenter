// Comportamento comum dos mapas do app, que agora ficam no meio da página (não em abas separadas):
//  - só o Brasil aparece: os outros países e o alto-mar ficam cobertos por uma máscara neutra
//    (fica só uma faixa de mar junto à costa) e o mapa não se afasta do território;
//  - no computador, a rodinha do mouse (ou a pinça do trackpad) sobre o mapa aproxima e afasta;
//  - no celular, um dedo rola a página e dois dedos movem e aproximam o mapa, como no Google Maps;
//  - botão de tela cheia, onde o mapa volta a responder a um dedo.
/* global L */
import { mascaraPronta } from './dados.js';
import { temaEscuro } from './mapaBase.js';

export const LIMITES_BRASIL = [[-34.2, -74.2], [5.6, -34.4]];
// Até onde o mapa pode ser arrastado (inclui o mar territorial e as ilhas oceânicas)
const LIMITES_MAXIMOS = [[-40, -82], [11, -24]];

// A máscara (mundo menos o Brasil, menos uma faixa de mar junto à costa e às ilhas oceânicas) vem pronta de
// dados/mascara-brasil.json, gerada por ferramentas/contornos.py a partir da malha do IBGE em qualidade máxima,
// com folga de ~1 km para fora: nenhuma parte do território fica coberta.
let mascaraPromessa = null;
function geometriaMascara() {
  if (!mascaraPromessa) {
    mascaraPromessa = mascaraPronta().then((geo) => {
      const polys = [];
      for (const f of geo.features || [geo]) {
        const g = f.geometry || f;
        if (g.type === 'Polygon') polys.push(g.coordinates);
        else if (g.type === 'MultiPolygon') polys.push(...g.coordinates);
      }
      return polys;
    }).catch((e) => { mascaraPromessa = null; throw e; });
  }
  return mascaraPromessa;
}

const paraLatLng = (multi) => multi.map((poly) => poly.map((anel) => anel.map(([lon, lat]) => [lat, lon])));
const corFundo = () => getComputedStyle(document.documentElement).getPropertyValue('--mapa-fora').trim() || (temaEscuro() ? '#10161d' : '#e6e9ee');

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
      pane: 'mascara', interactive: false, stroke: true, color: temaEscuro() ? '#3a4756' : '#b4bcc6', weight: 1, opacity: 0.9,
      fillColor: corFundo(), fillOpacity: 1, smoothFactor: 0.5,
    }).addTo(mapa);
    document.addEventListener('wc:tema', () => camada.setStyle({ fillColor: corFundo(), color: temaEscuro() ? '#3a4756' : '#b4bcc6' }));
    return camada;
  } catch (e) {
    console.warn('Máscara do Brasil indisponível', e);
    return null;
  }
}

/* ======================= Gestos numa página que rola ======================= */
const ehToque = () => matchMedia('(pointer: coarse)').matches || ('ontouchstart' in window && navigator.maxTouchPoints > 0);

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

  // Computador: a rodinha do mouse sobre o mapa aproxima e afasta, centrada no ponteiro
  // (a pinça do trackpad chega como Ctrl + rolagem, com passos pequenos)
  let acumulado = 0, quadro = null, ultimoPonto = null;
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    esconderDica();
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    acumulado += -px / (e.ctrlKey && Math.abs(px) < 50 ? 60 : 160);
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
