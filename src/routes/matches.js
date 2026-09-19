'use strict';

const express = require('express');
const { get, all, run, transaction } = require('../db');
const { requireLogin } = require('../lib/auth');
const { parseLocal, canJoin, withdrawMode, confirmedPlayers, playerCount, isBlockedBy, suggestPairs, canRegisterResult, now } = require('../lib/rules');
const { levelLabel } = require('../lib/elo');

const router = express.Router();

// ---------- Listado principal ----------
router.get('/', (req, res) => {
  const d = now();
  const p = n => String(n).padStart(2, '0');
  const isoNow = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  let matches = all(
    `SELECT m.*, u.name AS creator_name FROM matches m JOIN users u ON u.id = m.creator_id
     WHERE m.status IN ('open','full') AND m.starts_at > ?
     ORDER BY m.starts_at`, isoNow);

  const fecha = req.query.fecha || '';
  const tipo = req.query.tipo || '';
  if (fecha) matches = matches.filter(m => m.starts_at.slice(0, 10) === fecha);
  if (tipo) matches = matches.filter(m => m.character === tipo);

  const me = req.user;
  const mine = me ? new Set(all(`SELECT match_id FROM match_players WHERE user_id = ? AND state = 'confirmed'`, me.id).map(r => r.match_id)) : new Set();
  const myInvites = me ? new Set(all(`SELECT match_id FROM match_invites WHERE user_id = ? AND state != 'declined'`, me.id).map(r => r.match_id)) : new Set();

  matches = matches.filter(m => {
    if (mine.has(m.id)) return false;
    if (me && isBlockedBy(m.creator_id, me.id)) return false; // lista negra: no veo sus partidos
    if (!me) return m.visibility === 'open';
    if (m.visibility === 'invited' && !myInvites.has(m.id)) return false;
    if (m.visibility === 'favorites') {
      if (!get('SELECT 1 FROM favorites WHERE user_id = ? AND favorite_id = ?', m.creator_id, me.id)) return false;
    }
    if (m.visibility === 'level' && (me.level_index < m.level_min || me.level_index > m.level_max)) return false;
    return true;
  });

  const pendingInvites = me
    ? all(`SELECT mi.*, m.starts_at, m.court_label, m.has_court, u.name AS creator_name, m.formation
           FROM match_invites mi JOIN matches m ON m.id = mi.match_id JOIN users u ON u.id = m.creator_id
           WHERE mi.user_id = ? AND mi.state = 'pending' AND m.status != 'cancelled'`, me.id)
    : [];

  res.render('index', {
    matches, fecha, tipo, pendingInvites,
    playerCount: (id) => playerCount(id),
    ok: req.query.ok, err: req.query.err,
  });
});

// ---------- Mis partidos ----------
router.get('/mis-partidos', requireLogin, (req, res) => {
  const rows = all(
    `SELECT m.*, u.name AS creator_name, mp.role, mp.state, mp.is_substitute
     FROM match_players mp JOIN matches m ON m.id = mp.match_id JOIN users u ON u.id = m.creator_id
     WHERE mp.user_id = ? AND mp.state IN ('confirmed','withdrawn')
     ORDER BY m.starts_at DESC`, req.user.id);
  res.render('my_matches', { rows, playerCount: (id) => playerCount(id), ok: req.query.ok, err: req.query.err });
});

// ---------- Invitaciones ----------
router.get('/invitaciones', requireLogin, (req, res) => {
  const invites = all(
    `SELECT mi.*, m.*, u.name AS creator_name FROM match_invites mi
     JOIN matches m ON m.id = mi.match_id JOIN users u ON u.id = m.creator_id
     WHERE mi.user_id = ? AND mi.state = 'pending' AND m.status NOT IN ('cancelled','closed')`,
    req.user.id);
  res.render('invitations', { invites, ok: req.query.ok, err: req.query.err });
});

