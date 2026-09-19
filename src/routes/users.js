'use strict';

const express = require('express');
const { get, all, run } = require('../db');
const { requireLogin } = require('../lib/auth');
const { levelLabel, categoryForLevel } = require('../lib/elo');

const router = express.Router();
router.use(requireLogin);

// Mi perfil
router.get('/perfil', (req, res) => {
  const blacklist = all(
    `SELECT u.id, u.name, b.created_at FROM blacklist b JOIN users u ON u.id = b.blocked_id
     WHERE b.blocker_id = ? ORDER BY u.name`, req.user.id);
  const favorites = all(
    `SELECT u.id, u.name, u.level_index, u.points FROM favorites f JOIN users u ON u.id = f.favorite_id
     WHERE f.user_id = ? ORDER BY u.name`, req.user.id);
  const noShows = get(
    `SELECT COUNT(*) c FROM sanctions WHERE user_id = ? AND type IN ('points','block')`, req.user.id).c;
  const cat = categoryForLevel(req.user.level_index);
  res.render('profile', {
    user: req.user, blacklist, favorites, noShows,
    levelName: levelLabel(req.user.level_index), category: cat.name,
    levelLabel,
    ok: req.query.ok, err: req.query.err,
  });
});

router.post('/perfil', (req, res) => {
  const { name, email, phone } = req.body;
  const cleanPhone = String(phone || '').replace(/[\s.-]/g, '');
  if (!name || !email || !cleanPhone) return res.redirect('/perfil?err=' + encodeURIComponent('Rellena todos los campos.'));
  const emailTaken = get('SELECT 1 FROM users WHERE email = ? AND id != ?', String(email).trim().toLowerCase(), req.user.id);
  if (emailTaken) return res.redirect('/perfil?err=' + encodeURIComponent('Ese email ya está en uso.'));
  const phoneTaken = get('SELECT 1 FROM users WHERE phone = ? AND id != ?', cleanPhone, req.user.id);
  if (phoneTaken) return res.redirect('/perfil?err=' + encodeURIComponent('Ese teléfono ya está en uso.'));
  run('UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?',
    String(name).trim(), String(email).trim().toLowerCase(), cleanPhone, req.user.id);
  res.redirect('/perfil?ok=' + encodeURIComponent('Datos actualizados.'));
});

// Buscar socios (para lista negra y favoritos)
router.get('/socios', (req, res) => {
  const q = String(req.query.q || '').trim();
  let users = [];
  if (q.length >= 2) {
    users = all(
      `SELECT id, name, level_index FROM users WHERE id != ? AND name LIKE ? AND expelled = 0
       ORDER BY name LIMIT 20`, req.user.id, `%${q}%`);
  }
  const blacklistIds = new Set(all('SELECT blocked_id id FROM blacklist WHERE blocker_id = ?', req.user.id).map(r => r.id));
  const favoriteIds = new Set(all('SELECT favorite_id id FROM favorites WHERE user_id = ?', req.user.id).map(r => r.id));
  res.render('members', { q, users, blacklistIds, favoriteIds, levelLabel, ok: req.query.ok, err: req.query.err });
});

// Lista negra: añadir
router.post('/lista-negra/:id', (req, res) => {
  const target = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!target || target.id === req.user.id) return res.redirect('/socios?err=' + encodeURIComponent('Socio no válido.'));
  run('INSERT OR IGNORE INTO blacklist(blocker_id, blocked_id) VALUES (?,?)', req.user.id, target.id);
  // Si estaba en favoritos, sale de favoritos
  run('DELETE FROM favorites WHERE user_id = ? AND favorite_id = ?', req.user.id, target.id);
  res.redirect('/perfil?ok=' + encodeURIComponent(`${target.name} está en tu lista negra: no verá tus partidos ni podrá apuntarse.`));
});

// Lista negra: quitar
router.post('/lista-negra/:id/quitar', (req, res) => {
  run('DELETE FROM blacklist WHERE blocker_id = ? AND blocked_id = ?', req.user.id, req.params.id);
  res.redirect('/perfil?ok=' + encodeURIComponent('Jugador eliminado de tu lista negra.'));
});

// Favoritos: añadir / quitar
router.post('/favoritos/:id', (req, res) => {
  const target = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!target || target.id === req.user.id) return res.redirect('/socios?err=' + encodeURIComponent('Socio no válido.'));
  run('INSERT OR IGNORE INTO favorites(user_id, favorite_id) VALUES (?,?)', req.user.id, target.id);
  res.redirect('/perfil?ok=' + encodeURIComponent(`${target.name} añadido a tus favoritos.`));
});

router.post('/favoritos/:id/quitar', (req, res) => {
  run('DELETE FROM favorites WHERE user_id = ? AND favorite_id = ?', req.user.id, req.params.id);
  res.redirect('/perfil?ok=' + encodeURIComponent('Favorito eliminado.'));
});

module.exports = router;
