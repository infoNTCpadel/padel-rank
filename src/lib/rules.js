'use strict';

// Reglas de negocio: edad, incompatibilidades, bajas, validación de marcadores y sorteo.

const { get, all } = require('../db');

const MIN_AGE = 14;
const WITHDRAW_FREE_MS = 3 * 24 * 3600 * 1000; // más de 3 días: baja libre
const MIN_GAP_MS = 90 * 60 * 1000;             // 1h30 entre partidos
const RESULT_WINDOW_DAYS = 1;                  // día del partido + siguiente

// Reloj inyectable (tests): FAKE_NOW con fecha ISO. En producción, hora real.
function now() {
  return process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : new Date();
}

function parseLocal(iso) {
  // 'YYYY-MM-DDTHH:MM' en hora local del servidor
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function ageOn(birthdate, onDate = new Date()) {
  const b = new Date(birthdate + 'T00:00:00');
  let age = onDate.getFullYear() - b.getFullYear();
  const m = onDate.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && onDate.getDate() < b.getDate())) age--;
  return age;
}

function isBlockedBy(blockerId, userId) {
  return !!get('SELECT 1 FROM blacklist WHERE blocker_id = ? AND blocked_id = ?', blockerId, userId);
}

function confirmedPlayers(matchId) {
  return all(
    `SELECT u.*, mp.role, mp.is_substitute, mp.seeking_substitute
     FROM match_players mp JOIN users u ON u.id = mp.user_id
     WHERE mp.match_id = ? AND mp.state = 'confirmed' ORDER BY mp.created_at`,
    matchId
  );
}

function playerCount(matchId) {
  return get(`SELECT COUNT(*) c FROM match_players WHERE match_id = ? AND state = 'confirmed'`, matchId).c;
}

// Partidos confirmados del usuario en un día (para incompatibilidades)
function userMatchesOnDay(userId, dayStart, dayEnd, excludeMatchId = null) {
  return all(
    `SELECT m.* FROM matches m
     JOIN match_players mp ON mp.match_id = m.id
     WHERE mp.user_id = ? AND mp.state = 'confirmed'
       AND m.status IN ('open','full')
       AND m.starts_at >= ? AND m.starts_at < ?
       ${excludeMatchId ? 'AND m.id != ?' : ''}`,
    ...(excludeMatchId ? [userId, dayStart, dayEnd, excludeMatchId] : [userId, dayStart, dayEnd])
  );
}

function dayBounds(startsAt) {
  const d = parseLocal(startsAt);
  const s = new Date(d); s.setHours(0, 0, 0, 0);
  const e = new Date(s); e.setDate(e.getDate() + 1);
  const fmt = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return [fmt(s) + 'T00:00', fmt(e) + 'T00:00'];
}

// ¿Puede el usuario apuntarse a este partido? Devuelve { ok, reason }
function canJoin(user, match) {
  if (!user) return { ok: false, reason: 'Tienes que iniciar sesión.' };
  if (match.status !== 'open') return { ok: false, reason: 'El partido no está abierto.' };
  if (parseLocal(match.starts_at) <= now()) return { ok: false, reason: 'El partido ya ha empezado.' };
  if (isBlockedBy(match.creator_id, user.id)) {
    return { ok: false, reason: 'No puedes apuntarte a este partido.' };
  }
  if (match.gender !== 'X' && user.gender !== match.gender) {
    return { ok: false, reason: 'Este partido es solo para ' + (match.gender === 'M' ? 'hombres' : 'mujeres') + '.' };
  }
  if (match.visibility === 'level' && (user.level_index < match.level_min || user.level_index > match.level_max)) {
    return { ok: false, reason: 'Tu nivel no entra en el rango de este partido.' };
  }
  if (match.visibility === 'favorites') {
    const fav = get('SELECT 1 FROM favorites WHERE user_id = ? AND favorite_id = ?', match.creator_id, user.id);
    if (!fav) return { ok: false, reason: 'Este partido es solo para favoritos del organizador.' };
  }
  if (match.visibility === 'invited') {
    const inv = get(`SELECT 1 FROM match_invites WHERE match_id = ? AND user_id = ? AND state != 'declined'`, match.id, user.id);
    if (!inv) return { ok: false, reason: 'Este partido es solo con invitación.' };
  }
  if (playerCount(match.id) >= 4) return { ok: false, reason: 'El partido está completo.' };
  const already = get('SELECT 1 FROM match_players WHERE match_id = ? AND user_id = ? AND state = ?', match.id, user.id, 'confirmed');
  if (already) return { ok: false, reason: 'Ya estás apuntado.' };

  // Incompatibilidad horaria: 1h30 de margen entre partidos del mismo día
  const [ds, de] = dayBounds(match.starts_at);
  const mine = userMatchesOnDay(user.id, ds, de, match.id);
  const start = parseLocal(match.starts_at);
  const end = new Date(start.getTime() + (match.duration_min || 90) * 60000);
  for (const m of mine) {
    const s2 = parseLocal(m.starts_at);
    const e2 = new Date(s2.getTime() + (m.duration_min || 90) * 60000);
    const overlap = start < e2 && s2 < end;
    const gap = overlap ? 0 : Math.min(Math.abs(start - e2), Math.abs(s2 - end));
    if (overlap || gap < MIN_GAP_MS) {
      return { ok: false, reason: 'Tienes otro partido demasiado cerca en el tiempo (mínimo 1h30 de margen).' };
    }
  }
  // Mismos 4 jugadores dos veces el mismo día: no
  const newSet = new Set([...confirmedPlayers(match.id).map(p => p.id), user.id]);
  if (newSet.size === 4) {
    for (const m of mine) {
      const setM = new Set(confirmedPlayers(m.id).map(p => p.id));
      if (setM.size === 4 && [...setM].every(id => newSet.has(id))) {
        return { ok: false, reason: 'No puedes jugar dos partidos el mismo día con exactamente los mismos 4 jugadores.' };
      }
    }
  }
  return { ok: true };
}

