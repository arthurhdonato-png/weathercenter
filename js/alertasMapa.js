// Mapa do Brasil com todos os alertas ativos, filtros (estado e severidade), linha do tempo e lista.
/* global L, polygonClipping */
import { $, esc, store, UF_NOMES, UF_POR_CODIGO } from './util.js';
import { todosAlertas, municipiosDoEstado, contornoEstados, FONTES_ALERTA } from './dados.js';
import { basemap } from './mapaBase.js';
import { cartaoAlerta } from './previsao.js';
import { rotulosCidades } from './rotulosCidades.js';
import { camadaIncendios } from './incendios.js';
import { mascaraBrasil, prepararMapa, LIMITES_BRASIL } from './mapaControles.js';
import { renderLinhaTempo } from './linhaTempoAlertas.js';

const CODIGO_POR_UF = Object.fromEntries(Object.entries(UF_POR_CODIGO).map(([c, uf]) => [uf, c]));

// Grupos de severidade (o nível 0, "aviso" informativo, entra junto com o moderado)
const SEVERIDADES = [
  { n: 3, nome: 'Extremo', cor: '#E60000', dica: 'Grande perigo (vermelho)' },
  { n: 2, nome: 'Severo', cor: '#FF8C00', dica: 'Perigo (laranja)' },
  { n: 1, nome: 'Moderado', cor: '#FFD400', dica: 'Perigo potencial (amarelo)' },
];
const grupoSev = (a) => Math.max(1, Math.min(3, Number(a.nivel) || 1));

const estado = {
  mapa: null, grupo: null, foco: null, alertas: [], areas: [], carregado: false,
  filtroUF: '', severidades: new Set(store.get('wc:sevAlertas', [1, 2, 3])),
  status: {}, coletadoEm: null, ufGeo: null, recortes: new Map(), visiveis: [],
};

/* ======================= Geometria ======================= */
function dentroAnel(lon, lat, anel) {
  let d = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [xi, yi] = anel[i], [xj, yj] = anel[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) d = !d;
  }
  return d;
}
// MultiPolígono (lon,lat): [ [anelExterno, buracos...], ... ]
const dentroMulti = (lon, lat, multi) => multi.some((poly) => dentroAnel(lon, lat, poly[0]) && !poly.slice(1).some((b) => dentroAnel(lon, lat, b)));

function poligonosDaFeature(f) {
  const g = f.geometry;
  return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
}
const fechar = (anel) => {
  const a = anel[0], b = anel[anel.length - 1];
  return a[0] === b[0] && a[1] === b[1] ? anel : [...anel, a];
};

// Monta a área de cada alerta: municípios afetados (por código) e/ou polígono próprio
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
      return { alerta: a, municipios: [], poligonos: a.poligonos.filter((p) => p.length >= 3).map((p) => [fechar(p.map(([lat, lon]) => [lon, lat]))]) };
    }
    const municipios = [];
    for (const g of a.geocodes) {
      const f = featurePorCodigo.get(g);
      if (f) municipios.push({ uf: g.slice(0, 2), polys: poligonosDaFeature(f) });
    }
    return { alerta: a, municipios, poligonos: [] };
  });
}

async function geometriaUF(uf) {
  if (!estado.ufGeo) {
    estado.ufGeo = contornoEstados().then((geo) => {
      const m = {};
      for (const f of geo.features || []) {
        const cod = String(f.properties?.codarea ?? '').slice(0, 2);
        if (UF_POR_CODIGO[cod]) m[UF_POR_CODIGO[cod]] = poligonosDaFeature(f);
      }
      return m;
    }).catch((e) => { estado.ufGeo = null; throw e; });
  }
  return (await estado.ufGeo)[uf] || null;
}

// Só a parte do alerta que fica dentro do estado escolhido
async function recorte(area, uf) {
  if (!uf) return [...area.municipios.flatMap((m) => m.polys), ...area.poligonos];
  const cod = CODIGO_POR_UF[uf];
  const doEstado = area.municipios.filter((m) => m.uf === cod).flatMap((m) => m.polys);
  if (!area.poligonos.length) return doEstado;
  const chave = `${area.alerta.id}|${uf}`;
  if (!estado.recortes.has(chave)) {
    let res = [];
    try {
      const geoUF = await geometriaUF(uf);
      res = geoUF ? polygonClipping.intersection(area.poligonos, geoUF) : area.poligonos;
    } catch (e) {
      console.warn('recorte do alerta', e);
      res = area.poligonos;
    }
    estado.recortes.set(chave, res);
  }
  return [...doEstado, ...estado.recortes.get(chave)];
}

