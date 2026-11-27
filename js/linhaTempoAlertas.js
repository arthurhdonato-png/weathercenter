// Linha do tempo dos alertas da cidade nas próximas 72 horas: uma barra horizontal por alerta, do início ao fim,
// na cor da severidade, com o tipo do evento e a fonte. Alertas que valem nas mesmas horas
// ficam em linhas diferentes (um acima do outro), nunca sobrepostos.
import { esc } from './util.js';

const HORA = 3600000;
const SIGLAS = { 'Defesa Civil': 'DC', Marinha: 'MB', WeatherCenter: 'WC' };
const ALTURA_LINHA = 30;
const DIAS_CURTOS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// Texto escuro sobre amarelo/laranja e claro sobre vermelho e roxo
export function corTextoSobre(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
  if (!m) return '#1a1a1a';
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.22 ? '#1a1a1a' : '#ffffff';
}

// Tipo do evento, curto (o título completo fica na dica e no cartão)
function tipoEvento(a) {
  if (a.evento && a.evento.length < 40) {
    const e = String(a.evento).trim().toLowerCase();
    return e.charAt(0).toUpperCase() + e.slice(1);
  }
  const t = String(a.titulo || 'Alerta').replace(/^defesa civil\s*:\s*/i, '').split(/\s[–-]\s/)[0].trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

const fmtHora = (d) => d.toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace('.', '');

// Janela de tempo fixa: as próximas 72 horas, a partir da hora atual
const JANELA_HORAS = 72;
function janela(agora) {
  const ini = Math.floor(agora / HORA) * HORA;
  return { ini, fim: ini + JANELA_HORAS * HORA };
}

// Distribui as barras em linhas: cada alerta vai para a primeira linha livre naquele intervalo
function distribuir(itens, folgaPx) {
  const linhas = [];
  for (const it of itens) {
    let k = linhas.findIndex((fimPx) => fimPx + folgaPx <= it.x);
    if (k < 0) { k = linhas.length; linhas.push(0); }
    linhas[k] = it.x + it.w;
    it.linha = k;
  }
  return linhas.length;
}

/**
 * Desenha a linha do tempo em `el`.
 * opcoes: { aoClicar(alerta), vazio: 'texto quando não há alertas', compacto: bool }
 */
export function renderLinhaTempo(el, alertas, opcoes = {}) {
  const { aoClicar, vazio = 'Nenhum alerta vigente ou previsto.', compacto = false } = opcoes;
  el.__lt = { alertas, opcoes };
  if (!el.__ltObs && 'ResizeObserver' in window) {
    let largura = el.clientWidth;
    el.__ltObs = new ResizeObserver(() => {
      if (Math.abs(el.clientWidth - largura) < 8) return;
      largura = el.clientWidth;
      renderLinhaTempo(el, el.__lt.alertas, el.__lt.opcoes);
    });
    el.__ltObs.observe(el);
  }
  const agora = Date.now();
  const { ini, fim } = janela(agora);
  // Só o que vale em algum momento das próximas 72 horas
  const validos = alertas.filter((a) => (!a.fim || +a.fim > agora) && (!a.inicio || +a.inicio < fim));
  if (!validos.length) {
    el.innerHTML = `<div class="aviso-neutro ok">${esc(vazio)}</div>`;
    return;
  }
  const horas = (fim - ini) / HORA;
  const disponivel = Math.max(280, el.clientWidth || 600);
  const px = Math.max(compacto ? 7 : 10, disponivel / horas);
  const W = Math.round(horas * px);
  const xDe = (t) => ((t - ini) / HORA) * px;

  const itens = validos.map((a) => {
    const t0 = a.inicio ? Math.max(+a.inicio, ini) : ini;
    const t1 = a.fim ? Math.min(+a.fim, fim) : fim;
    const x = xDe(t0);
    return { a, x, w: Math.max(6, xDe(t1) - x), antes: !a.inicio || +a.inicio < ini, depois: !a.fim || +a.fim > fim, futuro: a.inicio && +a.inicio > agora };
  }).sort((p, q) => p.x - q.x || (q.a.nivel - p.a.nivel));
  const nLinhas = distribuir(itens, 4);

  // Eixo: dias e horas (de N em N horas, para os rótulos não se encostarem)
  const passo = [1, 2, 3, 6, 12, 24].find((n) => n * px >= 38) || 24;
  let eixo = '';
  for (let t = ini; t <= fim; t += HORA) {
    const d = new Date(t);
    const x = xDe(t);
    if (d.getHours() === 0) {
      eixo += `<span class="lt-dia" style="left:${x}px">${DIAS_CURTOS[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}</span>`;
    }
    if (d.getHours() % passo === 0 && t < fim && x >= 14) eixo += `<span class="lt-h" style="left:${x}px">${d.getHours()}h</span>`;
  }
  const primeiroDia = new Date(ini);
  if (primeiroDia.getHours() !== 0 && (24 - primeiroDia.getHours()) * px > 70) eixo += `<span class="lt-dia lt-dia-ini" style="left:0">${primeiroDia.getHours() < 20 ? 'Hoje' : DIAS_CURTOS[primeiroDia.getDay()]}</span>`;
  const barras = itens.map((it, i) => {
    const a = it.a;
    const evento = tipoEvento(a);
    const fonte = a.oficial === false ? 'WeatherCenter' : (a.fonte || '');
    const periodo = `${a.inicio ? fmtHora(a.inicio) : 'em vigor'} até ${a.fim ? fmtHora(a.fim) : 'sem hora para acabar'}`;
    return `<button type="button" class="lt-barra${a.oficial === false ? ' lt-auto' : ''}${it.antes ? ' lt-antes' : ''}${it.depois ? ' lt-depois' : ''}${it.futuro ? ' lt-futuro' : ''}"
      data-i="${i}" style="left:${it.x.toFixed(1)}px;width:${it.w.toFixed(1)}px;top:${it.linha * ALTURA_LINHA}px;--cor:${esc(a.cor)};--cor-texto:${corTextoSobre(a.cor)}"
      title="${esc(`${a.severidade}${a.risco ? ` (${a.risco.toLowerCase()})` : ''} · ${a.titulo || evento} · ${fonte}${a.oficial === false ? ' (automático)' : ''}\n${periodo}`)}" aria-label="${esc(`${a.severidade}: ${a.titulo || evento}, fonte ${fonte}, ${periodo}`)}">
      <span class="lt-rot${it.w < 130 ? ' lt-curta' : ''}"><b>${esc(evento)}</b><span class="lt-fonte">${esc(it.w < 130 ? (SIGLAS[fonte] || fonte) : fonte)}</span></span></button>`;
  }).join('');

  const altura = nLinhas * ALTURA_LINHA;
  el.innerHTML = `<div class="lt${compacto ? ' lt-compacto' : ''}">
    <div class="lt-rolagem" tabindex="0" aria-label="Linha do tempo dos alertas nas próximas 72 horas (role para os lados)">
      <div class="lt-conteudo" style="width:${W}px;--px:${px}px">
        <div class="lt-eixo">${eixo}</div>
        <div class="lt-faixas" style="height:${altura}px">${barras}
          <i class="lt-agora" style="left:${xDe(agora).toFixed(1)}px" title="Agora"></i>
        </div>
      </div>
    </div>
    <p class="lt-nota">Próximas 72 horas · ${itens.length} alerta${itens.length === 1 ? '' : 's'}. Linha turquesa: agora · ◂ já estava valendo · ▸ continua depois das 72 h · mais claro: ainda vai começar${itens.some((it) => it.a.oficial === false) ? ' · contorno tracejado: automático do WeatherCenter' : ''}. Em barras curtas: DC = Defesa Civil, MB = Marinha, WC = WeatherCenter. Toque numa barra para ver os detalhes.</p>
  </div>`;
  el.querySelector('.lt-faixas').addEventListener('click', (e) => {
    const b = e.target.closest('.lt-barra');
    if (!b) return;
    el.querySelectorAll('.lt-barra[aria-pressed="true"]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    aoClicar?.(itens[+b.dataset.i].a);
  });
}
