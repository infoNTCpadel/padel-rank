'use strict';

// Ranking ELO de 18 niveles en 6 categorías. Escala de 1800 a 0 puntos.
// Nivel 1 = 1800 pts (mejor), nivel 18 = 0 pts.

const CATEGORIES = [
  { name: 'Radical PRO', from: 1, to: 3 },
  { name: 'Radical',     from: 4, to: 6 },
  { name: 'Medio+',      from: 7, to: 9 },
  { name: 'Medio',       from: 10, to: 12 },
  { name: 'Medio-',      from: 13, to: 15 },
  { name: 'Básico',      from: 16, to: 18 },
];

// Nivel inicial máximo permitido: Medio+ (índice 7..9) o inferior.
const MAX_INITIAL_LEVEL = 7;

function pointsForLevel(idx) {
  if (idx >= 18) return 0;
  return 1800 - 100 * (idx - 1);
}

function levelForPoints(points) {
  const p = Math.max(0, Math.min(1800, Math.round(points)));
  if (p <= 99) return 18;
  return Math.max(1, 18 - Math.floor(p / 100));
}

function categoryForLevel(idx) {
  return CATEGORIES.find(c => idx >= c.from && idx <= c.to) || CATEGORIES[5];
}

function levelLabel(idx) {
  const cat = categoryForLevel(idx);
  const pos = idx - cat.from; // 0 alto, 1 medio, 2 bajo
  const sub = ['alto', 'medio', 'bajo'][pos] || '';
  return `${cat.name} ${sub}`.trim();
}

// Opciones de nivel inicial para el registro (índices 7..18).
function initialLevelOptions() {
  const opts = [];
  for (let i = MAX_INITIAL_LEVEL; i <= 18; i++) {
    opts.push({ index: i, label: `${levelLabel(i)} (${pointsForLevel(i)} pts)` });
  }
  return opts;
}

const K_FACTOR = 32;

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// Actualiza el ELO de los 4 jugadores tras un partido de torneo.
// scoreA: 1 victoria equipo A, 0 derrota, 0.5 empate (el empate no mueve puntos por normativa).
// Devuelve [{ userId, oldPoints, newPoints, delta, oldLevel, newLevel }]
function updateRatings(playersA, playersB, scoreA) {
  const avg = ps => ps.reduce((s, p) => s + p.points, 0) / ps.length;
  const rA = avg(playersA);
  const rB = avg(playersB);
  const expA = expectedScore(rA, rB);
  const expB = 1 - expA;
  const out = [];
  const apply = (players, score, exp) => {
    for (const p of players) {
      // Por normativa el empate no suma ni resta.
      const delta = score === 0.5 ? 0 : Math.round(K_FACTOR * (score - exp));
      const newPoints = Math.max(0, Math.min(1800, p.points + delta));
      out.push({
        userId: p.id,
        oldPoints: p.points,
        newPoints,
        delta: newPoints - p.points,
        oldLevel: levelForPoints(p.points),
        newLevel: levelForPoints(newPoints),
      });
    }
  };
  apply(playersA, scoreA, expA);
  apply(playersB, 1 - scoreA, expB);
  return out;
}

module.exports = {
  CATEGORIES,
  MAX_INITIAL_LEVEL,
  K_FACTOR,
  pointsForLevel,
  levelForPoints,
  categoryForLevel,
  levelLabel,
  initialLevelOptions,
  expectedScore,
  updateRatings,
};