/* ======================= Filtros ======================= */
const passaUF = (a) => !estado.filtroUF || (a.estados || []).includes(estado.filtroUF);
const passaSev = (a) => estado.severidades.has(grupoSev(a));

function renderSeveridade() {
  const daRegiao = estado.alertas.filter(passaUF);
  const conta = (n) => daRegiao.filter((a) => grupoSev(a) === n).length;
  const todos = SEVERIDADES.every((s) => estado.severidades.has(s.n));
  $('alertas-severidade').innerHTML = `<button type="button" class="chip-sev chip-todos" data-sev="todos" aria-pressed="${todos}">Todos</button>`
    + SEVERIDADES.map((s) => `<button type="button" class="chip-sev" data-sev="${s.n}" aria-pressed="${estado.severidades.has(s.n)}" title="${s.dica}" style="--cor:${s.cor}">
      <span class="chip-cor" aria-hidden="true"></span>${s.nome}<span class="chip-n">${estado.carregado ? conta(s.n) : ''}</span></button>`).join('');
}

function trocarSeveridade(v) {
  if (v === 'todos') {
    const todos = SEVERIDADES.every((s) => estado.severidades.has(s.n));
    estado.severidades = new Set(todos ? [] : [1, 2, 3]);
  } else {
    const n = Number(v);
    if (estado.severidades.has(n)) estado.severidades.delete(n); else estado.severidades.add(n);
  }
  store.set('wc:sevAlertas', [...estado.severidades]);
  renderSeveridade();
  desenhar();
}

/* ======================= Desenho ======================= */
let geracao = 0;
async function desenhar() {
  const minha = ++geracao;
  const uf = estado.filtroUF;
  const candidatos = estado.areas.filter(({ alerta }) => passaUF(alerta) && passaSev(alerta));
  const comGeo = await Promise.all(candidatos.map(async (area) => ({ area, multi: await recorte(area, uf) })));
  if (minha !== geracao) return;
  estado.visiveis = comGeo;
  const alertasVisiveis = candidatos.map((c) => c.alerta);
  renderLista(alertasVisiveis);
  renderLinha(alertasVisiveis);
  renderCabecalho();
  if (!estado.mapa) return;

  if (estado.grupo) estado.grupo.remove();
  estado.grupo = L.layerGroup().addTo(estado.mapa);
  // Menos graves primeiro, para os mais graves ficarem por cima
  [...comGeo].sort((x, y) => x.area.alerta.nivel - y.area.alerta.nivel).forEach(({ area, multi }) => {
    const alerta = area.alerta;
    if (!multi.length) return;
    const auto = alerta.oficial === false;
    L.polygon(multi.map((poly) => poly.map((anel) => anel.map(([lon, lat]) => [lat, lon]))), {
      color: alerta.cor, weight: auto ? 2 : 1, opacity: 0.95, dashArray: auto ? '6 4' : null,
      fillColor: alerta.cor, fillOpacity: auto ? 0.28 : 0.45, interactive: false, pane: 'areasAlerta',
    }).addTo(estado.grupo);
    // Tempestade acompanhada: seta do deslocamento (de onde está para onde vai em 60 min)
    const d = alerta.detalhes;
    if (auto && d?.centro && d.velocidadeKmh >= 8) {
      const [la, lo] = d.centro;
      const rad = (d.rumoGraus * Math.PI) / 180;
      const km = d.velocidadeKmh;
      const fim = [la + (km * Math.cos(rad)) / 111.2, lo + (km * Math.sin(rad)) / (111.2 * Math.cos((la * Math.PI) / 180))];
      L.polyline([[la, lo], fim], { color: '#111', weight: 2, opacity: 0.8, interactive: false, pane: 'linhas' }).addTo(estado.grupo);
      L.circleMarker(fim, { radius: 3, color: '#111', fillColor: '#111', fillOpacity: 1, interactive: false, pane: 'linhas' }).addTo(estado.grupo);
      L.circleMarker([la, lo], { radius: 5, color: '#111', weight: 2, fillColor: alerta.cor, fillOpacity: 1, interactive: false, pane: 'linhas' }).addTo(estado.grupo);
    }
  });
}

