// Tela de previsão: tempo agora, previsão por hora, 10 dias, quadros de detalhes e fontes do consenso
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

// Cor de uma temperatura (para as barras dos 10 dias)
const CORES_TEMP = [[-5, '#7a9cff'], [8, '#5ac8fa'], [16, '#63d6b4'], [22, '#b8e05a'], [26, '#ffd60a'], [31, '#ff9f0a'], [36, '#ff453a'], [42, '#c9264c']];
function corTemp(t) {
  if (t <= CORES_TEMP[0][0]) return CORES_TEMP[0][1];
  for (let i = 1; i < CORES_TEMP.length; i++) if (t <= CORES_TEMP[i][0]) return CORES_TEMP[i][1];
  return CORES_TEMP[CORES_TEMP.length - 1][1];
}

const rotulo = (icone, texto) => `<h2 class="rotulo"><span aria-hidden="true">${icone}</span>${texto}</h2>`;

/* ---------------- Cabeçalho (tempo agora) ---------------- */
export function renderAgora(prev, cidade) {
  const c = prev.current, d = prev.daily;
  const t = tempo(c.weather_code, c.is_day === 1);
  document.body.dataset.tema = `${t.tema}-${c.is_day === 1 ? 'dia' : 'noite'}`;
  const cons = prev.consenso;
  const conc = cons?.dias?.[0]?.concordancia;
  // O consenso da máxima é diário; nunca mostra máxima abaixo da temperatura de agora
  const max = Math.max(d.temperature_2m_max[0], c.temperature_2m), min = Math.min(d.temperature_2m_min[0], c.temperature_2m);
  $('hero').innerHTML = `
    <p class="hero-onde">${cidade.local ? '<span aria-hidden="true">📍</span> Minha localização' : esc(UF_NOMES[cidade.uf] || cidade.uf || 'Brasil')}</p>
    <h1>${esc(cidade.nome)}</h1>
    <div class="hero-temp">${r0(c.temperature_2m)}°</div>
    <p class="hero-desc"><span aria-hidden="true">${t.icone}</span> ${esc(t.desc)}</p>
    <p class="hero-sub">Máx.: ${r0(max)}° &nbsp;Mín.: ${r0(min)}°</p>
    ${cons ? `<button type="button" class="hero-fontes" data-ir="c-fontes">Consenso de ${cons.nFontes} fonte${cons.nFontes === 1 ? '' : 's'}${conc ? ` · concordância ${conc}` : ''}</button>` : ''}`;
}

/* ---------------- Chuva nas próximas 3 horas ---------------- */
export function renderChuvaProxima(prev) {
  const m = prev.minutely_15;
  const el = $('w-chuva');
  if (!m?.precipitation?.length) { el.hidden = true; return; }
  const vals = m.precipitation.slice(0, 12);
  const total = vals.reduce((s, v) => s + (v || 0), 0);
  const primeira = vals.findIndex((v) => v >= 0.1);
  // Sem chuva à vista: o quadro some, como no app Tempo
  if (primeira < 0) { el.hidden = true; return; }
  el.hidden = false;
  const max = Math.max(1, ...vals);
  const frase = primeira === 0 ? `Chovendo agora. Cerca de ${num(total)} mm nas próximas 3 horas.`
    : `Chuva a partir das ${hora(m.time[primeira])}. Cerca de ${num(total)} mm em 3 horas.`;
  el.innerHTML = `${rotulo('☂️', 'Chuva nas próximas 3 horas')}<p class="resumo">${frase}</p>
    <div class="barras-chuva">${vals.map((v, i) => `<div title="${hora(m.time[i])}: ${num(v)} mm"><span style="height:${Math.max(4, (v / max) * 100)}%" class="${v >= 0.1 ? 'tem' : ''}"></span></div>`).join('')}</div>
    <div class="barras-eixo"><span>Agora</span><span>+1h</span><span>+2h</span><span>+3h</span></div>`;
}

/* ---------------- Previsão por hora (faixa rolável) ---------------- */
function resumoHoras(h, i0, n) {
  const fim = Math.min(i0 + n, h.time.length);
  const iChuva = (() => { for (let i = i0; i < fim; i++) if (h.precipitation_probability[i] >= 50 && (h.precipitation[i] ?? 0) >= 0.2) return i; return -1; })();
  let rajada = 0;
  for (let i = i0; i < fim; i++) rajada = Math.max(rajada, h.wind_gusts_10m[i] ?? 0);
  const partes = [];
  if (iChuva === i0) partes.push('Chuva agora.');
  else if (iChuva > 0) partes.push(`Chuva provável por volta das ${h.time[iChuva].slice(11, 13)}h.`);
  else {
    const t = tempo(h.weather_code[Math.min(i0 + 3, fim - 1)], true);
    partes.push(`${t.desc} nas próximas horas, sem chuva significativa.`);
  }
  if (rajada >= 40) partes.push(`Rajadas de vento de até ${r0(rajada)} km/h.`);
  return partes.join(' ');
}

