// Gráficos interativos por hora (hoje e próximos dias), um para cada assunto da previsão:
// chuva, temperatura e sensação, vento e rajadas, nuvens/neblina/visibilidade, umidade,
// pressão, UV e qualidade do ar. Abrem numa janela por cima da página; passar o dedo ou
// o mouse pelo gráfico mostra os valores de cada hora (setas do teclado também funcionam).
import { $, esc, num, r0, tempo, direcao, nivelUV, nivelAr, DIAS_SEMANA } from './util.js';
import { iconeTempo } from './icones.js';

const COR = {
  chuva: 'var(--chuva)', prob: 'var(--g-prob)', temp: 'var(--acento)', sens: 'var(--g-sens)', vento: 'var(--g-vento)',
  rajada: 'var(--g-rajada)', nuvem: 'var(--g-nuvem)', visib: 'var(--g-visib)', umid: 'var(--chuva)', orvalho: 'var(--g-sens)',
  pressao: 'var(--g-pressao)', ar: 'var(--g-ar)',
};

// Cada série: { campo | valores(dados, i), nome, tipo: linha|area|barra|tracejada, eixo: esq|dir, un, casas, cor, corPonto? }
const GRUPOS = [
  {
    id: 'chuva', nome: 'Chuva',
    series: [
      { campo: 'precipitation', nome: 'Chuva', tipo: 'barra', eixo: 'esq', un: 'mm', casas: 1, cor: COR.chuva },
      { campo: 'precipitation_probability', nome: 'Chance de chuva', tipo: 'linha', eixo: 'dir', un: '%', casas: 0, cor: COR.prob },
    ],
    eixos: { esq: { min: 0, maxMin: 2, un: 'mm' }, dir: { min: 0, max: 100, un: '%' } },
    resumo(d, ix) {
      const total = soma(d, 'precipitation', ix);
      const p = extremo(d, 'precipitation_probability', ix, 'max');
      const forte = extremo(d, 'precipitation', ix, 'max');
      if (total < 0.2 && (p.v ?? 0) < 30) return 'Sem chuva significativa no período.';
      return `Total de <strong>${num(total)} mm</strong>. Maior chance: <strong>${r0(p.v)}%</strong> ${quando(d, p.i)}.${forte.v >= 1 ? ` Hora mais chuvosa ${quando(d, forte.i)} (${num(forte.v)} mm).` : ''}`;
    },
  },
  {
    id: 'temperatura', nome: 'Temperatura',
    series: [
      { campo: 'temperature_2m', nome: 'Temperatura', tipo: 'linha', eixo: 'esq', un: '°', casas: 0, cor: COR.temp },
      { campo: 'apparent_temperature', nome: 'Sensação térmica', tipo: 'tracejada', eixo: 'esq', un: '°', casas: 0, cor: COR.sens },
    ],
    eixos: { esq: { un: '°', folga: 2 } },
    resumo(d, ix) {
      const mx = extremo(d, 'temperature_2m', ix, 'max'), mn = extremo(d, 'temperature_2m', ix, 'min');
      const smx = extremo(d, 'apparent_temperature', ix, 'max'), smn = extremo(d, 'apparent_temperature', ix, 'min');
      return `Máxima de <strong>${r0(mx.v)}°</strong> ${quando(d, mx.i)} e mínima de <strong>${r0(mn.v)}°</strong> ${quando(d, mn.i)}. Sensação entre ${r0(smn.v)}° e ${r0(smx.v)}°.`;
    },
  },
  {
    id: 'vento', nome: 'Vento',
    series: [
      { campo: 'wind_gusts_10m', nome: 'Rajadas', tipo: 'area', eixo: 'esq', un: 'km/h', casas: 0, cor: COR.rajada },
      { campo: 'wind_speed_10m', nome: 'Vento médio', tipo: 'linha', eixo: 'esq', un: 'km/h', casas: 0, cor: COR.vento },
    ],
    eixos: { esq: { min: 0, maxMin: 20, un: 'km/h' } },
    setas: 'wind_direction_10m',
    extra: (d, i) => (d.wind_direction_10m?.[i] != null ? `Vindo de ${direcao(d.wind_direction_10m[i])}` : ''),
    resumo(d, ix) {
      const r = extremo(d, 'wind_gusts_10m', ix, 'max'), v = extremo(d, 'wind_speed_10m', ix, 'max');
      const nivel = r.v >= 75 ? ' Rajadas muito fortes: risco de queda de árvores e danos.' : r.v >= 50 ? ' Rajadas fortes: atenção a objetos soltos.' : '';
      return `Vento médio de até <strong>${r0(v.v)} km/h</strong> ${quando(d, v.i)}; rajadas de até <strong>${r0(r.v)} km/h</strong> ${quando(d, r.i)}.${nivel}`;
    },
  },
  {
    id: 'nuvens', nome: 'Nuvens, neblina e visibilidade',
    curto: 'Nuvens e visibilidade',
    series: [
      { campo: 'cloud_cover_low', nome: 'Nuvens baixas', tipo: 'area', eixo: 'dir', un: '%', casas: 0, cor: 'var(--g-nuvem-baixa)', opcional: true },
      { campo: 'cloud_cover', nome: 'Céu encoberto', tipo: 'area', eixo: 'dir', un: '%', casas: 0, cor: COR.nuvem },
      { valores: (d, i) => (d.visibility?.[i] == null ? null : Math.min(d.visibility[i] / 1000, 50)), nome: 'Visibilidade', tipo: 'linha', eixo: 'esq', un: 'km', casas: 1, cor: COR.visib },
    ],
    eixos: { esq: { min: 0, maxMin: 10, un: 'km' }, dir: { min: 0, max: 100, un: '%' } },
    faixas: (d, i) => (d.weather_code[i] === 45 || d.weather_code[i] === 48 || (d.visibility?.[i] ?? 1e9) < 1000 ? 'Neblina' : null),
    resumo(d, ix) {
      const nev = ix.filter((i) => d.weather_code[i] === 45 || d.weather_code[i] === 48 || (d.visibility?.[i] ?? 1e9) < 1000);
      const vmin = extremo(d, 'visibility', ix, 'min');
      const ceu = ix.reduce((s, i) => s + (d.cloud_cover[i] ?? 0), 0) / Math.max(1, ix.length);
      return `${nev.length ? `<strong>Neblina provável</strong> ${quando(d, nev[0])}${nev.length > 1 ? ` (${nev.length} horas no período)` : ''}. ` : 'Sem neblina prevista. '}Visibilidade mínima de <strong>${num((vmin.v ?? 0) / 1000, 1)} km</strong> ${quando(d, vmin.i)}. Céu ${r0(ceu)}% encoberto em média.`;
    },
  },
  {
    id: 'umidade', nome: 'Umidade',
    series: [
      { campo: 'relative_humidity_2m', nome: 'Umidade relativa', tipo: 'area', eixo: 'dir', un: '%', casas: 0, cor: COR.umid },
      { campo: 'dew_point_2m', nome: 'Ponto de orvalho', tipo: 'tracejada', eixo: 'esq', un: '°', casas: 0, cor: COR.orvalho },
    ],
    eixos: { esq: { un: '°', folga: 2 }, dir: { min: 0, max: 100, un: '%' } },
    linhasRef: [{ eixo: 'dir', v: 30, rotulo: '30%: ar seco' }],
    resumo(d, ix) {
      const mn = extremo(d, 'relative_humidity_2m', ix, 'min'), mx = extremo(d, 'relative_humidity_2m', ix, 'max');
      const alerta = mn.v < 12 ? ' Umidade em nível de emergência.' : mn.v < 20 ? ' Ar muito seco: evite exercícios ao ar livre.' : mn.v < 30 ? ' Ar seco: beba água.' : '';
      return `Umidade entre <strong>${r0(mn.v)}%</strong> (${quando(d, mn.i)}) e <strong>${r0(mx.v)}%</strong>.${alerta}`;
    },
  },
  {
    id: 'pressao', nome: 'Pressão',
    series: [{ campo: 'pressure_msl', nome: 'Pressão ao nível do mar', tipo: 'linha', eixo: 'esq', un: 'hPa', casas: 0, cor: COR.pressao }],
    eixos: { esq: { un: 'hPa', folga: 2 } },
    resumo(d, ix) {
      const mn = extremo(d, 'pressure_msl', ix, 'min'), mx = extremo(d, 'pressure_msl', ix, 'max');
      const ini = d.pressure_msl[ix[0]], fim = d.pressure_msl[ix[ix.length - 1]];
      const tend = fim - ini > 3 ? 'Pressão subindo: tendência de tempo mais firme.' : ini - fim > 3 ? 'Pressão caindo: tempo pode ficar instável.' : 'Pressão estável.';
      return `Entre <strong>${r0(mn.v)}</strong> e <strong>${r0(mx.v)} hPa</strong>. ${tend}`;
    },
  },
  {
    id: 'uv', nome: 'Índice UV',
    series: [{ campo: 'uv_index', nome: 'Índice UV', tipo: 'barra', eixo: 'esq', un: '', casas: 0, cor: 'var(--sol)', corPonto: (v) => nivelUV(v).cor }],
    eixos: { esq: { min: 0, maxMin: 11, un: '' } },
    extra: (d, i) => (d.uv_index?.[i] != null ? nivelUV(d.uv_index[i]).nome : ''),
    resumo(d, ix) {
      const mx = extremo(d, 'uv_index', ix, 'max');
      const altas = ix.filter((i) => d.uv_index[i] >= 6);
      return `Máximo de <strong>${r0(mx.v)} (${nivelUV(mx.v).nome.toLowerCase()})</strong> ${quando(d, mx.i)}.${altas.length ? ` UV alto ou mais ${intervalo(d, altas)}: protetor solar, chapéu e sombra.` : ''}`;
    },
  },
  {
    id: 'ar', nome: 'Qualidade do ar',
    fonte: 'ar',
    series: [
      { campo: 'us_aqi', nome: 'Índice de qualidade do ar', tipo: 'barra', eixo: 'esq', un: '', casas: 0, cor: COR.ar, corPonto: (v) => nivelAr(v).cor },
      { campo: 'pm2_5', nome: 'PM2,5', tipo: 'linha', eixo: 'dir', un: 'µg/m³', casas: 0, cor: 'var(--sutil)' },
    ],
    eixos: { esq: { min: 0, maxMin: 100, un: '' }, dir: { min: 0, maxMin: 25, un: 'µg/m³' } },
    extra: (d, i) => (d.us_aqi?.[i] != null ? nivelAr(d.us_aqi[i]).nome : ''),
    resumo(d, ix) {
      const mx = extremo(d, 'us_aqi', ix, 'max');
      return `Pior momento: <strong>${r0(mx.v)} (${nivelAr(mx.v).nome.toLowerCase()})</strong> ${quando(d, mx.i)}. Previsão do modelo CAMS (Copernicus) pela Open-Meteo.`;
    },
  },
];