// Destaque do estado escolhido: contorno forte e o resto do país esmaecido
async function desenharFoco() {
  if (!estado.mapa) return;
  if (estado.foco) { estado.foco.remove(); estado.foco = null; }
  const uf = estado.filtroUF;
  if (!uf) { estado.mapa.flyToBounds(LIMITES_BRASIL, { duration: 0.6 }); return; }
  try {
    const geo = await geometriaUF(uf);
    if (!geo || uf !== estado.filtroUF) return;
    const paraLL = (multi) => multi.map((poly) => poly.map((anel) => anel.map(([lon, lat]) => [lat, lon])));
    const fora = polygonClipping.difference([[[[-90, -50], [-20, -50], [-20, 20], [-90, 20], [-90, -50]]]], geo);
    estado.foco = L.layerGroup([
      L.polygon(paraLL(fora), { pane: 'foco', interactive: false, stroke: false, fillColor: getComputedStyle(document.documentElement).getPropertyValue('--mapa-fora').trim() || '#888', fillOpacity: 0.55 }),
      L.polygon(paraLL(geo), { pane: 'linhas', interactive: false, fill: false, color: getComputedStyle(document.documentElement).getPropertyValue('--texto').trim() || '#222', weight: 2, opacity: 0.85 }),
    ]).addTo(estado.mapa);
    estado.mapa.flyToBounds(L.latLngBounds(geo.flatMap((p) => p[0].map(([lon, lat]) => [lat, lon]))), { padding: [20, 20], maxZoom: 8, duration: 0.6 });
  } catch (e) { console.warn('contorno do estado', e); }
}

/* ======================= Lista, linha do tempo e cabeçalho ======================= */
const nomeRegiao = () => (estado.filtroUF ? UF_NOMES[estado.filtroUF] : 'Brasil');

function renderLista(alertas) {
  const el = $('alertas-lista');
  if (!estado.carregado) { el.innerHTML = '<p class="nota">Carregando alertas…</p>'; return; }
  if (!Object.values(estado.status).includes('ok')) {
    el.innerHTML = '<div class="aviso-neutro">⚠️ Não foi possível consultar os alertas agora.</div>';
    return;
  }
  const ordenados = [...alertas].sort((a, b) => grupoSev(b) - grupoSev(a) || (+a.inicio || 0) - (+b.inicio || 0));
  const filtroSev = SEVERIDADES.every((s) => estado.severidades.has(s.n)) ? '' : ` (${SEVERIDADES.filter((s) => estado.severidades.has(s.n)).map((s) => s.nome.toLowerCase()).join(', ') || 'nenhuma severidade escolhida'})`;
  el.innerHTML = `<h2 class="lista-titulo">${ordenados.length} alerta${ordenados.length === 1 ? '' : 's'} ativo${ordenados.length === 1 ? '' : 's'} · ${esc(nomeRegiao())}${esc(filtroSev)}</h2>`
    + (ordenados.length ? `<div class="lista-grade">${ordenados.map((a) => `<div class="lista-item" data-alerta="${esc(a.id)}">${cartaoAlerta(a)}${a.estados.length > 1 || (!estado.filtroUF && a.estados.length) ? `<p class="area-alerta">Estados: ${a.estados.map((u) => esc(u)).join(', ')}</p>` : ''}</div>`).join('')}</div>`
      : `<div class="aviso-neutro ok">Nenhum alerta ativo ${estado.filtroUF ? `em ${esc(nomeRegiao())}` : 'no Brasil'} com os filtros escolhidos.</div>`);
}

function renderLinha(alertas) {
  $('lt-titulo').textContent = `Linha do tempo dos alertas · ${nomeRegiao()}`;
  if (!estado.carregado) { $('linha-tempo-alertas').innerHTML = '<p class="nota">Carregando…</p>'; return; }
  $('lt-detalhe').hidden = true;
  renderLinhaTempo($('linha-tempo-alertas'), alertas, {
    vazio: `Nenhum alerta vigente ou previsto ${estado.filtroUF ? `em ${nomeRegiao()}` : 'no Brasil'} com os filtros escolhidos.`,
    aoClicar: (a) => {
      const det = $('lt-detalhe');
      det.innerHTML = cartaoAlerta(a);
      det.hidden = false;
      // Aproxima o mapa da área do alerta
      const v = estado.visiveis.find((x) => x.area.alerta === a);
      if (estado.mapa && v?.multi.length) {
        const pts = v.multi.flatMap((poly) => poly[0].map(([lon, lat]) => [lat, lon]));
        estado.mapa.flyToBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 9, duration: 0.6 });
      }
    },
  });
}

