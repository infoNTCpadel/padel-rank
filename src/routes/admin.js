'use strict';

const express = require('express');
const { get, all, run, transaction } = require('../db');
const { requireAdmin } = require('../lib/auth');
const { levelLabel, levelForPoints } = require('../lib/elo');
const { parseLocal, now } = require('../lib/rules');

const router = express.Router();
// Solo las rutas /admin exigen ser administrador (el router está montado en '/').
router.use('/admin', requireAdmin);

function noShowCount(userId) {
  return get(`SELECT COUNT(*) c FROM sanctions WHERE user_id = ? AND type IN ('points','block')`, userId).c;
}

router.get('/admin', (req, res) => {
  const stats = {
    users: get(`SELECT COUNT(*) c FROM users WHERE expelled = 0`).c,
    matchesOpen: get(`SELECT COUNT(*) c FROM matches WHERE status IN ('open','full')`).c,
    sanctions: get(`SELECT COUNT(*) c FROM sanctions`).c,
    noShows: get(`SELECT COUNT(*) c FROM attendance WHERE attended = 0 AND has_substitute = 0`).c,
  };
  const recent = all(
    `SELECT s.*, u.name AS user_name, a.name AS admin_name FROM sanctions s
     JOIN users u ON u.id = s.user_id JOIN users a ON a.id = s.created_by
     ORDER BY s.created_at DESC LIMIT 15`);
  res.render('admin_dashboard', { stats, recent, ok: req.query.ok, err: req.query.err });
});

router.get('/admin/usuarios', (req, res) => {
  const q = String(req.query.q || '').trim();
  let users = all(`SELECT * FROM users ORDER BY name`);
  if (q) users = users.filter(u => u.name.toLowerCase().includes(q.toLowerCase()) || u.email.includes(q.toLowerCase()));
  res.render('admin_users', {
    users: users.map(u => ({ ...u, levelName: levelLabel(u.level_index), noShows: noShowCount(u.id) })),
    q, ok: req.query.ok, err: req.query.err,
  });
});

router.get('/admin/usuarios/:id', (req, res) => {
  const user = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!user) return res.status(404).send('No encontrado.');
  const sanctions = all(
    `SELECT s.*, m.starts_at, ad.name AS admin_name FROM sanctions s
     LEFT JOIN matches m ON m.id = s.match_id JOIN users ad ON ad.id = s.created_by
     WHERE s.user_id = ? ORDER BY s.created_at DESC`, user.id);
  const noShows = all(
    `SELECT a.*, m.starts_at, m.id AS match_id FROM attendance a JOIN matches m ON m.id = a.match_id
     WHERE a.user_id = ? AND a.attended = 0 AND a.has_substitute = 0 ORDER BY m.starts_at DESC`, user.id);
  res.render('admin_user', {
    user, sanctions, noShows, levelName: levelLabel(user.level_index),
    noShowCount: noShowCount(user.id), ok: req.query.ok, err: req.query.err,
  });
});

// Sancionar: resta de puntos (máx 3), bloqueo temporal o expulsión
router.post('/admin/usuarios/:id/sancionar', (req, res) => {
  const user = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!user) return res.status(404).send('No encontrado.');
  const type = req.body.type;
  const reason = String(req.body.reason || '').slice(0, 500);
  const matchId = req.body.match_id ? Number(req.body.match_id) : null;
  if (!['points', 'block', 'expel'].includes(type)) return res.redirect(`/admin/usuarios/${user.id}?err=` + encodeURIComponent('Tipo no válido.'));
  if (!reason) return res.redirect(`/admin/usuarios/${user.id}?err=` + encodeURIComponent('Indica el motivo.'));

  transaction(() => {
    if (type === 'points') {
      const pts = Math.min(3, Math.max(1, Number(req.body.points) || 1));
      const newPoints = Math.max(0, user.points - pts);
      run('UPDATE users SET points = ?, level_index = ? WHERE id = ?', newPoints, levelForPoints(newPoints), user.id);
      run(`INSERT INTO sanctions(user_id, match_id, type, points_deducted, reason, created_by)
           VALUES (?,?,?,?,?,?)`, user.id, matchId, 'points', pts, reason, req.user.id);
    } else if (type === 'block') {
      const until = String(req.body.until || '');
      if (!parseLocal(until) || parseLocal(until) <= now()) throw new Error('Fecha de bloqueo no válida.');
      run('UPDATE users SET blocked_until = ? WHERE id = ?', until, user.id);
      run(`INSERT INTO sanctions(user_id, match_id, type, blocked_until, reason, created_by)
           VALUES (?,?,?,?,?,?)`, user.id, matchId, 'block', until, reason, req.user.id);
      run('DELETE FROM sessions WHERE user_id = ?', user.id);
    } else {
      run('UPDATE users SET expelled = 1 WHERE id = ?', user.id);
      run(`INSERT INTO sanctions(user_id, match_id, type, reason, created_by)
           VALUES (?,?,'expel',?,?)`, user.id, matchId, reason, req.user.id);
      run('DELETE FROM sessions WHERE user_id = ?', user.id);
    }
  });
  const labels = { points: 'Puntos restados.', block: 'Acceso bloqueado temporalmente.', expel: 'Socio expulsado de la competición.' };
  res.redirect(`/admin/usuarios/${user.id}?ok=` + encodeURIComponent(labels[type]));
});

// Levantar bloqueo / readmitir
router.post('/admin/usuarios/:id/perdonar', (req, res) => {
  run('UPDATE users SET blocked_until = NULL, expelled = 0 WHERE id = ?', req.params.id);
  res.redirect(`/admin/usuarios/${req.params.id}?ok=` + encodeURIComponent('Sanción levantada.'));
});

// Hacer / quitar admin
router.post('/admin/usuarios/:id/admin', (req, res) => {
  const uid = Number(req.params.id);
  if (req.body.action === 'add') run('INSERT OR IGNORE INTO admins(user_id) VALUES (?)', uid);
  else run('DELETE FROM admins WHERE user_id = ? AND user_id != ?', uid, req.user.id);
  res.redirect(`/admin/usuarios/${uid}?ok=` + encodeURIComponent('Permisos actualizados.'));
});

router.get('/admin/partidos', (req, res) => {
  const matches = all(
    `SELECT m.*, u.name AS creator_name FROM matches m JOIN users u ON u.id = m.creator_id
     ORDER BY m.starts_at DESC LIMIT 100`);
  res.render('admin_matches', { matches, ok: req.query.ok, err: req.query.err });
});

router.get('/admin/sanciones', (req, res) => {
  const sanctions = all(
    `SELECT s.*, u.name AS user_name, ad.name AS admin_name, m.starts_at FROM sanctions s
     JOIN users u ON u.id = s.user_id JOIN users ad ON ad.id = s.created_by
     LEFT JOIN matches m ON m.id = s.match_id ORDER BY s.created_at DESC LIMIT 100`);
  res.render('admin_sanctions', { sanctions });
});

module.exports = router;
