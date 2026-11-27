// Tema claro ou escuro. Sem escolha, segue o aparelho; o botão do topo fixa a escolha da pessoa.
// Quem precisa redesenhar algo (mapas) escuta o evento 'wc:tema' no document.
import { $, store } from './util.js';
import { temaEscuro } from './mapaBase.js';

const raiz = document.documentElement;
const avisar = () => document.dispatchEvent(new CustomEvent('wc:tema', { detail: { escuro: temaEscuro() } }));

function atualizarBotao() {
  const b = $('btn-tema');
  if (!b) return;
  const escuro = temaEscuro();
  b.setAttribute('aria-pressed', String(escuro));
  const texto = escuro ? 'Usar tema claro' : 'Usar tema escuro';
  b.setAttribute('aria-label', texto);
  b.title = texto;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = escuro ? '#0b1016' : '#f3f5f8'; });
}

export function definirTema(tema) {
  raiz.classList.add('trocando-tema');
  if (tema) raiz.dataset.tema = tema; else delete raiz.dataset.tema;
  store.set('wc:tema', tema || null);
  atualizarBotao();
  avisar();
  setTimeout(() => raiz.classList.remove('trocando-tema'), 450);
}

export function iniciarTema() {
  atualizarBotao();
  $('btn-tema')?.addEventListener('click', () => definirTema(temaEscuro() ? 'claro' : 'escuro'));
  // Sem escolha fixa: acompanha o aparelho quando ele muda de claro para escuro
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (!raiz.dataset.tema) { atualizarBotao(); avisar(); }
  });
}