/* ---------------- Utilidades de dados ---------------- */
const valor = (s, d, i) => (s.valores ? s.valores(d, i) : d[s.campo]?.[i] ?? null);
const soma = (d, campo, ix) => ix.reduce((s, i) => s + (d[campo]?.[i] || 0), 0);
function extremo(d, campo, ix, tipo) {
  let melhor = { v: null, i: ix[0] };
  for (const i of ix) {
    const v = d[campo]?.[i];
    if (v == null) continue;
    if (melhor.v == null || (tipo === 'max' ? v > melhor.v : v < melhor.v)) melhor = { v, i };
  }
  return melhor;
}
const hhDe = (iso) => `${Number(iso.slice(11, 13))}h`;
const dataDe = (iso) => new Date(`${iso.slice(0, 10)}T12:00:00`);
let estado = null;
function quando(d, i) {
  if (i == null) return '';
  const iso = d.time[i];
  const mesmoDia = estado?.dia !== 'todos';
  return mesmoDia ? `às ${hhDe(iso)}` : `${nomeDia(iso.slice(0, 10)).toLowerCase()} às ${hhDe(iso)}`;
}
function intervalo(d, ix) {
  if (ix.length === 1) return quando(d, ix[0]);
  return estado?.dia !== 'todos' ? `das ${hhDe(d.time[ix[0]])} às ${hhDe(d.time[ix[ix.length - 1]])}` : 'em alguns horários';
}
function nomeDia(dia) {
  if (dia === estado?.hoje) return 'Hoje';
  if (dia === estado?.amanha) return 'Amanhã';
  const dt = dataDe(dia);
  return `${DIAS_SEMANA[dt.getDay()]} ${dt.getDate()}`;
}