export function renderHoras(prev) {
  const h = prev.hourly, d = prev.daily;
  const i0 = indiceAgora(prev);
  const fim = Math.min(i0 + 25, h.time.length);
  // Nascer e pôr do sol entram na faixa, entre as horas
  const sol = [];
  d.time.forEach((_, k) => {
    if (d.sunrise?.[k]) sol.push({ t: d.sunrise[k], tipo: 'nascer' });
    if (d.sunset?.[k]) sol.push({ t: d.sunset[k], tipo: 'por' });
  });
  const itens = [];
  for (let i = i0; i < fim; i++) {
    const t = tempo(h.weather_code[i], h.is_day[i] === 1);
    const p = h.precipitation_probability[i];
    itens.push(`<li${i === i0 ? ' class="agora"' : ''}>
      <span class="h-hora">${i === i0 ? 'Agora' : `${h.time[i].slice(11, 13)}h`}</span>
      <span class="h-icone" title="${esc(t.desc)}">${t.icone}${p >= 20 ? `<small>${r0(p)}%</small>` : ''}</span>
      <span class="h-temp">${r0(h.temperature_2m[i])}°</span>
    </li>`);
    const proxima = h.time[i + 1];
    for (const s of sol) {
      if (proxima && s.t > h.time[i] && s.t < proxima) {
        itens.push(`<li class="sol"><span class="h-hora">${hora(s.t)}</span><span class="h-icone">${s.tipo === 'nascer' ? '🌅' : '🌇'}</span><span class="h-temp">${s.tipo === 'nascer' ? 'Nascer do sol' : 'Pôr do sol'}</span></li>`);
      }
    }
  }
  $('resumo-horas').textContent = resumoHoras(h, i0, 24);
  const faixa = $('horas');
  faixa.innerHTML = itens.join('');
  faixa.scrollLeft = 0;
  $('grafico-24h').innerHTML = grafico24h(h, i0);
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
          <span class="d-icone" title="${esc(t.desc)}">${t.icone}${prob >= 20 ? `<small>${r0(prob)}%</small>` : ''}</span>
          <span class="d-min">${r0(mn)}°</span>
          <span class="d-barra"><span style="left:${pos(mn)}%;right:${100 - pos(mx)}%;background:linear-gradient(90deg,${corTemp(mn)},${corTemp(mx)})"></span>${i === 0 ? `<i class="d-agora" style="left:${pos(c.temperature_2m)}%"></i>` : ''}</span>
          <span class="d-max">${r0(mx)}°</span>
        </summary>
        <div class="d-det">
          <p class="d-desc"><strong>${DIAS_SEMANA_LONGO[dt.getDay()]}, ${dt.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' })}:</strong> ${esc(t.desc)}</p>
          ${k.n ? `<p class="d-cons">Consenso de ${k.n} fonte${k.n === 1 ? '' : 's'}${k.concordancia ? ` · concordância <strong>${k.concordancia}</strong>` : ''}. As fontes preveem máxima ${faixaTxt(k.max)} e mínima ${faixaTxt(k.min)}${k.chuvaFrac != null ? `; ${Math.round(k.chuvaFrac * 100)}% delas preveem chuva (1 mm ou mais)` : ''}.</p>` : ''}
          <dl>
            <div><dt>Temperatura</dt><dd>${r0(mx)}° / ${r0(mn)}°</dd></div>
            <div><dt>Sensação térmica</dt><dd>${r0(d.apparent_temperature_max[i])}° / ${r0(d.apparent_temperature_min[i])}°</dd></div>
            <div><dt>Chance de chuva</dt><dd>${r0(prob)}%</dd></div>
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
  $('dias-titulo').textContent = `Previsão para ${n} dias`;
  $('dias').innerHTML = html;
}

/* ---------------- Quadros de detalhes ---------------- */
function conforto(tf) {
  if (tf >= 40) return 'Calor extremo.'; if (tf >= 32) return 'Muito quente.'; if (tf >= 27) return 'Quente.';
  if (tf <= 5) return 'Muito frio.'; if (tf <= 14) return 'Frio.'; if (tf <= 19) return 'Fresco.';
  return 'Agradável.';
}

export function renderWidgets(prev, ar) {
  const c = prev.current, d = prev.daily, h = prev.hourly;
  const i0 = indiceAgora(prev);

  // Sensação térmica
  const dif = (c.apparent_temperature ?? 0) - (c.temperature_2m ?? 0);
  $('w-sensacao').innerHTML = `${rotulo('🌡️', 'Sensação')}
    <div class="w-grande">${r0(c.apparent_temperature)}°</div>
    <p class="w-dica">${conforto(c.apparent_temperature)} ${Math.abs(dif) < 1.5 ? 'Parecida com a temperatura real.' : dif > 0 ? 'A umidade faz parecer mais quente.' : 'O vento faz parecer mais frio.'}</p>`;

  // UV
  const uvAgora = c.uv_index, uvMax = d.uv_index_max?.[0];
  const uv = nivelUV(uvAgora);
  $('w-uv').innerHTML = `${rotulo('🔆', 'Índice UV')}
    <div class="w-grande">${r0(uvAgora)}</div><div class="w-sub">${uv.nome}</div>
    <div class="uv-barra"><span style="left:${Math.min(100, ((uvAgora ?? 0) / 11) * 100)}%"></span></div>
    <p class="w-dica">Máximo hoje: ${r0(uvMax)} (${nivelUV(uvMax).nome.toLowerCase()}). ${uv.dica}</p>`;

  // Vento
  $('w-vento').innerHTML = `${rotulo('🌬️', 'Vento')}
    <div class="vento-linha">
      <dl class="w-lista">
        <div><dt>Vento</dt><dd>${r0(c.wind_speed_10m)} km/h</dd></div>
        <div><dt>Rajadas</dt><dd>${r0(c.wind_gusts_10m)} km/h</dd></div>
        <div><dt>Direção</dt><dd>${r0(c.wind_direction_10m)}° ${direcao(c.wind_direction_10m)}</dd></div>
      </dl>
      <svg viewBox="0 0 100 100" class="bussola" aria-hidden="true">
        <circle cx="50" cy="50" r="44" fill="none" stroke="var(--borda)" stroke-width="2"/>
        ${['N', 'L', 'S', 'O'].map((p, i) => `<text x="${50 + 34 * Math.sin(i * Math.PI / 2)}" y="${54 - 34 * Math.cos(i * Math.PI / 2)}" text-anchor="middle">${p}</text>`).join('')}
        <g transform="rotate(${(c.wind_direction_10m ?? 0) + 180} 50 50)"><path d="M50 16 L57 34 L50 30 L43 34 Z" fill="#fff"/><line x1="50" y1="30" x2="50" y2="78" stroke="#fff" stroke-width="3"/></g>
      </svg>
    </div>`;

  // Sol
  const nasc = d.sunrise?.[0], por = d.sunset?.[0];
  if (nasc && por) {
    const tN = dataLocal(nasc), tP = dataLocal(por), tA = dataLocal(c.time);
    const f = Math.min(1, Math.max(0, (tA - tN) / (tP - tN)));
    const x = 10 + 100 * f, y = 62 - Math.sin(f * Math.PI) * 50;
    const dur = d.daylight_duration?.[0];
    const depois = tA > tP;
    $('w-sol').innerHTML = `${rotulo('🌅', depois || tA < tN ? 'Nascer do sol' : 'Pôr do sol')}
      <div class="w-grande">${depois ? (d.sunrise?.[1] ? hora(d.sunrise[1]) : hora(nasc)) : tA < tN ? hora(nasc) : hora(por)}</div>
      <svg viewBox="0 0 120 72" class="medidor" aria-hidden="true">
        <path d="M10 62 Q60 -38 110 62" fill="none" stroke="var(--borda)" stroke-width="2" stroke-dasharray="3 4"/>
        <line x1="4" y1="62" x2="116" y2="62" stroke="var(--borda)" stroke-width="1.5"/>
        ${f > 0 && f < 1 ? `<circle cx="${x}" cy="${y}" r="6" fill="#fff"/>` : ''}
      </svg>
      <p class="w-dica">Nascer ${hora(nasc)} · Pôr ${hora(por)}${dur ? ` · ${Math.floor(dur / 3600)}h${String(Math.round((dur % 3600) / 60)).padStart(2, '0')} de luz` : ''}</p>`;
  }

  // Chuva
  let chuva24 = 0;
  for (let i = i0; i < Math.min(i0 + 24, h.time.length); i++) chuva24 += h.precipitation[i] || 0;
  $('w-precip').innerHTML = `${rotulo('💧', 'Chuva')}
    <div class="w-grande">${num(d.precipitation_sum[0])} mm</div><div class="w-sub">previstos para hoje</div>
    <p class="w-dica">${chuva24 >= 0.5 ? `${num(chuva24)} mm nas próximas 24 horas.` : 'Pouca ou nenhuma chuva nas próximas 24 horas.'} Chance hoje: ${r0(d.precipitation_probability_max[0])}%.</p>`;

  // Umidade
  const ur = c.relative_humidity_2m;
  let umid = `O ponto de orvalho é ${r0(c.dew_point_2m)}° agora.`;
  if (ur < 12) umid = 'Umidade em estado de emergência. Beba muita água.';
  else if (ur < 20) umid = 'Ar muito seco (alerta). Hidrate-se e evite exercícios ao ar livre.';
  else if (ur < 30) umid = 'Ar seco (atenção). Beba água com frequência.';
  else if (ur > 85) umid = `Ar muito úmido, sensação abafada. Ponto de orvalho ${r0(c.dew_point_2m)}°.`;
  $('w-umidade').innerHTML = `${rotulo('💦', 'Umidade')}<div class="w-grande">${r0(ur)}%</div><p class="w-dica">${umid}</p>`;

  // Visibilidade e nuvens
  const vis = km(c.visibility);
  $('w-visib').innerHTML = `${rotulo('👁️', 'Visibilidade')}<div class="w-grande">${num(vis, vis != null && vis < 10 ? 1 : 0)} km</div>
    <p class="w-dica">${vis == null ? '' : vis >= 10 ? 'Visibilidade boa.' : vis >= 4 ? 'Visibilidade reduzida.' : 'Visibilidade ruim, cuidado na estrada.'} Céu ${r0(c.cloud_cover)}% coberto por nuvens.</p>`;

  // Pressão
  const p3 = h.pressure_msl[Math.min(i0 + 3, h.time.length - 1)];
  const tend = p3 == null || c.pressure_msl == null ? '' : p3 - c.pressure_msl > 0.8 ? 'Subindo nas próximas horas.' : p3 - c.pressure_msl < -0.8 ? 'Caindo nas próximas horas.' : 'Estável nas próximas horas.';
  $('w-pressao').innerHTML = `${rotulo('🧭', 'Pressão')}<div class="w-grande">${r0(c.pressure_msl)}</div><div class="w-sub">hPa</div><p class="w-dica">${tend}</p>`;

  // Qualidade do ar
  const a = ar?.current;
  const n = nivelAr(a?.us_aqi);
  $('w-ar').innerHTML = a ? `${rotulo('🍃', 'Qualidade do ar')}
    <div class="w-grande">${r0(a.us_aqi)}</div><div class="w-sub">${n.nome}</div>
    <div class="ar-barra"><span style="left:${Math.min(100, (a.us_aqi ?? 0) / 300 * 100)}%"></span></div>
    <p class="w-dica">PM2,5 ${num(a.pm2_5)} · PM10 ${num(a.pm10)} · O₃ ${r0(a.ozone)} µg/m³</p>`
    : `${rotulo('🍃', 'Qualidade do ar')}<p class="w-dica">Indisponível no momento.</p>`;

  // Lua
  const lua = faseLua(dataLocal(c.time));
  $('w-lua').innerHTML = `${rotulo('🌙', 'Lua')}
    <div class="lua-linha"><span class="lua-icone" aria-hidden="true">${lua.icone}</span><div><div class="w-sub forte">${lua.nome}</div><p class="w-dica">${lua.iluminacao}% iluminada</p></div></div>`;
}

/* ---------------- Fontes do consenso ---------------- */
export function renderFontes(prev) {
  const cons = prev.consenso;
  const el = $('c-fontes');
  if (!cons) { el.hidden = true; return; }
  el.hidden = false;
  const ok = cons.fontes.filter((f) => f.ok), fora = cons.fontes.filter((f) => !f.ok);
  const hoje = (f) => (f.hoje && f.hoje.max != null ? `<span class="f-hoje">${r0(f.hoje.max)}° / ${r0(f.hoje.min)}°</span>` : '');
  const a = cons.agora;
  el.innerHTML = `${rotulo('🛰️', 'Fontes da previsão')}
    <p class="resumo">A previsão é o consenso de <strong>${cons.nFontes} fonte${cons.nFontes === 1 ? '' : 's'}</strong> de ${new Set(ok.map((f) => f.inst.split(' (')[0])).size} institutos.
    ${a?.temp && a.n > 1 ? `Agora, as fontes indicam entre ${r0(a.temp[0])}° e ${r0(a.temp[1])}°.` : ''}</p>
    <ul class="fontes-lista">
      ${ok.map((f) => `<li><span class="fonte-ponto ok" aria-hidden="true"></span><div><strong>${esc(f.nome)}</strong> <span class="f-inst">${esc(f.inst)}${f.obs ? ` · ${esc(f.obs)}` : ''}</span></div>${hoje(f)}</li>`).join('')}
    </ul>
    ${fora.length ? `<details class="mais"><summary>${fora.length} fonte${fora.length === 1 ? '' : 's'} fora do consenso agora</summary>
      <ul class="fontes-lista">${fora.map((f) => `<li><span class="fonte-ponto" aria-hidden="true"></span><div><strong>${esc(f.nome)}</strong> <span class="f-inst">${esc(f.inst)}</span><div class="f-inst">${esc(f.motivo || '')}</div></div></li>`).join('')}</ul></details>` : ''}
    <details class="mais"><summary>Como o consenso é calculado</summary>
      <p class="w-dica">Para cada hora e cada dia juntamos as previsões de todas as fontes que responderam. Temperatura, sensação, umidade, vento, pressão e nuvens usam a <strong>mediana ponderada</strong>: um modelo muito diferente dos outros não puxa o resultado. A chuva usa a média sem o maior e o menor valor. A chance de chuva combina a fração de fontes que preveem chuva com a probabilidade por conjunto de cenários da Open-Meteo. Modelos que costumam errar menos (como ECMWF e Met Office) têm peso um pouco maior, e o INMET tem peso maior nas máximas e mínimas. A faixa mostrada (“as fontes preveem entre…”) deixa de fora as fontes mais extremas. A concordância é <em>alta</em> quando as máximas da maioria das fontes ficam a até 2,5° umas das outras e elas concordam sobre a chuva, <em>média</em> até 5° e <em>baixa</em> acima disso.</p>
      <p class="w-dica">Índice UV, visibilidade, chuva minuto a minuto e nascer e pôr do sol vêm do modelo que a Open-Meteo considera melhor para o local.</p>
    </details>`;
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
  <div class="legenda"><span class="l-temp">Temperatura</span><span class="l-sens">Sensação</span><span class="l-prob">Chance de chuva</span><span class="l-chuva">Chuva (mm)</span></div>`;
}

/* ---------------- Tabela de 24 horas ---------------- */
function renderTabela24h(prev, i0) {
  const h = prev.hourly;
  const fim = Math.min(i0 + 24, h.time.length);
  const idx = [];
  for (let i = i0; i < fim; i++) idx.push(i);
  const linhas = [
    ['Temperatura', (i) => `<strong>${r0(h.temperature_2m[i])}°</strong>`],
    ['Sensação', (i) => `${r0(h.apparent_temperature[i])}°`],
    ['Chance de chuva', (i) => `<span class="azul">${r0(h.precipitation_probability[i])}%</span>`],
    ['Chuva', (i) => `${num(h.precipitation[i])} mm`],
    ['Índice UV', (i) => { const u = h.uv_index[i]; return `<span class="uv" style="--c:${nivelUV(u).cor}">${r0(u)}</span>`; }],
    ['Vento', (i) => `${r0(h.wind_speed_10m[i])} ${seta(h.wind_direction_10m[i])}`],
    ['Rajadas', (i) => `${r0(h.wind_gusts_10m[i])}`],
    ['Umidade', (i) => `${r0(h.relative_humidity_2m[i])}%`],
    ['Visibilidade', (i) => `${num(km(h.visibility[i]), 0)} km`],
    ['Pressão', (i) => `${r0(h.pressure_msl[i])}`],
    ...(h.n_fontes ? [['Fontes', (i) => `${h.n_fontes[i] || '—'}`]] : []),
  ];
  $('tabela-24h').innerHTML = `<div class="tabela-caixa"><table class="tabela">
    <thead><tr><th scope="row">Hora</th>${idx.map((i) => `<th scope="col">${i === i0 ? 'Agora' : h.time[i].slice(11, 13) + 'h'}</th>`).join('')}</tr>
    <tr class="icones"><th scope="row"></th>${idx.map((i) => { const t = tempo(h.weather_code[i], h.is_day[i] === 1); return `<td title="${esc(t.desc)}">${t.icone}</td>`; }).join('')}</tr></thead>
    <tbody>${linhas.map(([nome, f]) => `<tr><th scope="row">${nome}</th>${idx.map((i) => `<td>${f(i)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>
  <p class="nota">Vento e rajadas em km/h · pressão em hPa · horário local da cidade</p>`;
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
