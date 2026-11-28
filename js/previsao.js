// Tela de previsão: agora, resumo com alertas, próximas 24 horas, 10 dias, quadros de detalhes e fontes do consenso
import { $, esc, r0, num, tempo, direcao, nivelUV, nivelAr, faseLua, DIAS_SEMANA, DIAS_SEMANA_LONGO, UF_NOMES } from './util.js';
import { iconeTempo, icone } from './icones.js';
import { renderLinhaTempo, corTextoSobre } from './linhaTempoAlertas.js';

const hora = (iso) => iso.slice(11, 16);
const hh = (iso) => `${Number(iso.slice(11, 13))}h`;
const dataLocal = (iso) => new Date(iso.length <= 10 ? `${iso}T12:00:00` : iso); // horários "locais" da cidade, tratados como ingênuos
const km = (m) => (m == null ? null : m / 1000);
const seta = (graus) => `<span class="seta" style="transform:rotate(${(graus ?? 0) + 180}deg)" aria-hidden="true">↑</span>`;
const rotulo = (texto) => `<h2 class="rotulo">${texto}</h2>`;
const minuscula = (s) => s.charAt(0).toLowerCase() + s.slice(1);

function indiceAgora(prev) {
  const agora = prev.current.time.slice(0, 13);
  const i = prev.hourly.time.findIndex((t) => t.slice(0, 13) >= agora);
  return i < 0 ? 0 : i;
}

// Cores das barras de temperatura
const CORES_TEMP = [[-5, '#6b6fd0'], [8, '#4f8fd6'], [16, '#4fb0a8'], [22, '#9cbf5a'], [26, '#e0b443'], [31, '#e08a3c'], [36, '#d4553d'], [42, '#a8324f']];
function corTemp(t) {
  for (const [lim, cor] of CORES_TEMP) if (t <= lim) return cor;
  return CORES_TEMP[CORES_TEMP.length - 1][1];
}

/* ---------------- Agora ---------------- */
export function renderAgora(prev, cidade) {
  const c = prev.current, d = prev.daily;
  const dia = c.is_day === 1;
  const t = tempo(c.weather_code, dia);
  const cons = prev.consenso;
  const max = Math.max(d.temperature_2m_max[0], c.temperature_2m), min = Math.min(d.temperature_2m_min[0], c.temperature_2m);
  const quando = dataLocal(c.time).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  $('hero').innerHTML = `
    <div class="agora-topo">
      <div>
        <h1>${esc(cidade.nome)}</h1>
        <p class="agora-onde">${cidade.local ? 'Sua localização · ' : ''}${esc(UF_NOMES[cidade.uf] || cidade.uf || 'Brasil')} · ${quando}, ${hora(c.time)}</p>
      </div>
      ${cons ? `<button type="button" class="selo-fontes" data-ir="c-fontes"><span class="ponto"></span>${cons.nFontes} fontes</button>` : ''}
    </div>
    <div class="agora-principal">
      ${iconeTempo(c.weather_code, dia)}
      <div class="agora-temp">${r0(c.temperature_2m)}°</div>
      <div>
        <p class="agora-desc">${esc(t.desc)}</p>
        <p class="agora-sub">Máx. ${r0(max)}° · Mín. ${r0(min)}°</p>
        <p class="agora-sub">Sensação ${r0(c.apparent_temperature)}°</p>
      </div>
    </div>
    <dl class="agora-metricas">
      <div><dt>${icone('gota')}Chuva hoje</dt><dd>${r0(d.precipitation_probability_max[0])}%</dd></div>
      <div><dt>${icone('vento')}Vento</dt><dd>${r0(c.wind_speed_10m)} km/h ${direcao(c.wind_direction_10m)}</dd></div>
      <div><dt>${icone('gota')}Umidade</dt><dd>${r0(c.relative_humidity_2m)}%</dd></div>
      <div><dt>${icone('uv')}UV</dt><dd>${r0(c.uv_index)} ${nivelUV(c.uv_index).nome.toLowerCase()}</dd></div>
    </dl>`;
}