router.post('/invitacion/:id/aceptar', requireLogin, (req, res) => {
  const inv = get('SELECT * FROM match_invites WHERE match_id = ? AND user_id = ?', req.params.id, req.user.id);
  if (!inv || inv.state !== 'pending') return res.redirect('/invitaciones');
  const match = get('SELECT * FROM matches WHERE id = ?', inv.match_id);
  if (inv.kind === 'partner') {
    transaction(() => {
      run(`UPDATE match_players SET state = 'confirmed' WHERE match_id = ? AND user_id = ?`, match.id, req.user.id);
      run(`UPDATE match_invites SET state = 'accepted' WHERE match_id = ? AND user_id = ?`, match.id, req.user.id);
      if (match.status === 'draft') run(`UPDATE matches SET status = 'open' WHERE id = ?`, match.id);
    });
    return res.redirect('/partido/' + match.id + '?ok=' + encodeURIComponent('¡Pareja confirmada! El partido ya es visible.'));
  }
  const chk = canJoin(req.user, match);
  if (!chk.ok) {
    run(`UPDATE match_invites SET state = 'declined' WHERE match_id = ? AND user_id = ?`, match.id, req.user.id);
    return res.redirect('/invitaciones?err=' + encodeURIComponent(chk.reason));
  }
  transaction(() => {
    run(`INSERT OR IGNORE INTO match_players(match_id, user_id, role, state) VALUES (?,?,'player','confirmed')`, match.id, req.user.id);
    run(`UPDATE match_invites SET state = 'accepted' WHERE match_id = ? AND user_id = ?`, match.id, req.user.id);
    if (playerCount(match.id) >= 4) run(`UPDATE matches SET status = 'full' WHERE id = ?`, match.id);
  });
  res.redirect('/partido/' + match.id + '?ok=' + encodeURIComponent('Invitación aceptada. ¡Nos vemos en la pista!'));
});

router.post('/invitacion/:id/rechazar', requireLogin, (req, res) => {
  const inv = get('SELECT * FROM match_invites WHERE match_id = ? AND user_id = ?', req.params.id, req.user.id);
  if (!inv) return res.redirect('/invitaciones');
  transaction(() => {
    run(`UPDATE match_invites SET state = 'declined' WHERE match_id = ? AND user_id = ?`, inv.match_id, req.user.id);
    if (inv.kind === 'partner') {
      run(`DELETE FROM match_players WHERE match_id = ? AND user_id = ?`, inv.match_id, req.user.id);
    }
  });
  res.redirect('/invitaciones?ok=' + encodeURIComponent('Invitación rechazada.'));
});

// ---------- Crear partido ----------
router.get('/partidos/nuevo', requireLogin, (req, res) => {
  const users = all(`SELECT id, name FROM users WHERE id != ? AND expelled = 0 ORDER BY name LIMIT 300`, req.user.id);
  res.render('match_form', { err: req.query.err, form: {}, users });
});

