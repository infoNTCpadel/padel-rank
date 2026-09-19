'use strict';

// Capa de acceso a datos con node:sqlite (integrado en Node 24, sin dependencias nativas).

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'club.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  birthdate TEXT NOT NULL,
  gender TEXT NOT NULL CHECK(gender IN ('M','F')),
  level_index INTEGER NOT NULL,
  points INTEGER NOT NULL,
  blocked_until TEXT,
  expelled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS deleted_phones(
  phone_hash TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blacklist(
  blocker_id INTEGER NOT NULL,
  blocked_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(blocker_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS favorites(
  user_id INTEGER NOT NULL,
  favorite_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(user_id, favorite_id)
);
CREATE TABLE IF NOT EXISTS matches(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL,
  starts_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 90,
  has_court INTEGER NOT NULL DEFAULT 0,
  court_label TEXT,
  visibility TEXT NOT NULL CHECK(visibility IN ('open','level','favorites','invited')),
  level_min INTEGER,
  level_max INTEGER,
  gender TEXT NOT NULL CHECK(gender IN ('M','F','X')),
  formation TEXT NOT NULL CHECK(formation IN ('pareja','sorteo')),
  character TEXT NOT NULL CHECK(character IN ('amistoso','torneo')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','full','closed','cancelled')),
  pairs_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS match_players(
  match_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('creator','partner','player')),
  state TEXT NOT NULL DEFAULT 'confirmed' CHECK(state IN ('pending','confirmed','withdrawn')),
  is_substitute INTEGER NOT NULL DEFAULT 0,
  seeking_substitute INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(match_id, user_id)
);
CREATE TABLE IF NOT EXISTS match_invites(
  match_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','declined')),
  kind TEXT NOT NULL DEFAULT 'invite' CHECK(kind IN ('invite','partner')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(match_id, user_id)
);
CREATE TABLE IF NOT EXISTS match_results(
  match_id INTEGER PRIMARY KEY,
  registered_by INTEGER NOT NULL,
  team_a TEXT NOT NULL,
  team_b TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('A','B','draw','retired_a','retired_b','suspended')),
  sets TEXT,
  notes TEXT,
  elo_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS attendance(
  match_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  attended INTEGER,
  has_substitute INTEGER NOT NULL DEFAULT 0,
  substitute_id INTEGER,
  updated_by INTEGER,
  updated_at TEXT,
  PRIMARY KEY(match_id, user_id)
);
CREATE TABLE IF NOT EXISTS sanctions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  match_id INTEGER,
  type TEXT NOT NULL CHECK(type IN ('points','block','expel')),
  points_deducted INTEGER NOT NULL DEFAULT 0,
  blocked_until TEXT,
  reason TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS admins(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_matches_starts ON matches(starts_at);
CREATE INDEX IF NOT EXISTS idx_players_user ON match_players(user_id);
CREATE INDEX IF NOT EXISTS idx_players_match ON match_players(match_id);
`);

function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}
function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}
function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, get, all, run, transaction, DB_PATH };
