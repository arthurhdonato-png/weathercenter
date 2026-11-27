// Padrão único de níveis de alerta do WeatherCenter (o mesmo em toda a página, no mapa e nas notificações):
//   1 Amarelo  · Perigo Potencial · Risco Moderado
//   2 Laranja  · Perigo           · Risco Alto
//   3 Vermelho · Grande Perigo    · Risco Muito Alto
//   4 Roxo     · Alerta Extremo   · Risco Extremo
// Cada fonte usa nomes próprios (INMET: Perigo Potencial/Perigo/Grande Perigo; Defesa Civil em CAP:
// Minor/Moderate/Severe/Extreme e o texto "RISCO ALTO" etc.); aqui tudo vira um desses quatro níveis.
import { norm } from './util.js';

export const NIVEIS = {
  1: { n: 1, cor: '#FFD400', corNome: 'Amarelo', nome: 'Perigo Potencial', risco: 'Risco Moderado' },
  2: { n: 2, cor: '#FF8C00', corNome: 'Laranja', nome: 'Perigo', risco: 'Risco Alto' },
  3: { n: 3, cor: '#E60000', corNome: 'Vermelho', nome: 'Grande Perigo', risco: 'Risco Muito Alto' },
  4: { n: 4, cor: '#8E24AA', corNome: 'Roxo', nome: 'Alerta Extremo', risco: 'Risco Extremo' },
};
export const LISTA_NIVEIS = [4, 3, 2, 1].map((n) => NIVEIS[n]);

const limitar = (n) => Math.max(1, Math.min(4, Math.round(Number(n) || 1)));

// Nível escrito no próprio texto do alerta (a Defesa Civil escreve "ALERTA RISCO ALTO: ...")
// ou "Alerta VERMELHO"); igual a coletor/coletar.py → nivel_no_texto
function nivelNoTexto(t) {
  if (/alerta extremo|risco extremo|alerta roxo/.test(t)) return 4;
  if (/risco muito alto|grande perigo|alerta vermelho/.test(t)) return 3;
  if (/risco alto|alerta laranja/.test(t)) return 2;
  if (/risco moderado|perigo potencial|alerta amarelo/.test(t)) return 1;
  return 0;
}

// Severidade CAP (Defesa Civil) em inglês ou como o coletor traduzia
const CAP = { minor: 1, menor: 1, moderate: 1, moderada: 1, severe: 2, severa: 2, extreme: 4, extrema: 4 };
const NOMES = { 'perigo potencial': 1, perigo: 2, 'grande perigo': 3, 'alerta extremo': 4 };

export function nivelPadrao(a) {
  const sev = norm(a.severidade);
  if (a.fonte === 'INMET') {
    if (sev.includes('grande')) return 3;
    if (sev === 'perigo') return 2;
    return 1;
  }
  if (NOMES[sev]) return NOMES[sev]; // já no padrão (coletor novo)
  if (a.fonteId === 'defesa-civil' || a.fonte === 'Defesa Civil') {
    const t = nivelNoTexto(norm(`${a.titulo || ''} ${a.riscos?.[0] || ''}`));
    if (t) return t;
    if (CAP[sev]) return CAP[sev];
  }
  return limitar(a.nivel);
}

// Dá ao alerta o nível, a cor e os nomes do padrão (guarda o nome original da fonte)
export function padronizar(a) {
  const n = nivelPadrao(a);
  const p = NIVEIS[n];
  if (a.severidadeFonte == null && a.severidade && !NOMES[norm(a.severidade)]) a.severidadeFonte = a.severidade;
  a.nivel = n;
  a.cor = p.cor;
  a.severidade = p.nome;
  a.risco = p.risco;
  return a;
}

export const rotuloNivel = (n) => `${NIVEIS[limitar(n)].nome} · ${NIVEIS[limitar(n)].risco}`;
