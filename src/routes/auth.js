'use strict';

const express = require('express');
const { get, run, transaction } = require('../db');
const { hashPassword, verifyPassword, sha256, createSession, destroySession } = require('../lib/auth');
const { now } = require('../lib/rules');
const { ageOn, MIN_AGE, parseLocal } = require('../lib/rules');
const { initialLevelOptions, pointsForLevel, MAX_INITIAL_LEVEL, levelLabel } = require('../lib/elo');

const router = express.Router();

router.get('/registro', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('register', { levels: initialLevelOptions(), form: {}, err: req.query.err });
});

router.post('/registro', (req, res) => {
  const { name, email, phone, password, birthdate, gender, level_index } = req.body;
  const form = { name, email, phone, birthdate, gender, level_index };
  const fail = msg => res.render('register', { levels: initialLevelOptions(), form, err: msg });

  if (!name || !email || !phone || !password || !birthdate || !gender) return fail('Rellena todos los campos.');
  if (!['M', 'F'].includes(gender)) return fail('Sexo no válido.');
  if (String(password).length < 6) return fail('La contraseña debe tener al menos 6 caracteres.');
  if (ageOn(birthdate) < MIN_AGE) return fail(`Debes tener al menos ${MIN_AGE} años para registrarte.`);
  const lvl = Number(level_index);
  if (!Number.isInteger(lvl) || lvl < MAX_INITIAL_LEVEL || lvl > 18) {
    return fail('Nivel inicial no válido (máximo Medio+).');
  }
  const cleanPhone = String(phone).replace(/[\s.-]/g, '');
  if (get('SELECT 1 FROM deleted_phones WHERE phone_hash = ?', sha256(cleanPhone))) {
    return fail('Este número de teléfono no puede volver a registrarse.');
  }
  if (get('SELECT 1 FROM users WHERE email = ?', email.trim().toLowerCase())) return fail('Ese email ya está registrado.');
  if (get('SELECT 1 FROM users WHERE phone = ?', cleanPhone)) return fail('Ese teléfono ya está registrado.');

  const user = transaction(() => {
    const r = run(
      `INSERT INTO users(name, email, phone, password_hash, birthdate, gender, level_index, points)
       VALUES (?,?,?,?,?,?,?,?)`,
      name.trim(), email.trim().toLowerCase(), cleanPhone,
      hashPassword(password), birthdate, gender, lvl, pointsForLevel(lvl)
    );
    return get('SELECT * FROM users WHERE id = ?', r.lastInsertRowid);
  });

  const sid = createSession(user.id);
  res.cookie('sid', sid, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax' });
  res.redirect('/?ok=' + encodeURIComponent(`¡Bienvenido/a, ${user.name}! Tu nivel inicial es ${levelLabel(lvl)}.`));
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { err: req.query.err });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = get('SELECT * FROM users WHERE email = ?', String(email || '').trim().toLowerCase());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    return res.render('login', { err: 'Email o contraseña incorrectos.' });
  }
  if (user.expelled) return res.render('login', { err: 'Tu cuenta ha sido expulsada de la competición.' });
  if (user.blocked_until && new Date(user.blocked_until) > now()) {
    return res.render('login', { err: 'Tu acceso está bloqueado temporalmente.' });
  }
  const sid = createSession(user.id);
  res.cookie('sid', sid, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax' });
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  destroySession(req.cookies && req.cookies.sid);
  res.clearCookie('sid');
  res.redirect('/login');
});

// Baja de cuenta: se conserva el hash del teléfono (antifraude)
router.post('/baja', (req, res) => {
  if (!req.user) return res.redirect('/login');
  const { password, confirm } = req.body;
  if (confirm !== 'ELIMINAR') return res.redirect('/perfil?err=' + encodeURIComponent('Escribe ELIMINAR para confirmar.'));
  if (!verifyPassword(String(password || ''), req.user.password_hash)) {
    return res.redirect('/perfil?err=' + encodeURIComponent('Contraseña incorrecta.'));
  }
  const uid = req.user.id;
  transaction(() => {
    run('INSERT OR IGNORE INTO deleted_phones(phone_hash) VALUES (?)', sha256(req.user.phone));
    run('DELETE FROM sessions WHERE user_id = ?', uid);
    run('DELETE FROM blacklist WHERE blocker_id = ? OR blocked_id = ?', uid, uid);
    run('DELETE FROM favorites WHERE user_id = ? OR favorite_id = ?', uid, uid);
    run('DELETE FROM match_invites WHERE user_id = ?', uid);
    run(`UPDATE match_players SET state = 'withdrawn' WHERE user_id = ?`, uid);
    run('DELETE FROM admins WHERE user_id = ?', uid);
    run('DELETE FROM users WHERE id = ?', uid);
  });
  destroySession(req.cookies && req.cookies.sid);
  res.clearCookie('sid');
  res.redirect('/login?err=' + encodeURIComponent('Cuenta eliminada.'));
});

module.exports = router;
