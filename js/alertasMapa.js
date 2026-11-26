// Mapa do Brasil com todos os alertas ativos
/* global L */
import { $, esc, UF_NOMES, UF_POR_CODIGO } from './util.js';
import { todosAlertas, municipiosDoEstado, FONTES_ALERTA } from './dados.js';
import { basemap, linhasEstados } from './mapas.js';
import { cartaoAlerta } from './previsao.js';
import { rotulosCidades } from './rotulosCidades.js';
import { camadaIncendios } from './incendios.js';

const CODIGO_POR_UF = Object.fromEntries(Object.entries(UF_POR_CODIGO).map(([c, uf]) => [uf, c]));

const estado = { mapa: null, grupo: null, alertas: [], areas: [], filtroUF: '', status: {}, coletadoEm: null };

function dentroAnel(lon, lat, anel) {
  let d = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [xi, yi] = anel[i], [xj, yj] = anel[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) d = !d;
  }
  return d;
}

function aneisDaFeature(f) {
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.map((p) => p[0]);
}

// Monta a área de cada alerta: polígono próprio ou os municípios afetados
async function areasDosAlertas(alertas) {
  const precisaUF = new Set();
  for (const a of alertas) if (!a.poligonos.length) for (const g of a.geocodes) precisaUF.add(g.slice(0, 2));
  const malhas = {};
  await Promise.all([...precisaUF].map(async (cod) => {
    try { malhas[cod] = await municipiosDoEstado(cod); } catch (e) { console.warn('Malha do estado', cod, e); }
  }));
  const featurePorCodigo = new Map();
  for (const geo of Object.values(malhas)) {
    for (const f of geo.features || []) {
      const c = String(f.properties?.codarea ?? f.properties?.CD_MUN ?? '');
      featurePorCodigo.set(c, f);
      featurePorCodigo.set(c.slice(0, 6), f);
    }
  }
  return alertas.map((a) => {
    if (a.poligonos.length) {
      return { alerta: a, aneis: a.poligonos.map((p) => p.map(([lat, lon]) => [lon, lat])) };
    }
    const aneis = [];
    for (const g of a.geocodes) { const f = featurePorCodigo.get(g); if (f) aneis.push(...aneisDaFeature(f)); }
    return { alerta: a, aneis };
  });
}

function desenhar() {
  if (!estado.mapa) return;
  if (estado.grupo) estado.grupo.remove();
  estado.grupo = L.layerGroup().addTo(estado.mapa);
  const visiveis = estado.areas.filter(({ alerta }) => !estado.filtroUF || alerta.estados.includes(estado.filtroUF));
  // Menos graves primeiro, para os mais graves ficarem por cima
  [...visiveis].sort((x, y) => x.alerta.nivel - y.alerta.nivel).forEach(({ alerta, aneis }) => {
    if (!aneis.length) return;
    L.polygon(aneis.map((anel) => anel.map(([lon, lat]) => [lat, lon])), {
      color: alerta.cor, weight: 1, opacity: 0.9, fillColor: alerta.cor, fillOpacity: 0.45, interactive: false, pane: 'areasAlerta',
    }).addTo(estado.grupo);
  });
  renderLista(visiveis.map((v) => v.alerta));
}

function renderLista(alertas) {
  const el = $('alertas-lista');
  const titulo = estado.filtroUF ? UF_NOMES[estado.filtroUF] : 'Brasil';
  if (!Object.values(estado.status).includes('ok')) {
    el.innerHTML = '<div class="aviso-neutro">⚠️ Não foi possível consultar os alertas agora.</div>';
    return;
  }
  el.innerHTML = `<h3 class="lista-titulo">${alertas.length} alerta${alertas.length === 1 ? '' : 's'} ativo${alertas.length === 1 ? '' : 's'} · ${esc(titulo)}</h3>`
    + (alertas.length ? alertas.map((a) => `${cartaoAlerta(a)}${a.estados.length ? `<p class="area-alerta">Estados: ${a.estados.map((u) => esc(u)).join(', ')}</p>` : ''}`).join('')
      : '<div class="aviso-neutro ok">✅ Nenhum alerta ativo nesta região.</div>');
}

