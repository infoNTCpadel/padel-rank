'use strict';

const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const { get, run } = require('./db');
const { loadUser } = require('./lib/auth');
const { hashPassword } = require('./lib/auth');
const { MAX_INITIAL_LEVEL, pointsForLevel } = require('./lib/elo');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layout');
app.use(expressLayouts);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Mini cookie parser (sin dependencias)
app.use((req, res, next) => {
  req.cookies = {};
  const h = req.headers.cookie;
  if (h) h.split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > 0) req.cookies[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  next();
});

app.use(loadUser);
app.use((req, res, next) => {
  res.locals.me = req.user;
  res.locals.isAdmin = req.isAdmin;
  next();
});

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/users'));
app.use('/', require('./routes/matches'));
app.use('/', require('./routes/results'));
app.use('/', require('./routes/admin'));

// Ranking público del club
app.get('/ranking', (req, res) => {
  const { levelLabel } = require('./lib/elo');
  const users = require('./db').all(
    `SELECT id, name, points, level_index FROM users WHERE expelled = 0 ORDER BY points DESC, name LIMIT 200`);
  res.render('ranking', { users, levelLabel });
});

// Seed del primer admin desde variables de entorno
(function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) return;
  let user = get('SELECT * FROM users WHERE email = ?', email);
  if (!user) {
    const r = run(
      `INSERT INTO users(name, email, phone, password_hash, birthdate, gender, level_index, points)
       VALUES (?,?,?,?,?,?,?,?)`,
      'Administrador', email, 'admin', hashPassword(password), '1980-01-01', 'M', MAX_INITIAL_LEVEL, pointsForLevel(MAX_INITIAL_LEVEL));
    user = get('SELECT * FROM users WHERE id = ?', r.lastInsertRowid);
    console.log(`[seed] admin creado: ${email}`);
  }
  run('INSERT OR IGNORE INTO admins(user_id) VALUES (?)', user.id);
})();

app.listen(PORT, () => console.log(`Padel Rank escuchando en puerto ${PORT}`));