/* ---------------- Resumo prático (agora, próximas horas, amanhã e atenção) ---------------- */
export function renderResumo(prev, alertasCidade = []) {
  const c = prev.current, h = prev.hourly, d = prev.daily;
  const i0 = indiceAgora(prev);
  const itens = [];
  const add = (ic, quando, texto, atencao = false) => itens.push(`<li${atencao ? ' class="atencao"' : ''}>${ic}<div><span class="quando">${quando}</span>${texto}</div></li>`);

  // Agora
  const tA = tempo(c.weather_code, c.is_day === 1);
  const dif = c.apparent_temperature - c.temperature_2m;
  add(iconeTempo(c.weather_code, c.is_day === 1), 'Agora',
    `<strong>${esc(tA.desc)}</strong>, ${r0(c.temperature_2m)}°${Math.abs(dif) >= 2 ? ` com sensação de ${r0(c.apparent_temperature)}°` : ''}. Vento ${r0(c.wind_speed_10m)} km/h${c.wind_gusts_10m >= 40 ? `, rajadas de ${r0(c.wind_gusts_10m)} km/h` : ''}.`);

  // Próximas 6 a 12 horas
  const fim = Math.min(i0 + 12, h.time.length);
  let iChuva = -1, chuvaMm = 0, tMax = -Infinity, iMax = i0, tMin = Infinity, iMin = i0;
  for (let i = i0; i < fim; i++) {
    if (iChuva < 0 && h.precipitation_probability[i] >= 50 && (h.precipitation[i] ?? 0) >= 0.2) iChuva = i;
    chuvaMm += h.precipitation[i] || 0;
    if (h.temperature_2m[i] > tMax) { tMax = h.temperature_2m[i]; iMax = i; }
    if (h.temperature_2m[i] < tMin) { tMin = h.temperature_2m[i]; iMin = i; }
  }
  const partes = [];
  if (iChuva === i0) partes.push(`<strong>Chuva agora</strong>, cerca de ${num(chuvaMm)} mm nas próximas 12 horas.`);
  else if (iChuva > 0) partes.push(`<strong>Chuva provável a partir das ${hh(h.time[iChuva])}</strong> (${r0(h.precipitation_probability[iChuva])}%), cerca de ${num(chuvaMm)} mm até ${hh(h.time[fim - 1])}.`);
  else partes.push('<strong>Sem chuva significativa</strong> nas próximas 12 horas.');
  if (tMax - c.temperature_2m >= 2) partes.push(`Esquenta até ${r0(tMax)}° por volta das ${hh(h.time[iMax])}.`);
  else if (c.temperature_2m - tMin >= 3) partes.push(`Esfria para ${r0(tMin)}° por volta das ${hh(h.time[iMin])}.`);
  add(icone('relogio'), 'Próximas horas', partes.join(' '));

  // Amanhã
  if (d.time.length > 1) {
    const tB = tempo(d.weather_code[1]);
    const prob = d.precipitation_probability_max[1];
    add(iconeTempo(d.weather_code[1]), `Amanhã, ${DIAS_SEMANA_LONGO[dataLocal(d.time[1]).getDay()].toLowerCase()}`,
      `<strong>${esc(tB.desc)}</strong>, de ${r0(d.temperature_2m_min[1])}° a ${r0(d.temperature_2m_max[1])}°. ${prob >= 20 ? `Chance de chuva de ${r0(prob)}%${d.precipitation_sum[1] >= 1 ? `, cerca de ${num(d.precipitation_sum[1], 0)} mm` : ''}.` : 'Pouca chance de chuva.'}`);
  }

  // Atenção: o que pede cuidado hoje
  const atencao = [];
  const uvMax = d.uv_index_max?.[0];
  if (uvMax >= 8) atencao.push(`UV ${nivelUV(uvMax).nome.toLowerCase()} (${r0(uvMax)}) no meio do dia: protetor solar e sombra entre 10h e 16h.`);
  const rajadaMax = Math.max(...h.wind_gusts_10m.slice(i0, i0 + 24).filter((v) => v != null));
  if (rajadaMax >= 50) atencao.push(`Rajadas de vento de até ${r0(rajadaMax)} km/h nas próximas 24 horas.`);
  const urMin = Math.min(...h.relative_humidity_2m.slice(i0, i0 + 24).filter((v) => v != null));
  if (urMin < 30) atencao.push(`Ar seco: umidade chega a ${r0(urMin)}%. Beba água.`);
  if (d.apparent_temperature_max[0] >= 36) atencao.push(`Calor forte: sensação de até ${r0(d.apparent_temperature_max[0])}°.`);
  if (d.apparent_temperature_min[0] <= 8 || d.apparent_temperature_min[1] <= 8) atencao.push(`Frio: sensação de até ${r0(Math.min(d.apparent_temperature_min[0], d.apparent_temperature_min[1]))}°.`);
  if (d.precipitation_sum[0] >= 30 || d.precipitation_sum[1] >= 30) atencao.push('Chuva volumosa prevista (30 mm ou mais em um dia).');
  if (alertasCidade.length) atencao.unshift(`<strong>${alertasCidade.length} alerta${alertasCidade.length === 1 ? '' : 's'} oficial${alertasCidade.length === 1 ? '' : 'is'}</strong> para esta cidade (detalhes no topo da página).`);
  if (atencao.length) add(icone('alerta'), 'Atenção', atencao.join(' '), true);

  $('resumo').innerHTML = itens.join('');
}

/* ---------------- Chuva nas próximas 3 horas ---------------- */
export function renderChuvaProxima(prev) {
  const m = prev.minutely_15;
  const el = $('w-chuva');
  if (!m?.precipitation?.length) { el.hidden = true; return; }
  const vals = m.precipitation.slice(0, 12);
  const total = vals.reduce((s, v) => s + (v || 0), 0);
  const primeira = vals.findIndex((v) => v >= 0.1);
  if (primeira < 0) { el.hidden = true; return; }
  el.hidden = false;
  const max = Math.max(1, ...vals);
  const frase = primeira === 0 ? `Chovendo agora. Cerca de ${num(total)} mm nas próximas 3 horas.`
    : `Chuva a partir das ${hora(m.time[primeira])}. Cerca de ${num(total)} mm em 3 horas.`;
  el.innerHTML = `<p><strong>Próximas 3 horas:</strong> ${frase}</p>
    <div class="barras-chuva">${vals.map((v, i) => `<div title="${hora(m.time[i])}: ${num(v)} mm"><span style="height:${Math.max(6, (v / max) * 100)}%" class="${v >= 0.1 ? 'tem' : ''}"></span></div>`).join('')}</div>
    <div class="barras-eixo"><span>Agora</span><span>+1h</span><span>+2h</span><span>+3h</span></div>`;
}