router.post('/partidos', requireLogin, (req, res) => {
  const b = req.body;
  const users = all(`SELECT id, name FROM users WHERE id != ? AND expelled = 0 ORDER BY name LIMIT 300`, req.user.id);
  const fail = msg => res.render('match_form', { err: msg, form: b, users });
  const startsAt = String(b.starts_at || '');
  const start = parseLocal(startsAt);
  if (!start || start <= now()) return fail('La fecha y hora deben ser futuras.');
  if (!['open', 'level', 'favorites', 'invited'].includes(b.visibility)) return fail('Visibilidad no válida.');
  if (!['M', 'F', 'X'].includes(b.gender)) return fail('Sexo no válido.');
  if (!['pareja', 'sorteo'].includes(b.formation)) return fail('Formación no válida.');
  if (!['amistoso', 'torneo'].includes(b.character)) return fail('Carácter no válido.');
  const me = req.user;
  if (b.gender !== 'X' && me.gender !== b.gender) return fail('El sexo del partido debe incluir el tuyo.');
  const hasCourt = b.has_court === '1' ? 1 : 0;
  if (hasCourt && !String(b.court_label || '').trim()) return fail('Indica el número o nombre de la pista.');
  let levelMin = null, levelMax = null;
  if (b.visibility === 'level') {
    levelMin = Number(b.level_min); levelMax = Number(b.level_max);
    if (!Number.isInteger(levelMin) || !Number.isInteger(levelMax) || levelMin < 1 || levelMax > 18 || levelMin > levelMax) {
      return fail('Rango de niveles no válido (1 = mejor, 18 = peor).');
    }
  }
  const duration = Math.min(300, Math.max(30, Number(b.duration_min) || 90));

  // Incompatibilidad horaria del creador
  const probe = { id: -1, creator_id: me.id, starts_at: startsAt, duration_min: duration, status: 'open', gender: b.gender, visibility: 'open' };
  const chk = canJoin(me, probe);
  if (!chk.ok && !chk.reason.includes('abierto') && !chk.reason.includes('completo') && !chk.reason.includes('apuntado')) {
    return fail(chk.reason);
  }

  let partner = null;
  if (b.formation === 'pareja') {
    partner = get('SELECT * FROM users WHERE id = ?', b.partner_id);
    if (!partner || partner.id === me.id) return fail('Elige a tu pareja.');
    if (b.gender !== 'X' && partner.gender !== b.gender) return fail('Tu pareja no cumple el sexo del partido.');
    if (isBlockedBy(me.id, partner.id) || isBlockedBy(partner.id, me.id)) return fail('No puedes jugar con ese socio (lista negra).');
  }

  const id = transaction(() => {
    const r = run(
      `INSERT INTO matches(creator_id, starts_at, duration_min, has_court, court_label, visibility,
        level_min, level_max, gender, formation, character, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      me.id, startsAt, duration, hasCourt, hasCourt ? String(b.court_label).trim() : null,
      b.visibility, levelMin, levelMax, b.gender, b.formation, b.character,
      b.formation === 'pareja' ? 'draft' : 'open'
    );
    const mid = r.lastInsertRowid;
    run(`INSERT INTO match_players(match_id, user_id, role, state) VALUES (?,?,'creator','confirmed')`, mid, me.id);
    if (partner) {
      run(`INSERT INTO match_players(match_id, user_id, role, state) VALUES (?,?,'partner','pending')`, mid, partner.id);
      run(`INSERT INTO match_invites(match_id, user_id, kind) VALUES (?,?,'partner')`, mid, partner.id);
    }
    return mid;
  });

  if (b.formation === 'pareja') {
    return res.redirect(`/partido/${id}?ok=` + encodeURIComponent('Partido creado. Se publicará cuando tu pareja confirme.'));
  }
  res.redirect(`/partido/${id}?ok=` + encodeURIComponent('Partido creado.'));
});

// ---------- Detalle ----------
function matchDetail(id) {
  const match = get('SELECT m.*, u.name AS creator_name FROM matches m JOIN users u ON u.id = m.creator_id WHERE m.id = ?', id);
  if (!match) return null;
  const players = confirmedPlayers(id);
  const invites = all(`SELECT mi.*, u.name AS name FROM match_invites mi JOIN users u ON u.id = mi.user_id WHERE mi.match_id = ?`, id);
  const result = get('SELECT * FROM match_results WHERE match_id = ?', id);
  const attendance = all(`SELECT a.*, u.name AS name FROM attendance a JOIN users u ON u.id = a.user_id WHERE a.match_id = ?`, id);
  const pairs = match.pairs_json ? JSON.parse(match.pairs_json) : null;
  return { match, players, invites, result, attendance, pairs };
}

router.get('/partido/:id', (req, res) => {
  const d = matchDetail(req.params.id);
  if (!d) return res.status(404).send('Partido no encontrado.');
  const me = req.user;
  let joinCheck = null;
  if (me) joinCheck = canJoin(me, d.match);
  const myRow = me ? get(`SELECT * FROM match_players WHERE match_id = ? AND user_id = ?`, d.match.id, me.id) : null;
  const myInvite = me ? get(`SELECT * FROM match_invites WHERE match_id = ? AND user_id = ? AND state = 'pending'`, d.match.id, me.id) : null;
  const isCreator = me && me.id === d.match.creator_id;
  const seekers = d.players.filter(p => p.seeking_substitute);
  let suggestion = null;
  if (d.match.formation === 'sorteo' && d.players.length === 4 && !d.result) {
    suggestion = suggestPairs(d.players.map(p => ({ id: p.id, name: p.name, gender: p.gender, points: p.points })));
  }
  const playerIds = d.players.map(p => p.id);
  const candidates = all(
    `SELECT id, name FROM users WHERE expelled = 0 ${playerIds.length ? `AND id NOT IN (${playerIds.map(() => '?').join(',')})` : ''}
     ${me ? 'AND id != ?' : ''} ORDER BY name LIMIT 300`,
    ...playerIds, ...(me ? [me.id] : []));
  res.render('match_detail', {
    ...d, joinCheck, myRow, myInvite, isCreator,
    isAdmin: req.isAdmin, me, seekers, suggestion, candidates,
    withdrawMode: withdrawMode(d.match),
    canRegister: me && canRegisterResult(d.match) && d.players.some(p => p.id === me.id),
    levelLabel,
    ok: req.query.ok, err: req.query.err,
  });
});

// ---------- Apuntarse / baja ----------
router.post('/partido/:id/apuntarse', requireLogin, (req, res) => {
  const match = get('SELECT * FROM matches WHERE id = ?', req.params.id);
  if (!match) return res.status(404).send('No encontrado.');
  const chk = canJoin(req.user, match);
  if (!chk.ok) return res.redirect(`/partido/${match.id}?err=` + encodeURIComponent(chk.reason));
  transaction(() => {
    run(`INSERT INTO match_players(match_id, user_id, role, state) VALUES (?,?,'player','confirmed')`, match.id, req.user.id);
    run(`UPDATE match_invites SET state = 'accepted' WHERE match_id = ? AND user_id = ?`, match.id, req.user.id);
    if (playerCount(match.id) >= 4) run(`UPDATE matches SET status = 'full' WHERE id = ?`, match.id);
  });
  res.redirect(`/partido/${match.id}?ok=` + encodeURIComponent('¡Apuntado!'));
});

router.post('/partido/:id/baja', requireLogin, (req, res) => {
  const match = get('SELECT * FROM matches WHERE id = ?', req.params.id);
  if (!match) return res.status(404).send('No encontrado.');
  const row = get(`SELECT * FROM match_players WHERE match_id = ? AND user_id = ? AND state = 'confirmed'`, match.id, req.user.id);
  if (!row || row.role === 'creator') return res.redirect(`/partido/${match.id}?err=` + encodeURIComponent('No puedes darte de baja así.'));
  if (match.status === 'closed' || match.status === 'cancelled') return res.redirect(`/partido/${match.id}`);
  const mode = withdrawMode(match);
  if (mode === 'free') {
    transaction(() => {
      run(`UPDATE match_players SET state = 'withdrawn', seeking_substitute = 0 WHERE match_id = ? AND user_id = ?`, match.id, req.user.id);
      if (match.status === 'full') run(`UPDATE matches SET status = 'open' WHERE id = ?`, match.id);
    });
    return res.redirect(`/partido/${match.id}?ok=` + encodeURIComponent('Baja realizada.'));
  }
  return res.redirect(`/partido/${match.id}?err=` + encodeURIComponent('Quedan menos de 3 días: no puedes borrarte, busca un sustituto.'));
});

// Buscar sustituto (< 3 días): marco mi plaza como disponible
router.post('/partido/:id/sustituto/buscar', requireLogin, (req, res) => {
  const match = get('SELECT * FROM matches WHERE id = ?', req.params.id);
  const row = get(`SELECT * FROM match_players WHERE match_id = ? AND user_id = ? AND state = 'confirmed'`, req.params.id, req.user.id);
  if (!match || !row) return res.redirect('/mis-partidos');
  run(`UPDATE match_players SET seeking_substitute = 1 WHERE match_id = ? AND user_id = ?`, match.id, req.user.id);
  res.redirect(`/partido/${match.id}?ok=` + encodeURIComponent('Tu plaza está visible para sustitutos.'));
});

router.post('/partido/:id/sustituto/cancelar', requireLogin, (req, res) => {
  run(`UPDATE match_players SET seeking_substitute = 0 WHERE match_id = ? AND user_id = ?`, req.params.id, req.user.id);
  res.redirect(`/partido/${req.params.id}?ok=` + encodeURIComponent('Búsqueda de sustituto cancelada.'));
});

// Ocupar la plaza de un sustituto buscado
router.post('/partido/:id/sustituto/ocupar', requireLogin, (req, res) => {
  const match = get('SELECT * FROM matches WHERE id = ?', req.params.id);
  const seekerId = Number(req.body.seeker_id);
  const seeker = get(`SELECT * FROM match_players WHERE match_id = ? AND user_id = ? AND state = 'confirmed' AND seeking_substitute = 1`, req.params.id, seekerId);
  if (!match || !seeker || seekerId === req.user.id) return res.redirect(`/partido/${req.params.id}?err=` + encodeURIComponent('Plaza no disponible.'));
  try {
    transaction(() => {
      run(`UPDATE match_players SET state = 'withdrawn', seeking_substitute = 0 WHERE match_id = ? AND user_id = ?`, match.id, seekerId);
      run(`UPDATE matches SET status = 'open' WHERE id = ? AND status = 'full'`, match.id);
      const chk = canJoin(req.user, match);
      if (!chk.ok) throw new Error(chk.reason);
      run(`INSERT INTO match_players(match_id, user_id, role, state, is_substitute) VALUES (?,?,'player','confirmed',1)`, match.id, req.user.id);
    });
  } catch (e) {
    return res.redirect(`/partido/${req.params.id}?err=` + encodeURIComponent(e.message));
  }
  res.redirect(`/partido/${match.id}?ok=` + encodeURIComponent('¡Plaza ocupada!'));
});

// ---------- Invitar (visibilidad "con invitados") ----------
router.post('/partido/:id/invitar', requireLogin, (req, res) => {
  const match = get('SELECT * FROM matches WHERE id = ?', req.params.id);
  if (!match || match.creator_id !== req.user.id) return res.status(403).send('Sin permiso.');
  if (match.visibility !== 'invited') return res.redirect(`/partido/${match.id}?err=` + encodeURIComponent('Este partido no es con invitados.'));
  const target = get('SELECT * FROM users WHERE id = ?', req.body.user_id);
  if (!target || target.id === req.user.id) return res.redirect(`/partido/${match.id}?err=` + encodeURIComponent('Socio no válido.'));
  if (isBlockedBy(req.user.id, target.id) || isBlockedBy(target.id, req.user.id)) {
    return res.redirect(`/partido/${match.id}?err=` + encodeURIComponent('No puedes invitar a ese socio (lista negra).'));
  }
  const n = get(`SELECT COUNT(*) c FROM match_invites WHERE match_id = ? AND kind = 'invite'`, match.id).c;
  if (n >= 3) return res.redirect(`/partido/${match.id}?err=` + encodeURIComponent('Máximo 3 invitados.'));
  run(`INSERT OR IGNORE INTO match_invites(match_id, user_id, kind) VALUES (?,?,'invite')`, match.id, target.id);
  res.redirect(`/partido/${match.id}?ok=` + encodeURIComponent(`Invitación enviada a ${target.name}.`));
});

// ---------- Sorteo de parejas en pista ----------
router.post('/partido/:id/parejas', requireLogin, (req, res) => {
  const d = matchDetail(req.params.id);
  if (!d || d.match.formation !== 'sorteo') return res.status(404).send('No encontrado.');
  if (d.players.length !== 4 || d.result) return res.redirect(`/partido/${d.match.id}`);
  const ids = d.players.map(p => p.id);
  const sorted = [...d.players].sort((a, b) => b.points - a.points);
  let pairs;
  if (req.body.action === 'elegir' && req.user.id === sorted[0].id) {
    // El mejor elige al peor
    const rest = sorted.slice(1, 3);
    pairs = [[sorted[0].id, sorted[3].id], [rest[0].id, rest[1].id]];
  } else if (req.user.id === d.match.creator_id || req.isAdmin) {
    const s = suggestPairs(sorted.map(p => ({ id: p.id, name: p.name, gender: p.gender, points: p.points })));
    pairs = s.pairs.map(pr => pr.map(p => p.id));
  } else {
    return res.status(403).send('Sin permiso.');
  }
  if (!pairs.flat().every(id => ids.includes(id))) return res.status(400).send('Error.');
  run(`UPDATE matches SET pairs_json = ? WHERE id = ?`, JSON.stringify({ pairs, by: req.user.id }), d.match.id);
  res.redirect(`/partido/${d.match.id}?ok=` + encodeURIComponent('Parejas definidas.'));
});

// ---------- Asistencia (creador o admin) ----------
router.post('/partido/:id/asistencia', requireLogin, (req, res) => {
  const d = matchDetail(req.params.id);
  if (!d) return res.status(404).send('No encontrado.');
  if (!(req.user.id === d.match.creator_id || req.isAdmin)) return res.status(403).send('Sin permiso.');
  const body = req.body;
  transaction(() => {
    for (const p of d.players) {
      const val = body['att_' + p.id];
      const attended = val === '1' ? 1 : val === '0' ? 0 : null;
      const sub = body['sub_' + p.id];
      run(`INSERT INTO attendance(match_id, user_id, attended, has_substitute, substitute_id, updated_by, updated_at)
           VALUES (?,?,?,?,?,?,datetime('now'))
           ON CONFLICT(match_id, user_id) DO UPDATE SET attended = excluded.attended,
             has_substitute = excluded.has_substitute, substitute_id = excluded.substitute_id,
             updated_by = excluded.updated_by, updated_at = datetime('now')`,
        d.match.id, p.id, attended, sub ? 1 : 0, sub ? Number(sub) : null, req.user.id);
    }
  });
  res.redirect(`/partido/${d.match.id}?ok=` + encodeURIComponent('Asistencia guardada.'));
});

// ---------- Cancelar (creador o admin) ----------
router.post('/partido/:id/cancelar', requireLogin, (req, res) => {
  const match = get('SELECT * FROM matches WHERE id = ?', req.params.id);
  if (!match) return res.status(404).send('No encontrado.');
  if (!(req.user.id === match.creator_id || req.isAdmin)) return res.status(403).send('Sin permiso.');
  if (match.status === 'closed') return res.redirect(`/partido/${match.id}`);
  run(`UPDATE matches SET status = 'cancelled' WHERE id = ?`, match.id);
  res.redirect('/?ok=' + encodeURIComponent('Partido cancelado.'));
});

module.exports = router;
