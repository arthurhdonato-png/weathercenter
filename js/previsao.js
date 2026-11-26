// Tela de previsão: tempo agora, widgets, 24 horas e 7 dias
import { $, esc, r0, num, tempo, direcao, nivelUV, nivelAr, faseLua, DIAS_SEMANA, DIAS_SEMANA_LONGO, UF_NOMES } from './util.js';

const hora = (iso) => iso.slice(11, 16);
const dataLocal = (iso) => new Date(iso.length <= 10 ? `${iso}T12:00:00` : iso); // horários "locais" da cidade, tratados como ingênuos
const km = (m) => (m == null ? null : m / 1000);
const seta = (graus) => `<span class="seta" style="transform:rotate(${(graus ?? 0) + 180}deg)" aria-hidden="true">↑</span>`;

function indiceAgora(prev) {
  const agora = prev.current.time.slice(0, 13);
  const i = prev.hourly.time.findIndex((t) => t.slice(0, 13) >= agora);
  return i < 0 ? 0 : i;
}

/* ---------------- Cabeçalho (tempo agora) ---------------- */
export function renderAgora(prev, cidade) {
  const c = prev.current, d = prev.daily;
  const t = tempo(c.weather_code, c.is_day === 1);
  document.body.dataset.tema = `${t.tema}-${c.is_day === 1 ? 'dia' : 'noite'}`;
  $('hero').innerHTML = `
    <div class="hero-local">
      <h1>${esc(cidade.nome)}${cidade.local ? ' <span class="tag" title="Sua localização">📍</span>' : ''}</h1>
      <p>${esc(UF_NOMES[cidade.uf] || cidade.uf || 'Brasil')} · ${dataLocal(c.time).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}, ${hora(c.time)}</p>
    </div>
    <div class="hero-principal">
      <div class="hero-icone" aria-hidden="true">${t.icone}</div>
      <div class="hero-temp">${r0(c.temperature_2m)}<span>°C</span></div>
    </div>
    <p class="hero-desc">${esc(t.desc)}</p>
    <p class="hero-sub">Sensação ${r0(c.apparent_temperature)}° · Máx ${r0(d.temperature_2m_max[0])}° · Mín ${r0(d.temperature_2m_min[0])}°</p>`;

  const uv = nivelUV(c.uv_index);
  const itens = [
    ['🌡️', 'Sensação térmica', `${r0(c.apparent_temperature)}°`],
    ['💧', 'Umidade', `${r0(c.relative_humidity_2m)}%`],
    ['🌬️', 'Vento', `${r0(c.wind_speed_10m)} km/h ${seta(c.wind_direction_10m)} ${direcao(c.wind_direction_10m)}`],
    ['💨', 'Rajadas', `${r0(c.wind_gusts_10m)} km/h`],
    ['☂️', 'Chuva agora', `${num(c.precipitation)} mm`],
    ['🔆', 'Índice UV', `${r0(c.uv_index)} <small style="color:${uv.cor}">${uv.nome}</small>`],
    ['👁️', 'Visibilidade', `${num(km(c.visibility))} km`],
    ['🧭', 'Pressão', `${r0(c.pressure_msl)} hPa`],
    ['💦', 'Ponto de orvalho', `${r0(c.dew_point_2m)}°`],
    ['☁️', 'Nuvens', `${r0(c.cloud_cover)}%`],
  ];
  $('agora-detalhes').innerHTML = itens.map(([i, n, v]) =>
    `<div class="det"><span class="det-i" aria-hidden="true">${i}</span><span class="det-n">${n}</span><span class="det-v">${v}</span></div>`).join('');
}

/* ---------------- Chuva nas próximas 3 horas ---------------- */
export function renderChuvaProxima(prev) {
  const m = prev.minutely_15;
  const el = $('w-chuva');
  if (!m?.precipitation?.length) { el.hidden = true; return; }
  el.hidden = false;
  const vals = m.precipitation.slice(0, 12);
  const max = Math.max(1, ...vals);
  const total = vals.reduce((s, v) => s + (v || 0), 0);
  const primeira = vals.findIndex((v) => v >= 0.1);
  let frase;
  if (primeira < 0) frase = 'Sem chuva prevista nas próximas 3 horas.';
  else if (primeira === 0) frase = `Chovendo agora. Cerca de ${num(total)} mm nas próximas 3 horas.`;
  else frase = `Chuva a partir das ${hora(m.time[primeira])}. Cerca de ${num(total)} mm em 3 horas.`;
  el.innerHTML = `<h3>☂️ Chuva nas próximas 3 horas</h3><p>${frase}</p>
    <div class="barras-chuva">${vals.map((v, i) => `<div title="${hora(m.time[i])}: ${num(v)} mm"><span style="height:${Math.max(2, (v / max) * 100)}%" class="${v >= 0.1 ? 'tem' : ''}"></span></div>`).join('')}</div>
    <div class="barras-eixo"><span>Agora</span><span>+1h</span><span>+2h</span><span>+3h</span></div>`;
}

