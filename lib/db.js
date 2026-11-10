'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE COLLATE NOCASE, pass TEXT, salt TEXT, avatar TEXT,
  balance INTEGER, deposits INTEGER, last_bonus TEXT, streak INTEGER DEFAULT 0, bailouts INTEGER DEFAULT 0,
  is_admin INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS games(
  id TEXT PRIMARY KEY, start INTEGER, state TEXT, status_detail TEXT, period INTEGER, clock REAL,
  home_abbr TEXT, away_abbr TEXT, home_name TEXT, away_name TEXT, home_logo TEXT, away_logo TEXT,
  home_color TEXT, away_color TEXT, home_record TEXT, away_record TEXT, home_score INTEGER, away_score INTEGER,
  odds_json TEXT, props_json TEXT, box_json TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS bets(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT, stake INTEGER, status TEXT DEFAULT 'pending',
  payout INTEGER DEFAULT 0, boost INTEGER DEFAULT 0, odds REAL, placed_at INTEGER, settled_at INTEGER);
CREATE TABLE IF NOT EXISTS legs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, bet_id INTEGER, game_id TEXT, key TEXT, market TEXT, sel TEXT, line REAL,
  odds INTEGER, label TEXT, matchup TEXT, extra TEXT, status TEXT DEFAULT 'pending', live INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS legs_bet ON legs(bet_id);
CREATE INDEX IF NOT EXISTS legs_status ON legs(status);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, user_id INTEGER, kind TEXT, data TEXT);
CREATE TABLE IF NOT EXISTS reactions(event_id INTEGER, user_id INTEGER, emoji TEXT, PRIMARY KEY(event_id,user_id,emoji));
CREATE TABLE IF NOT EXISTS chat(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, user_id INTEGER, text TEXT);
CREATE TABLE IF NOT EXISTS duels(
  id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT, matchup TEXT, creator_id INTEGER, target_id INTEGER, opponent_id INTEGER,
  side TEXT, line REAL, stake INTEGER, status TEXT DEFAULT 'open', winner_id INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS price_hist(game_id TEXT, ts INTEGER, p REAL);
CREATE INDEX IF NOT EXISTS price_game ON price_hist(game_id, ts);
CREATE TABLE IF NOT EXISTS markets(
  id INTEGER PRIMARY KEY AUTOINCREMENT, creator_id INTEGER, question TEXT, detail TEXT, close_ts INTEGER,
  status TEXT DEFAULT 'open', outcome TEXT, b REAL, qy REAL DEFAULT 0, qn REAL DEFAULT 0, volume REAL DEFAULT 0,
  created_at INTEGER, resolved_at INTEGER);
CREATE TABLE IF NOT EXISTS positions(
  market_id INTEGER, user_id INTEGER, yes REAL DEFAULT 0, no REAL DEFAULT 0, spent REAL DEFAULT 0, PRIMARY KEY(market_id, user_id));
CREATE TABLE IF NOT EXISTS trades(
  id INTEGER PRIMARY KEY AUTOINCREMENT, market_id INTEGER, user_id INTEGER, side TEXT, kind TEXT, shares REAL, amount REAL, p_after REAL, ts INTEGER);
CREATE INDEX IF NOT EXISTS trades_m ON trades(market_id);
CREATE TABLE IF NOT EXISTS poker_tables(id TEXT PRIMARY KEY, json TEXT);
CREATE TABLE IF NOT EXISTS poker_ledger(user_id INTEGER, ts INTEGER, delta INTEGER, note TEXT);
CREATE INDEX IF NOT EXISTS poker_ledger_user ON poker_ledger(user_id);
CREATE TABLE IF NOT EXISTS net_hist(user_id INTEGER, ts INTEGER, net INTEGER);
CREATE INDEX IF NOT EXISTS net_user ON net_hist(user_id, ts);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=OFF;');
  db.exec(SCHEMA);
  db.tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  return db;
}
module.exports = { open };