/* ---------------- Próximas 24 horas: colunas + curva de temperatura + barras de chuva ---------------- */
function resumoHoras(h, i0) {
  const fim = Math.min(i0 + 24, h.time.length);
  const probs = h.precipitation_probability.slice(i0, fim);
  const pMax = Math.max(...probs);
  let total = 0;
  for (let i = i0; i < fim; i++) total += h.precipitation[i] || 0;
  if (pMax < 30) return 'Sem chuva prevista nas próximas 24 horas.';
  return `Chance de chuva de até ${r0(pMax)}%, cerca de ${num(total)} mm no total.`;
}

export function renderHoras(prev) {
  const h = prev.hourly, d = prev.daily;
  const i0 = indiceAgora(prev);
  const n = Math.min(25, h.time.length - i0);
  const L = 54; // largura de cada coluna
  const W = n * L, HC = 60, HB = 28, H = HC + HB + 16;
  const temps = [], chuva = [];
  for (let k = 0; k < n; k++) { temps.push(h.temperature_2m[i0 + k]); chuva.push(h.precipitation[i0 + k] || 0); }
  // A coluna "Agora" mostra o mesmo valor do quadro principal (consenso no minuto atual)
  if (prev.current?.temperature_2m != null) temps[0] = prev.current.temperature_2m;
  const lo = Math.min(...temps), hi = Math.max(...temps);
  const x = (k) => k * L + L / 2;
  const y = (v) => 22 + ((hi - v) / Math.max(1, hi - lo)) * (HC - 30);
  // Curva suave (Catmull-Rom convertida em Bézier)
  let caminho = `M${x(0)} ${y(temps[0])}`;
  for (let k = 0; k < n - 1; k++) {
    const p0 = [x(Math.max(0, k - 1)), y(temps[Math.max(0, k - 1)])], p1 = [x(k), y(temps[k])];
    const p2 = [x(k + 1), y(temps[k + 1])], p3 = [x(Math.min(n - 1, k + 2)), y(temps[Math.min(n - 1, k + 2)])];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    caminho += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0]} ${p2[1].toFixed(1)}`;
  }
  const maxC = Math.max(2, ...chuva);
  // Nascer e pôr do sol: marca vertical no instante exato
  const marcasSol = [];
  d.time.forEach((_, j) => {
    for (const [iso, nome] of [[d.sunrise?.[j], 'Nascer'], [d.sunset?.[j], 'Pôr do sol']]) {
      if (!iso) continue;
      const pos = (Date.parse(`${iso}:00Z`) - Date.parse(`${h.time[i0]}:00Z`)) / 3600000;
      if (pos > 0.2 && pos < n - 1) marcasSol.push({ x: x(0) + pos * L, nome: `${nome} ${hora(iso)}` });
    }
  });
  const svg = `<svg class="grafico-horas" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Temperatura e chuva nas próximas 24 horas">
    ${marcasSol.map((m) => `<line class="linha-sol" x1="${m.x}" x2="${m.x}" y1="4" y2="${HC + HB}"/><text class="rot-sol" x="${m.x}" y="${H - 2}">${m.nome}</text>`).join('')}
    <path class="curva" d="${caminho}"/>
    ${temps.map((v, k) => `<circle class="ponto" cx="${x(k)}" cy="${y(v).toFixed(1)}" r="2.6"/><text class="t" x="${x(k)}" y="${(y(v) - 8).toFixed(1)}">${r0(v)}°</text>`).join('')}
    <line class="base" x1="0" x2="${W}" y1="${HC + HB}" y2="${HC + HB}"/>
    ${chuva.map((c, k) => (c >= 0.1 ? `<rect class="barra" x="${x(k) - 9}" y="${HC + HB - (c / maxC) * HB}" width="18" height="${(c / maxC) * HB}" rx="2"/><text class="mm" x="${x(k)}" y="${HC + HB - (c / maxC) * HB - 3}">${num(c, c < 10 ? 1 : 0)}</text>` : '')).join('')}
  </svg>`;
  const colunas = temps.map((_, k) => {
    const i = i0 + k;
    const p = h.precipitation_probability[i];
    return `<div class="hc${k === 0 ? ' agora-h' : ''}" style="width:${L}px">
      <span class="h-hora">${k === 0 ? 'Agora' : hh(h.time[i])}</span>
      ${iconeTempo(h.weather_code[i], h.is_day[i] === 1)}
      <span class="h-prob">${p >= 20 ? `${r0(p)}%` : ''}</span>
    </div>`;
  }).join('');
  $('resumo-horas').textContent = resumoHoras(h, i0);
  const faixa = $('horas');
  faixa.innerHTML = `<div class="trilho" style="width:${W}px"><div class="trilho-colunas">${colunas}</div>${svg}</div>`;
  faixa.scrollLeft = 0;
  renderTabela24h(prev, i0);
}

/* ---------------- 10 dias ---------------- */
function mediasDiarias(h) {
  const por = {};
  h.time.forEach((t, i) => {
    const k = t.slice(0, 10);
    (por[k] ||= { ur: [], vis: [], p: [] });
    if (h.relative_humidity_2m[i] != null) por[k].ur.push(h.relative_humidity_2m[i]);
    if (h.visibility[i] != null) por[k].vis.push(h.visibility[i]);
    if (h.pressure_msl[i] != null) por[k].p.push(h.pressure_msl[i]);
  });
  const media = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const res = {};
  for (const [k, v] of Object.entries(por)) {
    res[k] = { urMed: media(v.ur), urMin: v.ur.length ? Math.min(...v.ur) : null, visMin: v.vis.length ? Math.min(...v.vis) : null, visMed: media(v.vis), pMed: media(v.p) };
  }
  return res;
}

export function renderDias(prev) {
  const d = prev.daily, c = prev.current;
  const n = Math.min(10, d.time.length);
  const extra = mediasDiarias(prev.hourly);
  const cons = prev.consenso?.dias || [];
  const mins = d.temperature_2m_min.slice(0, n), maxs = d.temperature_2m_max.slice(0, n);
  const minG = Math.min(...mins, c.temperature_2m), maxG = Math.max(...maxs, c.temperature_2m);
  const pos = (v) => ((v - minG) / Math.max(1, maxG - minG)) * 100;
  let html = '';
  for (let i = 0; i < n; i++) {
    const dt = dataLocal(d.time[i]);
    const nome = i === 0 ? 'Hoje' : DIAS_SEMANA[dt.getDay()];
    const t = tempo(d.weather_code[i]);
    const e = extra[d.time[i]] || {};
    const uv = nivelUV(d.uv_index_max[i]);
    const mn = i === 0 ? Math.min(mins[i], c.temperature_2m) : mins[i];
    const mx = i === 0 ? Math.max(maxs[i], c.temperature_2m) : maxs[i];
    const prob = d.precipitation_probability_max[i];
    const k = cons[i] || {};
    const faixaTxt = (f) => (f && Math.round(f[0]) !== Math.round(f[1]) ? `entre ${r0(f[0])}° e ${r0(f[1])}°` : f ? `${r0(f[0])}°` : '—');
    html += `<li class="dia">
      <details>
        <summary aria-label="${DIAS_SEMANA_LONGO[dt.getDay()]}: ${esc(t.desc)}, mínima ${r0(mn)}°, máxima ${r0(mx)}°">
          <span class="d-nome">${nome}</span>
          <span class="d-icone" title="${esc(t.desc)}">${iconeTempo(d.weather_code[i])}</span>
          <span class="d-chuva">${prob >= 20 ? `${r0(prob)}%` : ''}</span>
          <span class="d-min">${r0(mn)}°</span>
          <span class="d-barra"><span style="left:${pos(mn)}%;right:${100 - pos(mx)}%;background:linear-gradient(90deg,${corTemp(mn)},${corTemp(mx)})"></span>${i === 0 ? `<i class="d-agora" style="left:${pos(c.temperature_2m)}%"></i>` : ''}</span>
          <span class="d-max">${r0(mx)}°</span>
        </summary>
        <div class="d-det">
          <p class="d-desc"><strong>${DIAS_SEMANA_LONGO[dt.getDay()]}, ${dt.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' })}:</strong> ${esc(minuscula(t.desc))}.</p>
          ${k.n ? `<p class="d-cons">Consenso de ${k.n} fonte${k.n === 1 ? '' : 's'}${k.concordancia ? `, concordância ${k.concordancia}` : ''}. Máxima ${faixaTxt(k.max)} e mínima ${faixaTxt(k.min)} na maioria das fontes${k.chuvaFrac != null ? `; ${Math.round(k.chuvaFrac * 100)}% delas preveem chuva` : ''}.</p>` : ''}
          <dl>
            <div><dt>Temperatura</dt><dd>${r0(mx)}° / ${r0(mn)}°</dd></div>
            <div><dt>Sensação térmica</dt><dd>${r0(d.apparent_temperature_max[i])}° / ${r0(d.apparent_temperature_min[i])}°</dd></div>
            <div><dt>Chance de chuva</dt><dd>${r0(prob)}%</dd></div>
            <div><dt>Volume de chuva</dt><dd>${num(d.precipitation_sum[i])} mm</dd></div>
            <div><dt>Índice UV máx.</dt><dd>${r0(d.uv_index_max[i])} <small>${uv.nome}</small></dd></div>
            <div><dt>Vento máx.</dt><dd>${r0(d.wind_speed_10m_max[i])} km/h ${direcao(d.wind_direction_10m_dominant[i])}</dd></div>
            <div><dt>Rajadas</dt><dd>${r0(d.wind_gusts_10m_max[i])} km/h</dd></div>
            <div><dt>Umidade média</dt><dd>${r0(e.urMed)}% <small>mín. ${r0(e.urMin)}%</small></dd></div>
            <div><dt>Visibilidade</dt><dd>${num(km(e.visMed), 0)} km <small>mín. ${num(km(e.visMin), 0)}</small></dd></div>
            <div><dt>Pressão média</dt><dd>${r0(e.pMed)} hPa</dd></div>
            <div><dt>Nascer do sol</dt><dd>${d.sunrise[i] ? hora(d.sunrise[i]) : '—'}</dd></div>
            <div><dt>Pôr do sol</dt><dd>${d.sunset[i] ? hora(d.sunset[i]) : '—'}</dd></div>
          </dl>
          <button type="button" class="btn-sec d-graf" data-grafico="chuva" data-dia="${d.time[i]}">Gráficos hora a hora deste dia ›</button>
        </div>
      </details>
    </li>`;
  }
  $('dias-titulo').textContent = `Próximos ${n} dias`;
  $('dias').innerHTML = html;
}

/* ---------------- Quadros de detalhes ---------------- */
function conforto(tf) {
  if (tf >= 40) return 'Calor extremo.'; if (tf >= 32) return 'Muito quente.'; if (tf >= 27) return 'Quente.';
  if (tf <= 5) return 'Muito frio.'; if (tf <= 14) return 'Frio.'; if (tf <= 19) return 'Fresco.';
  return 'Agradável.';
}
const escalaUV = 'linear-gradient(90deg,#5caa62,#e8cc48,#f0923a,#dc463c,#9650a0)';
const escalaAr = 'linear-gradient(90deg,#5caa62 0 17%,#e8cc48 17% 33%,#f0923a 33% 50%,#dc463c 50% 67%,#9650a0 67%)';

export function renderWidgets(prev, ar) {
  const c = prev.current, d = prev.daily, h = prev.hourly;
  const i0 = indiceAgora(prev);

  const dif = (c.apparent_temperature ?? 0) - (c.temperature_2m ?? 0);
  $('w-sensacao').innerHTML = `${rotulo('Sensação térmica')}
    <div class="w-grande">${r0(c.apparent_temperature)}°</div>
    <p class="w-dica">${conforto(c.apparent_temperature)} ${Math.abs(dif) < 1.5 ? 'Parecida com a temperatura real.' : dif > 0 ? 'A umidade faz parecer mais quente.' : 'O vento faz parecer mais frio.'}</p>`;

  const ur = c.relative_humidity_2m;
  let umid = `Ponto de orvalho de ${r0(c.dew_point_2m)}° agora.`;
  if (ur < 12) umid = 'Estado de emergência. Beba muita água.';
  else if (ur < 20) umid = 'Ar muito seco (alerta). Evite exercícios ao ar livre.';
  else if (ur < 30) umid = 'Ar seco (atenção). Beba água com frequência.';
  else if (ur > 85) umid = `Ar muito úmido, sensação abafada. Orvalho a ${r0(c.dew_point_2m)}°.`;
  $('w-umidade').innerHTML = `${rotulo('Umidade')}<div class="w-grande">${r0(ur)}<small>%</small></div><p class="w-dica">${umid}</p>`;

  $('w-vento').innerHTML = `${rotulo('Vento')}
    <div class="vento-linha">
      <svg viewBox="0 0 100 100" class="bussola" aria-hidden="true">
        <circle cx="50" cy="50" r="46" fill="none" stroke="var(--borda-forte)" stroke-width="1.5"/>
        ${['N', 'L', 'S', 'O'].map((p, i) => `<text x="${50 + 36 * Math.sin(i * Math.PI / 2)}" y="${54 - 36 * Math.cos(i * Math.PI / 2)}" text-anchor="middle">${p}</text>`).join('')}
        <g transform="rotate(${(c.wind_direction_10m ?? 0) + 180} 50 50)"><path d="M50 20 L56 34 L50 31 L44 34 Z" fill="var(--acento)"/><line x1="50" y1="31" x2="50" y2="74" stroke="var(--acento)" stroke-width="2.5" stroke-linecap="round"/></g>
      </svg>
      <div><div class="w-grande">${r0(c.wind_speed_10m)}<small>km/h</small></div><div class="w-sub">De ${direcao(c.wind_direction_10m) || '—'}</div></div>
    </div>
    <p class="w-dica">Rajadas de até ${r0(c.wind_gusts_10m)} km/h.</p>`;

  let chuva24 = 0;
  for (let i = i0; i < Math.min(i0 + 24, h.time.length); i++) chuva24 += h.precipitation[i] || 0;
  $('w-precip').innerHTML = `${rotulo('Chuva')}
    <div class="w-grande">${num(d.precipitation_sum[0])}<small>mm hoje</small></div>
    <p class="w-dica">${chuva24 >= 0.5 ? `${num(chuva24)} mm nas próximas 24 horas.` : 'Pouca ou nenhuma chuva nas próximas 24 horas.'} Chance hoje: ${r0(d.precipitation_probability_max[0])}%.</p>`;

  const uvAgora = c.uv_index, uvMax = d.uv_index_max?.[0];
  const uv = nivelUV(uvAgora);
  $('w-uv').innerHTML = `${rotulo('Índice UV')}
    <div class="w-grande">${r0(uvAgora)}<small>${uv.nome.toLowerCase()}</small></div>
    <div class="escala" style="background:${escalaUV}"><span style="left:${Math.min(100, ((uvAgora ?? 0) / 11) * 100)}%"></span></div>
    <p class="w-dica">Máximo hoje: ${r0(uvMax)}. ${uv.dica}</p>`;

  const nasc = d.sunrise?.[0], por = d.sunset?.[0];
  if (nasc && por) {
    const tN = dataLocal(nasc), tP = dataLocal(por), tA = dataLocal(c.time);
    const f = Math.min(1, Math.max(0, (tA - tN) / (tP - tN)));
    const x = 10 + 100 * f, y = 46 - Math.sin(f * Math.PI) * 38;
    const dur = d.daylight_duration?.[0];
    const depois = tA > tP, antes = tA < tN;
    $('w-sol').innerHTML = `${rotulo(depois || antes ? 'Nascer do sol' : 'Pôr do sol')}
      <div class="w-grande">${depois ? hora(d.sunrise?.[1] || nasc) : antes ? hora(nasc) : hora(por)}</div>
      <svg viewBox="0 0 120 52" class="medidor-sol" aria-hidden="true">
        <path d="M10 46 Q60 -30 110 46" fill="none" stroke="var(--borda-forte)" stroke-width="1.5" stroke-dasharray="3 4"/>
        <line x1="2" y1="46" x2="118" y2="46" stroke="var(--borda-forte)" stroke-width="1"/>
        ${f > 0 && f < 1 ? `<circle cx="${x}" cy="${y}" r="5" fill="var(--sol)"/>` : ''}
      </svg>
      <p class="w-dica">Nascer ${hora(nasc)} · pôr ${hora(por)}${dur ? ` · ${Math.floor(dur / 3600)}h${String(Math.round((dur % 3600) / 60)).padStart(2, '0')} de luz` : ''}</p>`;
  }

  const vis = km(c.visibility);
  $('w-visib').innerHTML = `${rotulo('Visibilidade')}<div class="w-grande">${num(vis, vis != null && vis < 10 ? 1 : 0)}<small>km</small></div>
    <p class="w-dica">${vis == null ? '' : vis >= 10 ? 'Boa visibilidade.' : vis >= 4 ? 'Visibilidade reduzida.' : 'Visibilidade ruim: cuidado na estrada.'} Céu ${r0(c.cloud_cover)}% encoberto.</p>`;

  const p3 = h.pressure_msl[Math.min(i0 + 3, h.time.length - 1)];
  const tend = p3 == null || c.pressure_msl == null ? '' : p3 - c.pressure_msl > 0.8 ? 'Subindo nas próximas horas.' : p3 - c.pressure_msl < -0.8 ? 'Caindo nas próximas horas.' : 'Estável nas próximas horas.';
  $('w-pressao').innerHTML = `${rotulo('Pressão')}<div class="w-grande">${r0(c.pressure_msl)}<small>hPa</small></div><p class="w-dica">${tend}</p>`;

  const a = ar?.current;
  const n = nivelAr(a?.us_aqi);
  $('w-ar').innerHTML = a ? `${rotulo('Qualidade do ar')}
    <div class="w-grande">${r0(a.us_aqi)}<small>${n.nome.toLowerCase()}</small></div>
    <div class="escala" style="background:${escalaAr}"><span style="left:${Math.min(100, (a.us_aqi ?? 0) / 300 * 100)}%"></span></div>
    <p class="w-dica">PM2,5 ${num(a.pm2_5)} · PM10 ${num(a.pm10)} · O₃ ${r0(a.ozone)} µg/m³</p>`
    : `${rotulo('Qualidade do ar')}<p class="w-dica">Indisponível no momento.</p>`;

  // Lua: disco desenhado pela fração iluminada
  const lua = faseLua(dataLocal(c.time));
  const k = lua.iluminacao / 100;
  const crescente = lua.fase < 0.5;
  const rx = Math.abs(1 - 2 * k) * 18;
  const disco = `<svg class="lua-disco" viewBox="0 0 40 40" aria-hidden="true">
    <circle cx="20" cy="20" r="18" fill="var(--superficie-3)"/>
    <path d="M20 2 A18 18 0 0 ${crescente ? 1 : 0} 20 38 A${rx} 18 0 0 ${(k > 0.5) === crescente ? 1 : 0} 20 2 Z" fill="var(--sol)" opacity=".85"/>
    <circle cx="20" cy="20" r="18" fill="none" stroke="var(--borda-forte)"/></svg>`;
  $('w-lua').innerHTML = `${rotulo('Lua')}<div class="lua-linha">${disco}<div><div class="w-sub">${lua.nome}</div><p class="w-dica" style="padding:0">${lua.iluminacao}% iluminada</p></div></div>`;
}

/* ---------------- Fontes do consenso ---------------- */
export function renderFontes(prev) {
  const cons = prev.consenso;
  const el = $('c-fontes');
  if (!cons) { el.hidden = true; return; }
  el.hidden = false;
  const ok = cons.fontes.filter((f) => f.ok), fora = cons.fontes.filter((f) => !f.ok);
  const hoje = (f) => (f.hoje && f.hoje.max != null ? `<span class="f-hoje" title="Máxima e mínima de hoje nesta fonte">${r0(f.hoje.max)}° / ${r0(f.hoje.min)}°</span>` : '<span></span>');
  const a = cons.agora;
  el.innerHTML = `${rotulo('Fontes da previsão')}
    <p class="resumo-fontes">Consenso de <strong>${cons.nFontes} fonte${cons.nFontes === 1 ? '' : 's'}</strong> de ${new Set(ok.map((f) => f.inst.split(' (')[0])).size} institutos.
    ${a?.temp && a.n > 1 ? `Agora, a maioria indica entre ${r0(a.temp[0])}° e ${r0(a.temp[1])}°.` : ''}${cons.dias?.[0]?.concordancia ? ` Concordância para hoje: <strong>${cons.dias[0].concordancia}</strong>.` : ''}</p>
    <ul class="fontes-lista">
      ${ok.map((f) => `<li><span class="fonte-ponto ok" aria-hidden="true"></span><div><span class="f-nome">${esc(f.nome)}</span><span class="f-inst">${esc(f.inst)}${f.obs ? ` · ${esc(f.obs)}` : ''}</span></div>${hoje(f)}</li>`).join('')}
    </ul>
    ${fora.length ? `<details class="mais"><summary>${fora.length} fonte${fora.length === 1 ? '' : 's'} fora do consenso agora</summary>
      <ul class="fontes-lista">${fora.map((f) => `<li><span class="fonte-ponto" aria-hidden="true"></span><div><span class="f-nome">${esc(f.nome)}</span><span class="f-inst">${esc(f.inst)}. ${esc(f.motivo || '')}</span></div><span></span></li>`).join('')}</ul></details>` : ''}
    <details class="mais"><summary>Como o consenso é calculado</summary>
      <p>Para cada hora e cada dia juntamos as previsões de todas as fontes que responderam. Temperatura, sensação, umidade, vento, pressão e nuvens usam a <strong>mediana ponderada</strong>: um modelo muito diferente dos outros não puxa o resultado. A chuva usa a média sem o maior e o menor valor. A chance de chuva combina a fração de fontes que preveem chuva com a probabilidade por conjunto de cenários da Open-Meteo. Os valores de cada dia (chuva total, máxima, mínima, vento, chance de chuva e UV) são tirados dessas mesmas horas, para os cartões, a tabela e os gráficos mostrarem sempre os mesmos números. Modelos que costumam errar menos (como ECMWF e Met Office) têm peso um pouco maior, e o INMET tem peso maior nas máximas e mínimas.</p>
      <p>A faixa “entre…” deixa de fora as fontes mais extremas. A concordância é alta quando as máximas da maioria das fontes ficam a até 2,5° umas das outras e elas concordam sobre a chuva, média até 5° e baixa acima disso. Índice UV, visibilidade, chuva minuto a minuto e nascer e pôr do sol vêm do modelo que a Open-Meteo considera melhor para o local.</p>
    </details>`;
}

/* ---------------- Tabela de 24 horas ---------------- */
function renderTabela24h(prev, i0) {
  const h = prev.hourly;
  const fim = Math.min(i0 + 24, h.time.length);
  const idx = [];
  for (let i = i0; i < fim; i++) idx.push(i);
  // Na coluna "Agora", os mesmos valores do quadro principal
  const c = prev.current || {};
  const v = (campo, i) => (i === i0 && c[campo] != null ? c[campo] : h[campo][i]);
  const linhas = [
    ['Temperatura', (i) => `<strong>${r0(v('temperature_2m', i))}°</strong>`],
    ['Sensação', (i) => `${r0(v('apparent_temperature', i))}°`],
    ['Chance de chuva', (i) => `<span class="azul">${r0(h.precipitation_probability[i])}%</span>`],
    ['Chuva', (i) => `${num(h.precipitation[i])} mm`],
    ['Índice UV', (i) => { const u = h.uv_index[i]; return `<span class="uv" style="--c:${nivelUV(u).cor}">${r0(u)}</span>`; }],
    ['Vento', (i) => `${r0(v('wind_speed_10m', i))} ${seta(v('wind_direction_10m', i))}`],
    ['Rajadas', (i) => `${r0(v('wind_gusts_10m', i))}`],
    ['Umidade', (i) => `${r0(v('relative_humidity_2m', i))}%`],
    ['Visibilidade', (i) => `${num(km(h.visibility[i]), 0)} km`],
    ['Pressão', (i) => `${r0(v('pressure_msl', i))}`],
    ...(h.n_fontes ? [['Fontes', (i) => `${h.n_fontes[i] || '—'}`]] : []),
  ];
  $('tabela-24h').innerHTML = `<div class="tabela-caixa"><table class="tabela">
    <thead><tr><th scope="row">Hora</th>${idx.map((i) => `<th scope="col">${i === i0 ? 'Agora' : hh(h.time[i])}</th>`).join('')}</tr>
    <tr class="icones"><th scope="row"></th>${idx.map((i) => `<td title="${esc(tempo(h.weather_code[i]).desc)}">${iconeTempo(h.weather_code[i], h.is_day[i] === 1)}</td>`).join('')}</tr></thead>
    <tbody>${linhas.map(([nome, f]) => `<tr><th scope="row">${nome}</th>${idx.map((i) => `<td>${f(i)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>
  <p class="nota" style="margin-top:6px">Vento e rajadas em km/h · pressão em hPa · horário local da cidade</p>`;
}

/* ---------------- Alertas ---------------- */
const fmtData = (d) => (d ? d.toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

export function cartaoAlerta(a) {
  const emissor = a.emissor && a.emissor !== a.fonte ? ` · ${esc(a.emissor)}` : '';
  const auto = a.oficial === false;
  return `<div class="alerta${auto ? ' alerta-auto' : ''}" style="--cor:${esc(a.cor)}" role="alert">
    <div class="alerta-topo"><span class="selo" style="background:${esc(a.cor)};color:${corTextoSobre(a.cor)}">${esc(a.severidade)}</span>${a.risco ? `<span class="selo-risco">${esc(a.risco)}</span>` : ''}<span class="fonte">${esc(a.fonte)}${emissor}</span></div>
    <h3>${esc(a.titulo)}</h3>
    <p class="pequeno">${a.inicio ? `De ${fmtData(a.inicio)}` : ''}${a.fim ? ` até ${fmtData(a.fim)}` : ''}</p>
    ${a.regiao ? `<p class="pequeno">${esc(a.regiao)}</p>` : ''}
    ${a.riscos.length || a.instrucoes.length ? `<details><summary>Riscos e o que fazer</summary>
      ${a.riscos.length ? `<strong>Riscos</strong><ul>${a.riscos.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      ${a.instrucoes.length ? `<strong>Instruções</strong><ul>${a.instrucoes.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    </details>` : ''}
    ${auto ? '<p class="aviso-auto">Alerta automático do WeatherCenter, não oficial. Siga sempre a Defesa Civil (199) e o INMET.</p>' : ''}
    ${a.link && /^https:\/\//.test(a.link) ? `<p class="pequeno"><a href="${esc(a.link)}" target="_blank" rel="noopener">${auto ? 'Como o WeatherCenter detecta' : 'Ver na fonte oficial'}</a></p>` : ''}
  </div>`;
}

// Faixa no topo da previsão: os alertas da cidade, antes de tudo. Sem alerta, uma mensagem verde
// com o que foi consultado (só sobre a cidade, sem falar de alertas em outras partes do estado).
const NOMES_FONTES = { inmet: 'INMET', 'defesa-civil': 'Defesa Civil', 'defesa-civil-rs': 'Defesa Civil RS', marinha: 'Marinha', weathercenter: 'WeatherCenter' };
function renderFaixaAlertas(daCidade, cidade, resultado) {
  const el = $('faixa-alertas');
  const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
  const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  // A fonte estadual (site da Defesa Civil RS) só vale para cidades do RS
  const fontesCidade = Object.entries(NOMES_FONTES).filter(([id]) => id !== 'defesa-civil-rs' || cidade.uf === 'RS');
  const consultadas = fontesCidade.filter(([id]) => resultado.status[id] === 'ok').map(([, n]) => n);
  const fora = fontesCidade.filter(([id]) => resultado.status[id] && resultado.status[id] !== 'ok').map(([, n]) => n);
  el.hidden = false;
  if (!daCidade.length) {
    el.classList.add('sem-alerta');
    el.classList.remove('so-estado');
    el.style.removeProperty('--cor');
    el.innerHTML = `<div class="faixa-cab"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/><path d="M8.6 12.2l2.4 2.4 4.4-4.6"/></svg>
      <h2>Nenhum alerta para ${esc(cidade.nome)}</h2></div>
      <ul class="faixa-detalhes">
        <li>Nenhum aviso ativo ou previsto para a cidade agora.</li>
        <li>Fontes consultadas: ${consultadas.map(esc).join(', ')}${fora.length ? ` <span class="fora">(${fora.map(esc).join(', ')} fora do ar agora)</span>` : ''}.</li>
        <li>Verificado às ${hora} · a página confere de novo a cada 5 minutos.</li>
      </ul>`;
    return;
  }
  const principal = daCidade[0];
  const oficiais = daCidade.filter((a) => a.oficial !== false).length;
  el.classList.remove('sem-alerta', 'so-estado');
  el.style.setProperty('--cor', principal.cor);
  const itens = daCidade.slice(0, 4).map((a) => `<li><span class="selo" style="background:${esc(a.cor)};color:${corTextoSobre(a.cor)}" title="${esc(a.risco || '')}">${esc(a.severidade)}</span>${esc(a.titulo)}<span class="fonte">${esc(a.fonte)}${a.oficial === false ? ' · automático' : ''}</span></li>`).join('');
  el.innerHTML = `<div class="faixa-cab">${icone('alerta')}<h2>${plural(daCidade.length, 'alerta ativo', 'alertas ativos')} para ${esc(cidade.nome)}${oficiais ? '' : ' (automático do WeatherCenter)'}</h2></div>
    <ul>${itens}</ul>
    <div class="faixa-linha-cab"><h3>Linha do tempo dos alertas de ${esc(cidade.nome)}</h3><span>próximas 72 horas, hora a hora</span></div>
    <div class="faixa-linha" id="faixa-linha-tempo"></div>
    <div class="faixa-acoes"><button type="button" class="btn-sec" data-ir="alertas-cidade">Ver detalhes e o que fazer</button>${cidade.uf ? `<button type="button" class="btn-sec" data-ver-uf="${esc(cidade.uf)}">Ver no mapa de alertas</button>` : ''}</div>`;
  renderLinhaTempo($('faixa-linha-tempo'), daCidade, {
    vazio: `Nenhum alerta vigente ou previsto para ${cidade.nome}.`,
    aoClicar: (a) => {
      const i = daCidade.indexOf(a);
      const card = $('alertas-cidade').children[i];
      if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.classList.add('piscar'); setTimeout(() => card.classList.remove('piscar'), 1600); }
    },
  });
}

// Mostra os alertas da cidade dentro do cartão de resumo e devolve a lista
export function renderAlertasCidade(resultado, cidade, afeta) {
  const el = $('alertas-cidade');
  const faixa = $('faixa-alertas');
  if (!resultado || !Object.values(resultado.status).includes('ok')) {
    faixa.hidden = false;
    faixa.classList.remove('sem-alerta');
    faixa.classList.add('so-estado');
    faixa.style.setProperty('--cor', '#9a968c');
    faixa.innerHTML = '<div class="faixa-cab"><h2>Não foi possível consultar os alertas agora</h2></div><p class="pequeno">Tente de novo em instantes ou veja em <a href="https://alertas2.inmet.gov.br/" target="_blank" rel="noopener">alertas2.inmet.gov.br</a>. Em emergência, ligue 199.</p>';
    el.innerHTML = '';
    return [];
  }
  const daCidade = resultado.alertas.filter((a) => afeta(a, cidade));
  renderFaixaAlertas(daCidade, cidade, resultado);
  el.innerHTML = daCidade.map(cartaoAlerta).join('');
  return daCidade;
}