function renderFontes() {
  const hora = estado.coletadoEm ? estado.coletadoEm.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;
  $('alertas-fontes').innerHTML = FONTES_ALERTA.map((f) => {
    const st = !f.ativa ? 'off' : estado.status[f.id] === 'erro' ? 'erro' : estado.status[f.id] === 'ok' ? 'ok' : 'espera';
    const rot = st === 'ok' ? (f.ativa === 'coletor' ? `Conectado${hora ? ` · verificado às ${hora}` : ''}` : 'Conectado ao vivo')
      : st === 'erro' ? 'Fora do ar agora' : st === 'espera' ? 'Verificando…' : 'Sem dados abertos';
    return `<li class="fonte-${st === 'espera' ? 'off' : st}">
      <span class="fonte-ponto" aria-hidden="true"></span>
      <div><strong>${f.site ? `<a href="${f.site}" target="_blank" rel="noopener">${esc(f.nome)}</a>` : esc(f.nome)}</strong> <span class="fonte-st">${rot}</span>
      <div class="pequeno">${esc(f.descricao)}${f.motivo ? `. ${esc(f.motivo)}` : ''}</div></div>
    </li>`;
  }).join('');
}

export async function iniciarAlertasMapa() {
  if (estado.mapa) { estado.mapa.invalidateSize(); return; }
  const mapa = L.map('mapa-alertas', { minZoom: 3, maxZoom: 13, zoomSnap: 0.5 }).fitBounds([[-33.8, -74], [5.3, -34.8]]);
  estado.mapa = mapa;
  mapa.createPane('areasAlerta').style.zIndex = 380;
  mapa.createPane('linhas').style.zIndex = 400;
  basemap(mapa, { rotulos: false });
  linhasEstados(mapa);
  rotulosCidades(mapa);

  // Incêndios: liga/desliga na legenda
  const fogo = camadaIncendios(mapa);
  const caixaFogo = $('mostrar-fogo');
  caixaFogo.checked = fogo.ligado;
  caixaFogo.addEventListener('change', () => fogo.ligar(caixaFogo.checked));
  fogo.carregar().then((n) => {
    $('fogo-qtd').textContent = n ? `${n.toLocaleString('pt-BR')} áreas` : 'nenhum foco';
  }).catch((e) => { console.warn('focos', e); $('fogo-qtd').textContent = 'indisponível'; });

  $('alertas-uf').innerHTML = `<option value="">Todo o Brasil</option>${Object.entries(UF_NOMES).sort((a, b) => a[1].localeCompare(b[1])).map(([s, n]) => `<option value="${s}">${n}</option>`).join('')}`;
  $('alertas-uf').addEventListener('change', (e) => {
    estado.filtroUF = e.target.value;
    desenhar();
    if (estado.filtroUF) {
      const aneis = estado.areas.filter((a) => a.alerta.estados.includes(estado.filtroUF)).flatMap((a) => a.aneis);
      if (aneis.length) mapa.fitBounds(L.latLngBounds(aneis.flat().map(([lon, lat]) => [lat, lon])), { maxZoom: 7 });
    } else mapa.fitBounds([[-33.8, -74], [5.3, -34.8]]);
  });

  mapa.on('click', (e) => {
    const { lat, lng } = e.latlng;
    const achados = estado.areas.filter(({ alerta, aneis }) => (!estado.filtroUF || alerta.estados.includes(estado.filtroUF))
      && aneis.some((anel) => dentroAnel(lng, lat, anel)));
    if (!achados.length) return;
    L.popup({ maxWidth: 320, maxHeight: 360 }).setLatLng(e.latlng)
      .setContent(`<div class="popup-alertas">${achados.map(({ alerta }) => cartaoAlerta(alerta)).join('')}</div>`).openOn(mapa);
  });

  renderFontes();
  $('alertas-status').hidden = false;
  $('alertas-status').textContent = 'Carregando alertas…';
  try {
    const { alertas, status, coletadoEm } = await todosAlertas();
    estado.status = status;
    estado.coletadoEm = coletadoEm;
    estado.alertas = alertas;
    renderFontes();
    estado.areas = await areasDosAlertas(alertas);
    $('alertas-status').hidden = true;
    desenhar();
  } catch (e) {
    console.error(e);
    $('alertas-status').textContent = 'Não foi possível carregar os alertas agora.';
  }
}

export { CODIGO_POR_UF };
