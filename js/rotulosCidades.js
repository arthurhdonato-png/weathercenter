// Nomes das cidades no mapa: as maiores aparecem primeiro e as menores vão surgindo com o zoom.
/* global L */
import { esc, getJSON } from './util.js';

let cidades = null;
function carregar() {
  if (!cidades) {
    cidades = getJSON('dados/cidades.json', 30000)
      .then((d) => d.cidades.map(([nome, uf, lat, lon, pop, capital]) => ({ nome, uf, lat, lon, pop, capital })))
      .catch((e) => { cidades = null; throw e; });
  }
  return cidades;
}

// População mínima para aparecer em cada zoom (com colisão, nomes não se sobrepõem)
function populacaoMinima(zoom, temPopulacao) {
  if (!temPopulacao) return zoom < 6 ? Infinity : 0; // sem dados de população: só capitais até o zoom 6
  if (zoom < 5) return Infinity; // só capitais
  if (zoom < 6) return 500000;
  if (zoom < 7) return 150000;
  if (zoom < 8) return 50000;
  if (zoom < 9) return 15000;
  return 0;
}

const MAX_ROTULOS = 160;

export function rotulosCidades(mapa) {
  mapa.createPane('rotulosCidades');
  mapa.getPane('rotulosCidades').style.zIndex = 650;
  mapa.getPane('rotulosCidades').style.pointerEvents = 'none';
  const grupo = L.layerGroup().addTo(mapa);
  let lista = [];
  let temPopulacao = false;
  let agendado = null;

  function desenhar() {
    grupo.clearLayers();
    if (!lista.length) return;
    const zoom = mapa.getZoom();
    const minPop = populacaoMinima(zoom, temPopulacao);
    const limites = mapa.getBounds().pad(0.05);
    const tamanho = mapa.getSize();
    const ocupados = [];
    const colide = (b) => ocupados.some((o) => b.x1 < o.x2 && b.x2 > o.x1 && b.y1 < o.y2 && b.y2 > o.y1);
    let n = 0;
    for (const c of lista) {
      if (n >= MAX_ROTULOS) break;
      if (!c.capital && c.pop < minPop) continue;
      if (!limites.contains([c.lat, c.lon])) continue;
      const p = mapa.latLngToContainerPoint([c.lat, c.lon]);
      if (p.x < -40 || p.y < -20 || p.x > tamanho.x + 40 || p.y > tamanho.y + 20) continue;
      const fonte = c.capital ? 13 : zoom >= 9 ? 12 : 11.5;
      const largura = c.nome.length * fonte * 0.56 + 10;
      const caixa = { x1: p.x - 10, y1: p.y - fonte - 4, x2: p.x + largura + 6, y2: p.y + fonte * 0.6 + 4 }; // com folga
      if (colide(caixa)) continue;
      ocupados.push(caixa);
      L.marker([c.lat, c.lon], {
        pane: 'rotulosCidades',
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: `rotulo-cidade${c.capital ? ' capital' : ''}`,
          html: `<i></i><span>${esc(c.nome)}</span>`,
          iconSize: null,
          iconAnchor: [3, 3],
        }),
      }).addTo(grupo);
      n++;
    }
  }

  const agendar = () => { cancelAnimationFrame(agendado); agendado = requestAnimationFrame(desenhar); };
  mapa.on('zoomend moveend resize', agendar);
  carregar().then((l) => {
    lista = l;
    temPopulacao = l.some((c) => c.pop > 0);
    agendar();
  }).catch((e) => console.warn('Lista de cidades indisponível', e));
  return grupo;
}