function renderCabecalho() {
  if (!estado.carregado) return;
  const hora = (estado.coletadoEm && estado.coletadoEm > Date.now() - 3 * 3600e3 ? estado.coletadoEm : new Date())
    .toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const n = estado.alertas.length;
  $('alertas-atualizado').innerHTML = `<strong>${n} alerta${n === 1 ? '' : 's'} ativo${n === 1 ? '' : 's'} no país</strong> · INMET, Defesa Civil, Marinha e WeatherCenter · verificado às ${hora}, atualiza sozinho a cada 5 minutos.`;
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

/* ======================= Dados ======================= */
// Recebe o resultado de todosAlertas() (o main.js reaproveita a mesma consulta da cidade)
export async function definirAlertas(resultado) {
  if (!resultado) return;
  estado.status = resultado.status;
  estado.coletadoEm = resultado.coletadoEm;
  estado.alertas = resultado.alertas;
  estado.recortes.clear();
  renderFontes();
  estado.areas = await areasDosAlertas(resultado.alertas);
  estado.carregado = true;
  if (estado.mapa) $('alertas-status').hidden = true;
  renderSeveridade();
  desenhar();
}

// Usado pela faixa de alertas da cidade ("ver no mapa")
export function filtrarUF(uf) {
  estado.filtroUF = UF_NOMES[uf] ? uf : '';
  if ($('alertas-uf').options.length) $('alertas-uf').value = estado.filtroUF;
  renderSeveridade();
  desenhar();
  desenharFoco();
}

let controlesProntos = false;
function prepararControles() {
  if (controlesProntos) return;
  controlesProntos = true;
  $('alertas-uf').innerHTML = `<option value="">Todo o Brasil</option>${Object.entries(UF_NOMES).sort((a, b) => a[1].localeCompare(b[1])).map(([s, n]) => `<option value="${s}">${n}</option>`).join('')}`;
  $('alertas-uf').value = estado.filtroUF;
  $('alertas-uf').addEventListener('change', (e) => filtrarUF(e.target.value));
  $('alertas-severidade').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sev]');
    if (b) trocarSeveridade(b.dataset.sev);
  });
  renderSeveridade();
  renderFontes();
}
prepararControles();

export async function iniciarAlertasMapa(obterAlertas = todosAlertas) {
  if (estado.mapa) { estado.mapa.invalidateSize(); return; }
  const mapa = L.map('mapa-alertas', { zoomControl: false, minZoom: 2.5, maxZoom: 14, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90 })
    .fitBounds(LIMITES_BRASIL);
  L.control.zoom({ position: 'bottomright' }).addTo(mapa);
  mapa.attributionControl.setPrefix(false);
  estado.mapa = mapa;
  mapa.createPane('foco').style.zIndex = 375;
  mapa.createPane('areasAlerta').style.zIndex = 380;
  mapa.createPane('linhas').style.zIndex = 400;
  prepararMapa(mapa, $('tela-mapa-alertas'));
  // Com o mapa vetorial, os nomes das cidades já vêm do mapa de fundo; sem ele, o app escreve os nomes
  basemap(mapa).then(({ vetorial }) => { if (!vetorial) rotulosCidades(mapa); });
  mascaraBrasil(mapa);

  // Incêndios: liga/desliga na legenda
  const fogo = camadaIncendios(mapa);
  const caixaFogo = $('mostrar-fogo');
  caixaFogo.checked = fogo.ligado;
  caixaFogo.addEventListener('change', () => fogo.ligar(caixaFogo.checked));
  fogo.carregar().then((n) => {
    $('fogo-qtd').textContent = n ? `${n.toLocaleString('pt-BR')} áreas` : 'nenhum foco';
  }).catch((e) => { console.warn('focos', e); $('fogo-qtd').textContent = 'indisponível'; });

  mapa.on('click', (e) => {
    const { lat, lng } = e.latlng;
    const achados = estado.visiveis.filter(({ multi }) => dentroMulti(lng, lat, multi));
    if (!achados.length) return;
    L.popup({ maxWidth: 320, maxHeight: 360 }).setLatLng(e.latlng)
      .setContent(`<div class="popup-alertas">${achados.map(({ area }) => cartaoAlerta(area.alerta)).join('')}</div>`).openOn(mapa);
  });

  if (estado.carregado) { desenhar(); desenharFoco(); return; }
  $('alertas-status').hidden = false;
  $('alertas-status').textContent = 'Carregando alertas…';
  try {
    await definirAlertas(await obterAlertas());
    if (!estado.carregado) throw new Error('sem dados');
    desenharFoco();
  } catch (e) {
    console.error(e);
    $('alertas-status').textContent = 'Não foi possível carregar os alertas agora.';
  }
}

export { CODIGO_POR_UF };