/* ---------------- Widgets ---------------- */
export function renderWidgets(prev, ar) {
  const c = prev.current, d = prev.daily;

  // UV
  const uvMax = d.uv_index_max?.[0];
  const uv = nivelUV(uvMax);
  const ang = Math.min(uvMax ?? 0, 12) / 12 * 180;
  $('w-uv').innerHTML = `<h3>🔆 Índice UV máximo hoje</h3>
    <svg viewBox="0 0 120 70" class="medidor" aria-hidden="true">
      <defs><linearGradient id="g-uv"><stop offset="0" stop-color="#3ea72d"/><stop offset=".3" stop-color="#e4c600"/><stop offset=".55" stop-color="#f18b00"/><stop offset=".75" stop-color="#e53210"/><stop offset="1" stop-color="#b567a4"/></linearGradient></defs>
      <path d="M10 62 A50 50 0 0 1 110 62" fill="none" stroke="url(#g-uv)" stroke-width="10" stroke-linecap="round"/>
      <circle r="7" fill="var(--cartao)" stroke="${uv.cor}" stroke-width="4" cx="${60 - 50 * Math.cos(ang * Math.PI / 180)}" cy="${62 - 50 * Math.sin(ang * Math.PI / 180)}"/>
    </svg>
    <div class="w-valor"><strong>${r0(uvMax)}</strong> <span style="color:${uv.cor}">${uv.nome}</span></div>
    <p class="w-dica">${uv.dica}</p>`;

  // Sol
  const nasc = d.sunrise?.[0], por = d.sunset?.[0];
  if (nasc && por) {
    const tN = dataLocal(nasc), tP = dataLocal(por), tA = dataLocal(c.time);
    const f = Math.min(1, Math.max(0, (tA - tN) / (tP - tN)));
    const x = 10 + 100 * f, y = 62 - Math.sin(f * Math.PI) * 50;
    const dur = d.daylight_duration?.[0];
    $('w-sol').innerHTML = `<h3>🌅 Sol</h3>
      <svg viewBox="0 0 120 72" class="medidor" aria-hidden="true">
        <path d="M10 62 Q60 -38 110 62" fill="none" stroke="var(--borda)" stroke-width="2" stroke-dasharray="3 4"/>
        <line x1="4" y1="62" x2="116" y2="62" stroke="var(--borda)" stroke-width="1.5"/>
        ${f > 0 && f < 1 ? `<circle cx="${x}" cy="${y}" r="7" fill="#ffc531"/>` : ''}
      </svg>
      <div class="w-linhas"><span>Nascer <strong>${hora(nasc)}</strong></span><span>Pôr <strong>${hora(por)}</strong></span></div>
      ${dur ? `<p class="w-dica">${Math.floor(dur / 3600)}h${String(Math.round((dur % 3600) / 60)).padStart(2, '0')} de luz do dia</p>` : ''}`;
  }

  // Lua
  const lua = faseLua(dataLocal(c.time));
  $('w-lua').innerHTML = `<h3>🌙 Lua</h3>
    <div class="lua-icone" aria-hidden="true">${lua.icone}</div>
    <div class="w-valor"><strong>${lua.nome}</strong></div>
    <p class="w-dica">${lua.iluminacao}% iluminada</p>`;

  // Vento
  $('w-vento').innerHTML = `<h3>🌬️ Vento</h3>
    <svg viewBox="0 0 100 100" class="bussola" aria-hidden="true">
      <circle cx="50" cy="50" r="44" fill="none" stroke="var(--borda)" stroke-width="2"/>
      ${['N', 'L', 'S', 'O'].map((p, i) => `<text x="${50 + 34 * Math.sin(i * Math.PI / 2)}" y="${54 - 34 * Math.cos(i * Math.PI / 2)}" text-anchor="middle">${p}</text>`).join('')}
      <g transform="rotate(${(c.wind_direction_10m ?? 0) + 180} 50 50)"><path d="M50 16 L57 34 L50 30 L43 34 Z" fill="var(--destaque)"/><line x1="50" y1="30" x2="50" y2="78" stroke="var(--destaque)" stroke-width="3"/></g>
    </svg>
    <div class="w-valor"><strong>${r0(c.wind_speed_10m)}</strong> km/h ${direcao(c.wind_direction_10m)}</div>
    <p class="w-dica">Rajadas de até ${r0(c.wind_gusts_10m)} km/h</p>`;

  // Qualidade do ar
  const a = ar?.current;
  const n = nivelAr(a?.us_aqi);
  $('w-ar').innerHTML = a ? `<h3>🍃 Qualidade do ar</h3>
    <div class="w-valor"><strong style="color:${n.cor}">${r0(a.us_aqi)}</strong> <span>${n.nome}</span></div>
    <div class="ar-barra"><span style="left:${Math.min(100, (a.us_aqi ?? 0) / 300 * 100)}%"></span></div>
    <div class="w-linhas pequeno"><span>PM2,5 <strong>${num(a.pm2_5)}</strong></span><span>PM10 <strong>${num(a.pm10)}</strong></span><span>O₃ <strong>${r0(a.ozone)}</strong></span></div>
    <p class="w-dica">µg/m³ · índice AQI (EUA)</p>`
    : `<h3>🍃 Qualidade do ar</h3><p class="w-dica">Indisponível no momento.</p>`;

  // Conforto
  const ur = c.relative_humidity_2m, tf = c.apparent_temperature;
  let conforto = 'Agradável';
  if (tf >= 40) conforto = 'Calor extremo'; else if (tf >= 32) conforto = 'Muito quente'; else if (tf >= 27) conforto = 'Quente';
  else if (tf <= 5) conforto = 'Muito frio'; else if (tf <= 14) conforto = 'Frio'; else if (tf <= 19) conforto = 'Fresco';
  let umid = '';
  if (ur < 12) umid = 'Umidade em estado de emergência. Beba muita água.';
  else if (ur < 20) umid = 'Ar muito seco (alerta). Hidrate-se e evite exercícios ao ar livre.';
  else if (ur < 30) umid = 'Ar seco (atenção). Beba água com frequência.';
  else if (ur > 85) umid = 'Ar muito úmido, sensação abafada.';
  $('w-conforto').innerHTML = `<h3>🙂 Conforto</h3>
    <div class="w-valor"><strong>${conforto}</strong></div>
    <p class="w-dica">${umid || `Umidade de ${r0(ur)}%, dentro do normal.`}</p>`;
}

