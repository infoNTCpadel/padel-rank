'use strict';

// Autenticación: hash de contraseñas con scrypt y sesiones en BD.

const crypto = require('crypto');
const { get, run } = require('../db');
const { now } = require('./rules');

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [, salt, hash] = stored.split('$');
    const check = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function createSession(userId) {
  const id = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  run('INSERT INTO sessions(id, user_id, expires_at) VALUES (?,?,?)', id, userId, expires);
  return id;
}

function destroySession(id) {
  if (id) run('DELETE FROM sessions WHERE id = ?', id);
}

function getUserBySession(id) {
  if (!id) return null;
  const row = get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > datetime('now')`,
    id
  );
  return row || null;
}

function isAdmin(userId) {
  return !!get('SELECT 1 FROM admins WHERE user_id = ?', userId);
}

// Middleware: carga req.user y req.isAdmin; no exige login.
function loadUser(req, res, next) {
  const sid = req.cookies && req.cookies.sid;
  const user = getUserBySession(sid);
  if (user && (user.expelled || (user.blocked_until && new Date(user.blocked_until) > now()))) {
    destroySession(sid);
    res.clearCookie('sid');
    req.user = null;
  } else {
    req.user = user || null;
  }
  req.isAdmin = !!(req.user && isAdmin(req.user.id));
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login?err=' + encodeURIComponent('Inicia sesión para continuar.'));
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login?err=' + encodeURIComponent('Inicia sesión para continuar.'));
  if (!req.isAdmin) return res.status(403).send('Sin permiso.');
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  sha256,
  createSession,
  destroySession,
  getUserBySession,
  isAdmin,
  loadUser,
  requireLogin,
  requireAdmin,
};