// Escala "bonita" para o eixo
function escala(min, max, nMarcas = 4) {
  if (min === max) { min -= 1; max += 1; }
  const bruto = (max - min) / nMarcas;
  const mag = 10 ** Math.floor(Math.log10(bruto));
  const passo = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((p) => p >= bruto) || 10 * mag;
  const lo = Math.floor(min / passo) * passo, hi = Math.ceil(max / passo) * passo;
  const marcas = [];
  for (let v = lo; v <= hi + passo / 2; v += passo) marcas.push(+v.toFixed(6));
  return { min: lo, max: hi, marcas };
}

function limitesEixo(cfg, series, d, ix) {
  if (!cfg) return null;
  const vals = [];
  for (const s of series) for (const i of ix) { const v = valor(s, d, i); if (v != null) vals.push(v); }
  let lo = cfg.min ?? (vals.length ? Math.min(...vals) - (cfg.folga ?? 0) : 0);
  let hi = cfg.max ?? (vals.length ? Math.max(...vals) + (cfg.folga ?? 0) : 1);
  if (cfg.maxMin != null) hi = Math.max(hi, cfg.maxMin);
  return escala(lo, hi);
}

/* ---------------- Desenho do gráfico (SVG) ---------------- */
function desenhar() {
  const { prev, ar, grupo, dia } = estado;
  const fonte = grupo.fonte === 'ar' ? ar?.hourly : prev.hourly;
  const area = $('gr-grafico');
  if (!fonte) { area.innerHTML = '<p class="aviso-neutro">Dados indisponíveis no momento.</p>'; $('gr-resumo').innerHTML = ''; $('gr-legenda').innerHTML = ''; return; }
  const d = fonte;
  const ix = [];
  d.time.forEach((t, i) => { if ((dia === 'todos' ? t.slice(0, 10) >= estado.hoje : t.startsWith(dia))) ix.push(i); });
  if (!ix.length) { area.innerHTML = '<p class="aviso-neutro">Sem previsão para este dia.</p>'; return; }
  const series = grupo.series.filter((s) => !s.opcional || ix.some((i) => valor(s, d, i) != null));

  const W = Math.max(300, area.clientWidth || 600);
  const H = W < 560 ? 240 : Math.min(340, Math.max(270, Math.round(W * 0.3)));
  const temDir = !!grupo.eixos.dir && series.some((s) => s.eixo === 'dir');
  const M = { t: grupo.setas ? 32 : 22, r: temDir ? 44 : 14, b: dia === 'todos' ? 40 : 26, l: 42 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const n = ix.length;
  const dx = iw / n;
  const X = (k) => M.l + dx * (k + 0.5);
  const eixoE = limitesEixo(grupo.eixos.esq, series.filter((s) => s.eixo === 'esq'), d, ix);
  const eixoD = temDir ? limitesEixo(grupo.eixos.dir, series.filter((s) => s.eixo === 'dir'), d, ix) : null;
  const Y = (v, e) => M.t + ih - ((v - e.min) / (e.max - e.min || 1)) * ih;
  const eixoDe = (s) => (s.eixo === 'dir' ? eixoD : eixoE);

  let svg = '';
  // Noite
  const isDay = prev.hourly.is_day;
  const idxPrev = grupo.fonte === 'ar' ? Object.fromEntries(prev.hourly.time.map((t, i) => [t, i])) : null;
  const ehNoite = (i) => { const j = idxPrev ? idxPrev[d.time[i]] : i; return j != null && isDay?.[j] === 0; };
  for (let k = 0; k < n; k++) {
    if (!ehNoite(ix[k])) continue;
    let fim = k; while (fim + 1 < n && ehNoite(ix[fim + 1])) fim++;
    svg += `<rect class="gr-noite" x="${(M.l + dx * k).toFixed(1)}" y="${M.t}" width="${(dx * (fim - k + 1)).toFixed(1)}" height="${ih}"/>`;
    k = fim;
  }
  // Faixas especiais (neblina)
  if (grupo.faixas) {
    for (let k = 0; k < n; k++) {
      const r = grupo.faixas(d, ix[k]);
      if (!r) continue;
      let fim = k; while (fim + 1 < n && grupo.faixas(d, ix[fim + 1])) fim++;
      const x = M.l + dx * k, w = dx * (fim - k + 1);
      svg += `<rect class="gr-faixa" x="${x.toFixed(1)}" y="${M.t}" width="${w.toFixed(1)}" height="${ih}"/>`;
      if (w > 34) svg += `<text class="gr-faixa-rot" x="${(x + w / 2).toFixed(1)}" y="${M.t + 12}">${r}</text>`;
      k = fim;
    }
  }
  // Grade e eixos
  for (const v of eixoE.marcas) {
    const y = Y(v, eixoE);
    svg += `<line class="gr-grade" x1="${M.l}" x2="${M.l + iw}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="gr-y" x="${M.l - 6}" y="${(y + 4).toFixed(1)}">${num(v, 1)}</text>`;
  }
  svg += `<text class="gr-un" x="${M.l - 6}" y="${M.t - 10}">${esc(grupo.eixos.esq.un)}</text>`;
  if (eixoD) {
    for (const v of eixoD.marcas) svg += `<text class="gr-y gr-y-dir" x="${M.l + iw + 6}" y="${(Y(v, eixoD) + 4).toFixed(1)}">${num(v, 1)}</text>`;
    svg += `<text class="gr-un gr-y-dir" x="${M.l + iw + 6}" y="${M.t - 10}">${esc(grupo.eixos.dir.un)}</text>`;
  }
  for (const ref of grupo.linhasRef || []) {
    const e = ref.eixo === 'dir' ? eixoD : eixoE;
    if (!e) continue;
    const y = Y(ref.v, e);
    svg += `<line class="gr-ref" x1="${M.l}" x2="${M.l + iw}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="gr-ref-rot" x="${M.l + 4}" y="${(y - 4).toFixed(1)}">${esc(ref.rotulo)}</text>`;
  }
  // Eixo do tempo
  const passo = [1, 2, 3, 4, 6, 12, 24].find((p) => p * dx >= 34) || 24;
  for (let k = 0; k < n; k++) {
    const iso = d.time[ix[k]];
    const h = Number(iso.slice(11, 13));
    if (h === 0 && dia === 'todos') {
      const x = M.l + dx * k;
      svg += `<line class="gr-dia" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${M.t}" y2="${M.t + ih + 30}"/><text class="gr-dia-rot" x="${(x + 4).toFixed(1)}" y="${H - 4}">${esc(nomeDia(iso.slice(0, 10)))}</text>`;
    }
    if (h % passo === 0) svg += `<text class="gr-x" x="${X(k).toFixed(1)}" y="${M.t + ih + 16}">${h}h</text>`;
  }
  // Séries
  for (const s of series) {
    const e = eixoDe(s);
    const pts = ix.map((i, k) => { const v = valor(s, d, i); return v == null ? null : [X(k), Y(Math.max(e.min, Math.min(e.max, v)), e), v]; });
    if (s.tipo === 'barra') {
      const bw = Math.max(1, Math.min(18, dx * 0.72));
      pts.forEach((p) => {
        if (!p || p[2] <= 0) return;
        const y0 = Y(Math.max(0, e.min), e);
        svg += `<rect class="gr-barra" x="${(p[0] - bw / 2).toFixed(1)}" y="${p[1].toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.8, y0 - p[1]).toFixed(1)}" rx="${Math.min(2, bw / 4)}" style="fill:${s.corPonto ? s.corPonto(p[2]) : s.cor}"/>`;
      });
      continue;
    }
    // Linhas: quebra onde falta dado
    const trechos = [];
    let atual = [];
    for (const p of pts) { if (p) atual.push(p); else if (atual.length) { trechos.push(atual); atual = []; } }
    if (atual.length) trechos.push(atual);
    for (const tr of trechos) {
      const dPath = tr.map((p, k) => `${k ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
      if (s.tipo === 'area') {
        const base = Y(Math.max(0, e.min), e).toFixed(1);
        svg += `<path class="gr-sombra" d="${dPath} L${tr[tr.length - 1][0].toFixed(1)} ${base} L${tr[0][0].toFixed(1)} ${base} Z" style="fill:${s.cor}"/>`;
      }
      svg += `<path class="gr-linha${s.tipo === 'tracejada' ? ' gr-tracejada' : ''}" d="${dPath}" style="stroke:${s.cor}"/>`;
    }
  }
  // Setas da direção do vento
  if (grupo.setas) {
    const cada = Math.max(1, Math.ceil(22 / dx));
    ix.forEach((i, k) => {
      if (k % cada) return;
      const g = d[grupo.setas]?.[i];
      if (g == null) return;
      svg += `<g class="gr-seta" transform="translate(${X(k).toFixed(1)} ${M.t - 15}) rotate(${(g + 180) % 360})"><path d="M0 -6 L4 4 L0 1.5 L-4 4 Z"/></g>`;
    });
  }
  // Agora
  const agoraIso = prev.current.time.slice(0, 13);
  const kAgora = ix.findIndex((i) => d.time[i].slice(0, 13) === agoraIso);
  if (kAgora >= 0) {
    const fr = Number(prev.current.time.slice(14, 16)) / 60;
    const x = M.l + dx * (kAgora + fr);
    svg += `<rect class="gr-passado" x="${M.l}" y="${M.t}" width="${(x - M.l).toFixed(1)}" height="${ih}"/>`;
    svg += `<line class="gr-agora" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${M.t - 2}" y2="${M.t + ih}"/><text class="gr-agora-rot" x="${(x + 4).toFixed(1)}" y="${M.t + 11}">agora</text>`;
  }
  // Cursor (linha vertical e pontos), atualizado ao passar o dedo/mouse
  svg += `<line class="gr-cursor" x1="0" x2="0" y1="${M.t}" y2="${M.t + ih}" hidden/>`;
  series.forEach((s, j) => { svg += `<circle class="gr-cursor-ponto" data-s="${j}" r="4" style="stroke:${s.cor}" hidden/>`; });
  svg += `<rect class="gr-toque" x="${M.l}" y="0" width="${iw}" height="${H}"/>`;

  area.innerHTML = `<svg class="gr-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" tabindex="0"
    aria-label="${esc(grupo.nome)} por hora. Use as setas para percorrer as horas.">${svg}</svg>`;

  $('gr-legenda').innerHTML = series.map((s) => `<span class="gr-leg"><i class="gr-leg-${s.tipo}" style="--c:${s.cor}"></i>${esc(s.nome)}${s.un ? ` <small>(${esc(s.un)})</small>` : ''}</span>`).join('')
    + (grupo.faixas ? '<span class="gr-leg"><i class="gr-leg-faixa"></i>Neblina provável</span>' : '')
    + '<span class="gr-leg"><i class="gr-leg-noite"></i>Noite</span>';
  $('gr-resumo').innerHTML = grupo.resumo(d, ix);

  // Interação
  const el = area.querySelector('svg');
  const dica = $('gr-dica');
  const cursor = el.querySelector('.gr-cursor');
  const pontos = [...el.querySelectorAll('.gr-cursor-ponto')];
  const mostrar = (k) => {
    k = Math.max(0, Math.min(n - 1, k));
    estado.k = k;
    const i = ix[k];
    const x = X(k);
    cursor.setAttribute('x1', x); cursor.setAttribute('x2', x); cursor.hidden = false;
    cursor.removeAttribute('hidden');
    series.forEach((s, j) => {
      const v = valor(s, d, i);
      const c = pontos[j];
      if (v == null || s.tipo === 'barra') { c.setAttribute('hidden', ''); return; }
      const e = eixoDe(s);
      c.setAttribute('cx', x); c.setAttribute('cy', Y(Math.max(e.min, Math.min(e.max, v)), e));
      c.removeAttribute('hidden');
    });
    const iso = d.time[i];
    const j = idxPrev ? idxPrev[iso] : i;
    const cod = j != null ? prev.hourly.weather_code?.[j] : null;
    const extra = grupo.extra ? grupo.extra(d, i) : '';
    dica.innerHTML = `<div class="gr-dica-topo">${cod != null ? iconeTempo(cod, prev.hourly.is_day?.[j] === 1) : ''}<span><strong>${esc(nomeDia(iso.slice(0, 10)))}, ${hhDe(iso)}</strong>${cod != null ? `<small>${esc(tempo(cod).desc)}</small>` : ''}</span></div>
      ${series.map((s) => { const v = valor(s, d, i); return `<div class="gr-dica-linha"><i style="background:${s.cor}"></i>${esc(s.nome)}<b>${v == null ? '—' : `${num(v, s.casas)}${s.un === '°' ? '°' : s.un ? ` ${esc(s.un)}` : ''}`}</b></div>`; }).join('')}
      ${extra ? `<div class="gr-dica-extra">${esc(extra)}</div>` : ''}`;
    dica.hidden = false;
    const escalaTela = el.getBoundingClientRect().width / W;
    const xTela = x * escalaTela;
    const larg = dica.offsetWidth;
    const caixa = area.clientWidth;
    dica.style.left = `${Math.max(4, Math.min(caixa - larg - 4, xTela + (xTela > caixa / 2 ? -larg - 14 : 14)))}px`;
    dica.style.top = `${M.t * escalaTela}px`;
  };
  const kDoEvento = (ev) => {
    const r = el.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * W;
    return Math.floor((x - M.l) / dx);
  };
  el.addEventListener('pointermove', (ev) => mostrar(kDoEvento(ev)));
  el.addEventListener('pointerdown', (ev) => mostrar(kDoEvento(ev)));
  el.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse') { dica.hidden = true; cursor.setAttribute('hidden', ''); pontos.forEach((p) => p.setAttribute('hidden', '')); } });
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      ev.preventDefault();
      mostrar((estado.k ?? (kAgora >= 0 ? kAgora : 0)) + (ev.key === 'ArrowRight' ? 1 : -1));
    }
  });
  el.addEventListener('focus', () => mostrar(estado.k ?? (kAgora >= 0 ? kAgora : 0)));
  // Começa mostrando a hora atual (ou a primeira hora do dia)
  dica.hidden = true;
  if (estado.k != null && estado.k < n) mostrar(estado.k);
  else if (kAgora >= 0) mostrar(kAgora);
}

