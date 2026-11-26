// Ícones de linha (SVG) do app. Desenho próprio, traço fino e cores sóbrias.
const svg = (corpo, classe = 'ic') => `<svg class="${classe}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${corpo}</svg>`;

const SOL = '<g class="ic-sol"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></g>';
const LUA = '<path class="ic-lua" d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>';
const NUVEM = 'M7 18.5h9.5a4 4 0 0 0 .6-7.95 5.5 5.5 0 0 0-10.4 1.2A3.4 3.4 0 0 0 7 18.5z';
const NUVEM_ALTA = 'M7 14.5h9.5a4 4 0 0 0 .6-7.95 5.5 5.5 0 0 0-10.4 1.2A3.4 3.4 0 0 0 7 14.5z';
const SOL_PEQ = '<g class="ic-sol"><circle cx="8" cy="8" r="3"/><path d="M8 2v1.3M2 8h1.3M3.8 3.8l.9.9M12.2 3.8l-.9.9M3.8 12.2l.9-.9"/></g>';
const LUA_PEQ = '<path class="ic-lua" d="M11.5 9.6A4.6 4.6 0 0 1 5.6 3.7a4.6 4.6 0 1 0 5.9 5.9z"/>';

const nuvem = (d, classe = '') => `<path class="ic-nuvem ${classe}" d="${d}"/>`;
const gotas = (n) => {
  const xs = n === 2 ? [9.5, 14.5] : [8, 12, 16];
  return `<g class="ic-chuva">${xs.map((x) => `<path d="M${x} 17.5l-1 3"/>`).join('')}</g>`;
};
const pontos = '<g class="ic-chuva"><path d="M9 18.2v.01M12 19.8v.01M15 18.2v.01"/></g>';
const raio = '<path class="ic-raio" d="M12.5 15.5l-2 3.2h3l-2 3.3"/>';
const neve = '<g class="ic-neve"><path d="M8.5 18.5v.01M12 20v.01M15.5 18.5v.01M10.2 21.3v.01M13.8 21.3v.01"/></g>';

// Ícone do tempo a partir do código da OMM (o mesmo usado pela Open-Meteo)
export function iconeTempo(code, dia = true, classe = 'ic-tempo') {
  const c = Number(code);
  let corpo;
  if (c === 0) corpo = dia ? SOL : LUA;
  else if (c === 1 || c === 2) corpo = `${dia ? SOL_PEQ : LUA_PEQ}${nuvem(NUVEM, 'ic-nuvem-frente')}`;
  else if (c === 3) corpo = nuvem(NUVEM);
  else if (c === 45 || c === 48) corpo = '<g class="ic-nevoa"><path d="M4 9h16M6 13h12M4 17h16"/></g>';
  else if (c >= 51 && c <= 57) corpo = `${nuvem(NUVEM_ALTA)}${pontos}`;
  else if (c === 61 || c === 80) corpo = `${dia ? SOL_PEQ : ''}${nuvem(NUVEM_ALTA, 'ic-nuvem-frente')}${gotas(2)}`;
  else if (c >= 61 && c <= 67 || c === 81 || c === 82) corpo = `${nuvem(NUVEM_ALTA)}${gotas(3)}`;
  else if (c >= 71 && c <= 77 || c === 85 || c === 86) corpo = `${nuvem(NUVEM_ALTA)}${neve}`;
  else if (c >= 95) corpo = `${nuvem(NUVEM_ALTA)}${raio}`;
  else corpo = nuvem(NUVEM);
  return svg(corpo, `ic ${classe}`);
}

// Ícones da interface
const UI = {
  previsao: '<circle cx="9" cy="9" r="3.2"/><path d="M9 2.8v1.2M3.8 9H2.6M5 5l.8.8M13 5l-.8.8"/><path d="M9 20h8a3.5 3.5 0 0 0 .4-6.97 4.8 4.8 0 0 0-8.9 1A3 3 0 0 0 9 20z"/>',
  mapa: '<path d="M3 6.5l6-2.5 6 2.5 6-2.5v13.5l-6 2.5-6-2.5-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>',
  alerta: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.3v.01"/>',
  local: '<path d="M12 21s-6.5-6.1-6.5-11a6.5 6.5 0 0 1 13 0c0 4.9-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  busca: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  gota: '<path d="M12 3.5s6 6.4 6 10.6a6 6 0 0 1-12 0c0-4.2 6-10.6 6-10.6z"/>',
  vento: '<path d="M3 8.5h11a2.5 2.5 0 1 0-2.5-2.5M3 12.5h15a2.5 2.5 0 1 1-2.5 2.5M3 16.5h8"/>',
  termometro: '<path d="M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z"/><path d="M12 9v7"/>',
  uv: '<circle cx="12" cy="12" r="3.5"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  olho: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  pressao: '<circle cx="12" cy="12" r="8.5"/><path d="M12 12l4-3.5M7.5 16h9"/>',
  folha: '<path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z"/><path d="M5 19l7-7"/>',
  lua: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
  nascer: '<path d="M4 18h16M7 18a5 5 0 0 1 10 0M12 4v5M9.5 6.5L12 4l2.5 2.5"/>',
  calendario: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  relogio: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  camadas: '<path d="M12 3.5l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  satelite: '<path d="M5 13l6 6M8 10l6 6M13.5 5.5l5 5-3 3-5-5z"/><path d="M4 20a3 3 0 0 1 3-3"/>',
  resumo: '<path d="M5 5h14M5 10h14M5 15h9M5 20h6"/>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
};
export const icone = (nome, classe = '') => svg(UI[nome] || '', `ic ${classe}`);