// ¿Baja libre o necesita sustituto?
function withdrawMode(match) {
  const ms = parseLocal(match.starts_at) - now().getTime();
  return ms > WITHDRAW_FREE_MS ? 'free' : 'substitute';
}

// Ventana de registro de resultados: día del partido y el siguiente
function resultWindow(match) {
  const d = parseLocal(match.starts_at);
  const s = new Date(d); s.setHours(0, 0, 0, 0);
  const e = new Date(s); e.setDate(e.getDate() + RESULT_WINDOW_DAYS + 1);
  return { from: s, to: e };
}
function canRegisterResult(match) {
  if (match.status === 'cancelled' || match.status === 'closed') return false;
  const { from, to } = resultWindow(match);
  const t = now().getTime();
  return t >= from.getTime() && t < to.getTime();
}

// Validación de un set: devuelve { valid, winner: 'A'|'B'|null }
function validateSet(a, b, tiebreak) {
  a = Number(a); b = Number(b);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 7 || b > 7) {
    return { valid: false, winner: null };
  }
  const win = (x, y) => (x === 6 && y <= 4) || (x === 7 && (y === 5 || y === 6));
  if (win(a, b)) {
    if (a === 7 && b === 6 && !tiebreak) return { valid: false, winner: null }; // 6-6 exige tie-break
    return { valid: true, winner: 'A' };
  }
  if (win(b, a)) {
    if (b === 7 && a === 6 && !tiebreak) return { valid: false, winner: null };
    return { valid: true, winner: 'B' };
  }
  return { valid: false, winner: null };
}

// Sugerencia de parejas para sorteo en pista
function suggestPairs(players) {
  // players: [{id,name,gender,points}]
  const sorted = [...players].sort((a, b) => b.points - a.points);
  const men = sorted.filter(p => p.gender === 'M');
  const women = sorted.filter(p => p.gender === 'F');
  if (men.length === 2 && women.length === 2) {
    // Mixto: un hombre y una mujer por pareja, sorteo del cruce
    const m = [...men].sort(() => Math.random() - 0.5);
    const w = [...women].sort(() => Math.random() - 0.5);
    return { mode: 'mixed', pairs: [[m[0], w[0]], [m[1], w[1]]] };
  }
  // El mejor puede elegir al peor; sugerencia por defecto: 1º+4º vs 2º+3º
  return {
    mode: 'ranked',
    bestId: sorted[0].id,
    worstId: sorted[sorted.length - 1].id,
    pairs: [[sorted[0], sorted[3]], [sorted[1], sorted[2]]],
  };
}

module.exports = {
  MIN_AGE,
  parseLocal,
  ageOn,
  isBlockedBy,
  confirmedPlayers,
  playerCount,
  canJoin,
  withdrawMode,
  resultWindow,
  canRegisterResult,
  validateSet,
  suggestPairs,
  now,
};