/* ---------------- Janela ---------------- */
function renderControles() {
  const { prev, ar, grupo, dia } = estado;
  const grupos = GRUPOS.filter((g) => g.fonte !== 'ar' || ar?.hourly);
  $('gr-grupos').innerHTML = grupos.map((g) => `<button type="button" role="tab" data-grupo="${g.id}" aria-selected="${g === grupo}">${esc(g.curto || g.nome)}</button>`).join('');
  const fonte = grupo.fonte === 'ar' ? ar?.hourly : prev.hourly;
  const dias = [...new Set((fonte?.time || []).map((t) => t.slice(0, 10)))].filter((x) => x >= estado.hoje);
  $('gr-dias').innerHTML = dias.map((x) => `<button type="button" data-dia="${x}" aria-pressed="${x === dia}">${esc(nomeDia(x))}</button>`).join('')
    + `<button type="button" data-dia="todos" aria-pressed="${dia === 'todos'}">Todos os ${dias.length} dias</button>`;
  $('gr-titulo').textContent = `${grupo.nome} hora a hora`;
  $('gr-sub').textContent = `${estado.cidade}${dia === 'todos' ? ' · próximos dias' : ` · ${nomeDia(dia).toLowerCase() === 'hoje' ? 'hoje' : nomeDia(dia)}`}`;
  requestAnimationFrame(() => {
    $('gr-grupos').querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    $('gr-dias').querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

let iniciado = false;
function iniciar() {
  if (iniciado) return;
  iniciado = true;
  const dlg = $('graficos');
  $('gr-grupos').addEventListener('click', (e) => {
    const b = e.target.closest('[data-grupo]'); if (!b) return;
    estado.grupo = GRUPOS.find((g) => g.id === b.dataset.grupo);
    const fonte = estado.grupo.fonte === 'ar' ? estado.ar?.hourly : estado.prev.hourly;
    if (estado.dia !== 'todos' && !fonte?.time.some((t) => t.startsWith(estado.dia))) estado.dia = estado.hoje;
    estado.k = null;
    renderControles(); desenhar();
  });
  $('gr-dias').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dia]'); if (!b) return;
    estado.dia = b.dataset.dia; estado.k = null;
    renderControles(); desenhar();
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-fechar]')) dlg.close(); });
  dlg.addEventListener('close', () => { document.body.classList.remove('com-janela'); });
  let largura = 0;
  new ResizeObserver(() => {
    const w = $('gr-grafico').clientWidth;
    if (dlg.open && Math.abs(w - largura) > 6) { largura = w; desenhar(); }
  }).observe($('gr-grafico'));
}

/**
 * Abre a janela de gráficos.
 * @param prev previsão (consenso) da cidade; ar: qualidade do ar (com hourly); grupoId: assunto; dia: 'YYYY-MM-DD' | 'todos'
 */
export function abrirGraficos({ prev, ar, cidade, grupoId = 'chuva', dia = null }) {
  iniciar();
  const hoje = prev.current.time.slice(0, 10);
  const amanha = prev.daily.time[1] || null;
  const grupo = GRUPOS.find((g) => g.id === grupoId) || GRUPOS[0];
  estado = { prev, ar, cidade, grupo, hoje, amanha, dia: dia || hoje, k: null };
  renderControles();
  const dlg = $('graficos');
  if (!dlg.open) {
    document.body.classList.add('com-janela');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  requestAnimationFrame(() => { desenhar(); dlg.querySelector('.gr-svg')?.focus({ preventScroll: true }); });
}

export const GRUPOS_GRAFICO = GRUPOS.map((g) => ({ id: g.id, nome: g.curto || g.nome }));
