// Focos de incêndio (INPE, últimas 24 h), no estilo do Google Maps: um ícone de fogo por grupo
// de focos próximos e, de perto, as áreas queimando no tamanho real.
/* global L */
import { getJSON, comCache, store, num } from './util.js';
import { API } from './dados.js';

export function dadosFocos() {
  const url = `${API.focos}?v=${Math.floor(Date.now() / 120000)}`;
  return comCache('wc:focos', 4 * 60 * 1000, () => getJSON(url, 30000));
}

// Cor pela idade da última detecção
function corIdade(horas) {
  if (horas < 3) return '#E8210C';
  if (horas < 12) return '#F2600C';
  return '#F59E0B';
}

const ICONE_FOGO = (tamanho) => L.divIcon({
  className: 'icone-fogo',
  html: `<svg viewBox="0 0 24 24" width="${tamanho}" height="${tamanho}" aria-hidden="true">
    <circle cx="12" cy="12" r="11.5" fill="#fff" stroke="rgba(0,0,0,.18)"/>
    <path d="M12.6 3.5c.4 2.6-1 4.1-2.3 5.6-1.2 1.4-2.4 2.8-2.4 5a4.6 4.6 0 0 0 9.2.2c0-1.9-.8-3.1-1.6-4.1-.2 1-.7 1.8-1.5 2.2.6-2.6-.2-6.3-1.4-8.9z" fill="#E8210C"/>
    <path d="M12.3 12.2c-1.1 1.2-1.9 2.1-1.9 3.4a2 2 0 0 0 4 .1c0-1.2-.7-2-1.5-2.7-.1.4-.3.7-.6.9 0-.6 0-1.1 0-1.7z" fill="#FFC107"/>
  </svg>`,
  iconSize: [tamanho, tamanho],
  iconAnchor: [tamanho / 2, tamanho / 2],
});

function popupTexto(n, ultimoMin, areas) {
  const quando = new Date(ultimoMin * 60000);
  const hora = quando.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `<div class="popup-fogo"><strong>🔥 Foco de incêndio</strong>
    <p>${areas > 1 ? `${num(areas, 0)} áreas com fogo nesta região. ` : ''}${num(n, 0)} detecção${n === 1 ? '' : 'ões'} por satélite nas últimas 24 horas.</p>
    <p class="pequeno">Última detecção: ${hora}. Fonte: INPE, Programa Queimadas.</p></div>`;
}

export function camadaIncendios(mapa) {
  mapa.createPane('incendios');
  mapa.getPane('incendios').style.zIndex = 420;
  const renderer = L.canvas({ pane: 'incendios', padding: 0.3 });
  const grupo = L.layerGroup();
  let celulas = [];
  let ligado = store.get('wc:mostrarFogo', true) !== false;
  let agendado = null;

  function desenhar() {
    grupo.clearLayers();
    if (!ligado || !celulas.length) return;
    const zoom = mapa.getZoom();
    const agoraMin = Date.now() / 60000;
    const limites = mapa.getBounds().pad(0.2);
    const visiveis = celulas.filter(([lat, lon]) => limites.contains([lat, lon]));
    // 1) As áreas: de perto no tamanho real (~2 km), de longe um ponto
    for (const [lat, lon, n, ult] of visiveis) {
      const cor = corIdade((agoraMin - ult) / 60);
      const opcoes = { renderer, stroke: true, color: cor, weight: 1, opacity: 0.9, fillColor: cor, bubblingMouseEvents: false };
      (zoom >= 8
        ? L.circle([lat, lon], { ...opcoes, radius: 900 + Math.min(n, 30) * 20, fillOpacity: 0.45 })
        : L.circleMarker([lat, lon], { ...opcoes, radius: zoom < 5 ? 2 : 3, fillOpacity: 0.85 })
      ).bindPopup(popupTexto(n, ult, 1)).addTo(grupo);
    }
    // 2) Um ícone de fogo por grupo de áreas próximas na tela (como no Google Maps)
    const PX = 64;
    const grupos = new Map();
    for (const [lat, lon, n, ult] of visiveis) {
      const p = mapa.latLngToLayerPoint([lat, lon]);
      const k = `${Math.floor(p.x / PX)},${Math.floor(p.y / PX)}`;
      const g = grupos.get(k) || { lat: 0, lon: 0, n: 0, ult: 0, areas: 0 };
      g.lat += lat; g.lon += lon; g.n += n; g.areas += 1; g.ult = Math.max(g.ult, ult);
      grupos.set(k, g);
    }
    [...grupos.values()].sort((a, b) => b.areas - a.areas).slice(0, 120).forEach((g) => {
      const tam = Math.round(Math.min(30, 18 + Math.log2(g.areas) * 2.5));
      L.marker([g.lat / g.areas, g.lon / g.areas], { icon: ICONE_FOGO(tam), pane: 'incendios', bubblingMouseEvents: false })
        .bindPopup(popupTexto(g.n, g.ult, g.areas)).addTo(grupo);
    });
  }

  const agendar = () => { cancelAnimationFrame(agendado); agendado = requestAnimationFrame(desenhar); };
  mapa.on('zoomend moveend', agendar);
  grupo.addTo(mapa);

  return {
    async carregar() {
      const d = await dadosFocos();
      const geradoMin = new Date(d.gerado_em).getTime() / 60000;
      // Arquivo muito velho (coletor parado): não mostra
      celulas = Date.now() / 60000 - geradoMin > 6 * 60 ? [] : (d.celulas || []).filter(([, , , ult]) => Date.now() / 60000 - ult < 24 * 60);
      agendar();
      return celulas.length;
    },
    ligar(v) {
      ligado = v;
      store.set('wc:mostrarFogo', v);
      agendar();
    },
    get ligado() { return ligado; },
  };
}