/* ---------------- Gráfico de 24 horas ---------------- */
function grafico24h(h, i0) {
  const n = Math.min(24, h.time.length - i0);
  const W = 720, H = 180, top = 22, base = 140;
  const temps = [], sens = [], chuva = [], prob = [];
  for (let k = 0; k < n; k++) {
    temps.push(h.temperature_2m[i0 + k]); sens.push(h.apparent_temperature[i0 + k]);
    chuva.push(h.precipitation[i0 + k] || 0); prob.push(h.precipitation_probability[i0 + k] || 0);
  }
  const lo = Math.min(...temps, ...sens) - 1, hi = Math.max(...temps, ...sens) + 1;
  const x = (k) => 20 + (k * (W - 40)) / (n - 1);
  const y = (v) => top + ((hi - v) * (base - top - 10)) / (hi - lo);
  const linha = (arr) => arr.map((v, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const maxC = Math.max(2, ...chuva);
  const bw = (W - 40) / n * 0.6;
  return `<svg viewBox="0 0 ${W} ${H}" class="grafico" role="img" aria-label="Temperatura e chuva nas próximas 24 horas">
    ${prob.map((p, k) => `<rect x="${x(k) - bw / 2}" y="${base - (p / 100) * 40}" width="${bw}" height="${(p / 100) * 40}" class="g-prob"/>`).join('')}
    ${chuva.map((c, k) => (c > 0 ? `<rect x="${x(k) - bw / 4}" y="${base - (c / maxC) * 40}" width="${bw / 2}" height="${(c / maxC) * 40}" class="g-chuva"/>` : '')).join('')}
    <path d="${linha(sens)}" class="g-sens"/>
    <path d="${linha(temps)}" class="g-temp"/>
    ${temps.map((v, k) => (k % 3 === 0 ? `<text x="${x(k)}" y="${y(v) - 8}" class="g-rot">${Math.round(v)}°</text>` : '')).join('')}
    ${temps.map((_, k) => (k % 3 === 0 ? `<text x="${x(k)}" y="${H - 18}" class="g-hora">${k === 0 ? 'Agora' : h.time[i0 + k].slice(11, 13) + 'h'}</text>` : '')).join('')}
  </svg>
  <div class="legenda"><span class="l-temp">Temperatura</span><span class="l-sens">Sensação</span><span class="l-prob">Prob. de chuva</span><span class="l-chuva">Chuva (mm)</span></div>`;
}

/* ---------------- Tabela de 24 horas ---------------- */
export function render24h(prev) {
  const h = prev.hourly;
  const i0 = indiceAgora(prev);
  const fim = Math.min(i0 + 24, h.time.length);
  const idx = [];
  for (let i = i0; i < fim; i++) idx.push(i);
  const linhas = [
    ['Temperatura', (i) => `<strong>${r0(h.temperature_2m[i])}°</strong>`],
    ['Sensação', (i) => `${r0(h.apparent_temperature[i])}°`],
    ['Prob. chuva', (i) => `<span class="azul">${r0(h.precipitation_probability[i])}%</span>`],
    ['Chuva', (i) => `${num(h.precipitation[i])} mm`],
    ['Índice UV', (i) => { const u = h.uv_index[i]; return `<span class="uv" style="--c:${nivelUV(u).cor}">${r0(u)}</span>`; }],
    ['Vento', (i) => `${r0(h.wind_speed_10m[i])} ${seta(h.wind_direction_10m[i])}`],
    ['Rajadas', (i) => `${r0(h.wind_gusts_10m[i])}`],
    ['Umidade', (i) => `${r0(h.relative_humidity_2m[i])}%`],
    ['Visibilidade', (i) => `${num(km(h.visibility[i]), 0)} km`],
    ['Pressão', (i) => `${r0(h.pressure_msl[i])}`],
  ];
  $('grafico-24h').innerHTML = grafico24h(h, i0);
  $('tabela-24h').innerHTML = `<table class="tabela">
    <thead><tr><th scope="row">Hora</th>${idx.map((i) => `<th scope="col">${i === i0 ? 'Agora' : h.time[i].slice(11, 13) + 'h'}</th>`).join('')}</tr>
    <tr class="icones"><th scope="row"></th>${idx.map((i) => { const t = tempo(h.weather_code[i], h.is_day[i] === 1); return `<td title="${esc(t.desc)}">${t.icone}</td>`; }).join('')}</tr></thead>
    <tbody>${linhas.map(([nome, f]) => `<tr><th scope="row">${nome}</th>${idx.map((i) => `<td>${f(i)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>
  <p class="nota">Vento e rajadas em km/h · pressão em hPa · horário local da cidade</p>`;
}

/* ---------------- 7 dias ---------------- */
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

export function render7dias(prev) {
  const d = prev.daily;
  const n = Math.min(7, d.time.length);
  const extra = mediasDiarias(prev.hourly);
  const minG = Math.min(...d.temperature_2m_min.slice(0, n)), maxG = Math.max(...d.temperature_2m_max.slice(0, n));
  const pos = (v) => ((v - minG) / Math.max(1, maxG - minG)) * 100;
  let html = '';
  for (let i = 0; i < n; i++) {
    const dt = dataLocal(d.time[i]);
    const nome = i === 0 ? 'Hoje' : i === 1 ? 'Amanhã' : DIAS_SEMANA[dt.getDay()];
    const t = tempo(d.weather_code[i]);
    const e = extra[d.time[i]] || {};
    const uv = nivelUV(d.uv_index_max[i]);
    html += `<li class="dia">
      <details>
        <summary>
          <span class="d-nome">${nome}<small>${dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</small></span>
          <span class="d-icone" title="${esc(t.desc)}">${t.icone}</span>
          <span class="d-chuva">${d.precipitation_probability_max[i] ? `💧${r0(d.precipitation_probability_max[i])}%` : ''}</span>
          <span class="d-min">${r0(d.temperature_2m_min[i])}°</span>
          <span class="d-barra"><span style="left:${pos(d.temperature_2m_min[i])}%;right:${100 - pos(d.temperature_2m_max[i])}%"></span></span>
          <span class="d-max">${r0(d.temperature_2m_max[i])}°</span>
        </summary>
        <div class="d-det">
          <p class="d-desc"><strong>${DIAS_SEMANA_LONGO[dt.getDay()]}:</strong> ${esc(t.desc)}</p>
          <dl>
            <div><dt>Temperatura</dt><dd>${r0(d.temperature_2m_max[i])}° / ${r0(d.temperature_2m_min[i])}°</dd></div>
            <div><dt>Sensação térmica</dt><dd>${r0(d.apparent_temperature_max[i])}° / ${r0(d.apparent_temperature_min[i])}°</dd></div>
            <div><dt>Prob. de chuva</dt><dd>${r0(d.precipitation_probability_max[i])}%</dd></div>
            <div><dt>Volume de chuva</dt><dd>${num(d.precipitation_sum[i])} mm</dd></div>
            <div><dt>Índice UV máx.</dt><dd>${r0(d.uv_index_max[i])} <small style="color:${uv.cor}">${uv.nome}</small></dd></div>
            <div><dt>Vento máx.</dt><dd>${r0(d.wind_speed_10m_max[i])} km/h ${direcao(d.wind_direction_10m_dominant[i])}</dd></div>
            <div><dt>Rajadas</dt><dd>${r0(d.wind_gusts_10m_max[i])} km/h</dd></div>
            <div><dt>Umidade média</dt><dd>${r0(e.urMed)}% <small>mín. ${r0(e.urMin)}%</small></dd></div>
            <div><dt>Visibilidade</dt><dd>${num(km(e.visMed), 0)} km <small>mín. ${num(km(e.visMin), 0)}</small></dd></div>
            <div><dt>Pressão média</dt><dd>${r0(e.pMed)} hPa</dd></div>
            <div><dt>Nascer do sol</dt><dd>${d.sunrise[i] ? hora(d.sunrise[i]) : '—'}</dd></div>
            <div><dt>Pôr do sol</dt><dd>${d.sunset[i] ? hora(d.sunset[i]) : '—'}</dd></div>
          </dl>
        </div>
      </details>
    </li>`;
  }
  $('dias').innerHTML = html;
}

/* ---------------- Alertas da cidade ---------------- */
const fmtData = (d) => (d ? d.toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

export function cartaoAlerta(a) {
  const emissor = a.emissor && a.emissor !== a.fonte ? ` · ${esc(a.emissor)}` : '';
  return `<div class="alerta" style="--cor:${esc(a.cor)}" role="alert">
    <div class="alerta-topo"><span class="selo" style="background:${esc(a.cor)}">${esc(a.severidade)}</span><span class="fonte">${esc(a.fonte)}${emissor}</span></div>
    <h3>${esc(a.titulo)}</h3>
    <p class="pequeno">${a.inicio ? `De ${fmtData(a.inicio)}` : ''}${a.fim ? ` até ${fmtData(a.fim)}` : ''}</p>
    ${a.regiao ? `<p class="pequeno">${esc(a.regiao)}</p>` : ''}
    ${a.riscos.length || a.instrucoes.length ? `<details><summary>Riscos e o que fazer</summary>
      ${a.riscos.length ? `<strong>Riscos</strong><ul>${a.riscos.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      ${a.instrucoes.length ? `<strong>Instruções</strong><ul>${a.instrucoes.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    </details>` : ''}
    ${a.link && /^https:\/\//.test(a.link) ? `<p class="pequeno"><a href="${esc(a.link)}" target="_blank" rel="noopener">Ver na fonte oficial</a></p>` : ''}
  </div>`;
}

export function renderAlertasCidade(resultado, cidade, afeta) {
  const el = $('alertas-cidade');
  if (!resultado || !Object.values(resultado.status).includes('ok')) {
    el.innerHTML = `<div class="aviso-neutro">⚠️ Não foi possível consultar os alertas agora. Veja em <a href="https://alertas2.inmet.gov.br/" target="_blank" rel="noopener">alertas2.inmet.gov.br</a>.</div>`;
    return;
  }
  const daCidade = resultado.alertas.filter((a) => afeta(a, cidade));
  el.innerHTML = daCidade.length
    ? daCidade.map(cartaoAlerta).join('')
    : `<div class="aviso-neutro ok">✅ Nenhum alerta ativo para ${esc(cidade.nome)}.</div>`;
}
