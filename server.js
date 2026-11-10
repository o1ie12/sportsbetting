'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open } = require('./lib/db');
const odds = require('./lib/odds');
const espn = require('./lib/espn');
const MK = require('./lib/market');
const { Table } = require('./lib/poker');
const pokerBot = require('./lib/pokerbot');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'courtside.db');
const START_BALANCE = 10000;
const MIN_STAKE = 10, MAX_STAKE = 100000, MAX_LIVE_STAKE = 2000, MAX_LEGS = 10, MAX_PAYOUT = 500000;
const CASHOUT_EDGE = 0.93;
const EMOJIS = ['Nice', 'Cooked', 'Fade', 'Sweat'];

const db = open(DB_FILE);
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const bad = (msg, extra) => new HttpError(400, msg, extra);

// ---------- settings / invite code ----------
function getSetting(k) { const r = db.prepare('SELECT v FROM settings WHERE k=?').get(k); return r && r.v; }
function setSetting(k, v) { db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v); }
let INVITE = process.env.LEAGUE_CODE || getSetting('invite');
if (!INVITE) INVITE = crypto.randomBytes(3).toString('hex').toUpperCase();
setSetting('invite', INVITE);

const etDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(ms);
const now = () => Date.now();

// ---------- games ----------
function rowToGame(r) {
  if (!r) return null;
  return { ...r, odds: JSON.parse(r.odds_json), props: JSON.parse(r.props_json || '[]'), box: r.box_json ? JSON.parse(r.box_json) : null };
}
const loadGame = (id) => rowToGame(db.prepare('SELECT * FROM games WHERE id=?').get(id));

function upsertGame(n) {
  const old = db.prepare('SELECT odds_json, props_json, box_json FROM games WHERE id=?').get(n.id);
  const prev = old && old.odds_json ? JSON.parse(old.odds_json) : null;
  let oddsObj;
  if (n.state === 'pre') oddsObj = n.odds || (prev && prev.src !== 'house' ? prev : null) || odds.houseOdds(n.home_record, n.away_record);
  else oddsObj = prev || n.odds || odds.houseOdds(n.home_record, n.away_record); // freeze pregame lines once the game starts
  const props = old && old.props_json && old.props_json !== '[]' ? old.props_json : JSON.stringify(n.props || []);
  const vals = [n.id, n.start, n.state, n.status_detail, n.period, n.clock, n.home_abbr, n.away_abbr, n.home_name, n.away_name,
    n.home_logo, n.away_logo, n.home_color, n.away_color, n.home_record, n.away_record, n.home_score, n.away_score,
    JSON.stringify(oddsObj), props, old ? old.box_json : null, now()];
  db.prepare(`INSERT OR REPLACE INTO games(id,start,state,status_detail,period,clock,home_abbr,away_abbr,home_name,away_name,home_logo,away_logo,
    home_color,away_color,home_record,away_record,home_score,away_score,odds_json,props_json,box_json,updated_at) VALUES(${vals.map(() => '?').join(',')})`).run(...vals);
  recordPrice(n.id);
}
// home win probability over time, for the price chart on each game
function recordPrice(id) {
  const g = loadGame(id);
  if (!g) return;
  const last = db.prepare('SELECT ts, p FROM price_hist WHERE game_id=? ORDER BY ts DESC LIMIT 1').get(id);
  let p;
  if (g.state === 'post') { p = g.home_score > g.away_score ? 1 : 0; if (last && last.p === p) return; }
  else if (g.state === 'pre' || g.state === 'in') p = odds.buildMarkets(g).win_prob_home;
  else return;
  if (!last || Math.abs(last.p - p) >= 0.004 || now() - last.ts >= 600000 || g.state === 'post') {
    db.prepare('INSERT INTO price_hist(game_id, ts, p) VALUES(?,?,?)').run(id, now(), p);
  }
}
function gameHistory(id) {
  const rows = db.prepare('SELECT ts, p FROM price_hist WHERE game_id=? ORDER BY ts').all(String(id));
  const step = Math.max(1, Math.ceil(rows.length / 300));
  const pts = rows.filter((_, i) => i % step === 0 || i === rows.length - 1).map((r) => [r.ts, Math.round(r.p * 1000) / 1000]);
  return { points: pts };
}

// ---------- accounts ----------
const hash = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
function newSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,created_at) VALUES(?,?,?)').run(token, userId, now());
  return token;
}
function addEvent(userId, kind, data) {
  return db.prepare('INSERT INTO events(ts,user_id,kind,data) VALUES(?,?,?,?)').run(now(), userId, kind, JSON.stringify(data)).lastInsertRowid;
}
const credit = (uid, amt) => db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(amt, uid);
function debit(uid, amt) {
  const r = db.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance>=?').run(amt, uid, amt);
  if (r.changes !== 1) throw bad('Not enough cash');
}
const AVATARS = ['#8c2f1b', '#1d5c8a', '#2f6b3c', '#6b3a7a', '#b07a12', '#37474f', '#a3365a', '#3d5a2a'];

function register({ username, pin, code, avatar }) {
  username = String(username || '').trim();
  if (!/^[A-Za-z0-9_]{2,16}$/.test(username)) throw bad('Username: 2-16 letters, numbers or _');
  if (String(pin || '').length < 4) throw bad('PIN must be at least 4 characters');
  if (String(code || '').trim().toUpperCase() !== INVITE.toUpperCase()) throw bad('Wrong invite code');
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw bad('That name is taken');
  const salt = crypto.randomBytes(8).toString('hex');
  const first = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
  const id = db.tx(() => {
    const r = db.prepare('INSERT INTO users(username,pass,salt,avatar,balance,deposits,is_admin,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(username, hash(pin, salt), salt, AVATARS.includes(avatar) ? avatar : AVATARS[0], START_BALANCE, START_BALANCE, first ? 1 : 0, now());
    addEvent(r.lastInsertRowid, 'join', {});
    db.prepare('INSERT INTO net_hist(user_id, ts, net) VALUES(?,?,?)').run(r.lastInsertRowid, now(), START_BALANCE);
    return r.lastInsertRowid;
  });
  return { token: newSession(id) };
}
function login({ username, pin }) {
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username || '').trim());
  if (!u) throw bad('Wrong name or PIN');
  const a = Buffer.from(hash(pin, u.salt)), b = Buffer.from(u.pass);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw bad('Wrong name or PIN');
  return { token: newSession(u.id) };
}
function authUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(token) || null;
}

function claimBonus(u) {
  u = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
  const today = etDate(now());
  if (u.last_bonus === today) throw bad('Already claimed today. Come back tomorrow!');
  const streak = u.last_bonus === etDate(now() - 86400000) ? Math.min(u.streak + 1, 7) : 1;
  const amt = 1000 + 250 * (streak - 1);
  db.tx(() => {
    db.prepare('UPDATE users SET last_bonus=?, streak=?, balance=balance+?, deposits=deposits+? WHERE id=?').run(today, streak, amt, amt, u.id);
    addEvent(u.id, 'bonus', { amount: amt, streak });
  });
  return { amount: amt, streak };
}
function bailout(u) {
  const fresh = db.prepare('SELECT balance FROM users WHERE id=?').get(u.id);
  const open = db.prepare("SELECT COUNT(*) c FROM bets WHERE user_id=? AND status='pending'").get(u.id).c;
  if (fresh.balance >= 100 || open > 0) throw bad('Bailouts are only for the truly broke (under 100 with no open bets)');
  db.tx(() => {
    db.prepare('UPDATE users SET balance=balance+2500, deposits=deposits+2500, bailouts=bailouts+1 WHERE id=?').run(u.id);
    addEvent(u.id, 'bailout', { amount: 2500 });
  });
  return { amount: 2500 };
}

// ---------- betting ----------
function legsConflict(sels) {
  const seen = new Map();
  for (const s of sels) {
    const k = `${s.game_id}|${s.family}`;
    if (seen.has(k)) return `Can't combine "${seen.get(k).label}" with "${s.label}" in one parlay`;
    seen.set(k, s);
  }
  return null;
}

function placeBet(u, body) {
  const type = body.type === 'parlay' ? 'parlay' : 'singles';
  const stake = Math.floor(Number(body.stake));
  const items = Array.isArray(body.legs) ? body.legs : [];
  if (!items.length) throw bad('Your slip is empty');
  if (!(stake >= MIN_STAKE)) throw bad(`Minimum stake is ${MIN_STAKE}`);
  if (stake > MAX_STAKE) throw bad(`Maximum stake is ${MAX_STAKE.toLocaleString()}`);
  if (items.length > MAX_LEGS) throw bad(`Max ${MAX_LEGS} legs`);
  if (type === 'parlay' && items.length < 2) throw bad('A parlay needs at least 2 legs');
  if (new Set(items.map((i) => i.key)).size !== items.length) throw bad('Duplicate selection on slip');

  const sels = [], changed = [], gcache = new Map();
  for (const it of items) {
    const gid = String(it.key).split('|')[0];
    if (!gcache.has(gid)) gcache.set(gid, loadGame(gid));
    const g = gcache.get(gid);
    if (!g) throw bad('Game not found');
    const s = odds.buildMarkets(g).index.get(it.key);
    if (!s) throw new HttpError(409, 'A line on your slip just moved or closed', { gone: [it.key] });
    if (s.odds !== it.odds) changed.push({ key: s.key, odds: s.odds });
    sels.push({ ...s, matchup: `${g.away_abbr} @ ${g.home_abbr}` });
  }
  if (changed.length) throw new HttpError(409, 'Odds changed, review your slip', { changed });
  if (type === 'parlay') { const c = legsConflict(sels); if (c) throw bad(c); }
  if (sels.some((s) => s.live) && stake > MAX_LIVE_STAKE) throw bad(`Live bets are capped at ${MAX_LIVE_STAKE.toLocaleString()}`);

  const total = type === 'parlay' ? stake : stake * sels.length;
  const ids = [];
  db.tx(() => {
    debit(u.id, total);
    const groups = type === 'parlay' ? [sels] : sels.map((s) => [s]);
    for (const grp of groups) {
      const dec = grp.reduce((a, s) => a * odds.dec(s.odds), 1);
      const boost = grp.length > 1 ? odds.boostFor(grp.length) : 0;
      const r = db.prepare('INSERT INTO bets(user_id,type,stake,boost,odds,placed_at) VALUES(?,?,?,?,?,?)').run(u.id, grp.length > 1 ? 'parlay' : 'single', stake, boost, dec, now());
      const betId = Number(r.lastInsertRowid);
      ids.push(betId);
      for (const s of grp) {
        db.prepare('INSERT INTO legs(bet_id,game_id,key,market,sel,line,odds,label,matchup,extra,live) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(betId, s.game_id, s.key, s.market, s.sel, s.line, s.odds, s.label, s.matchup, s.prop ? JSON.stringify({ athlete_id: s.prop.athlete_id, stat: s.prop.stat, name: s.prop.name }) : null, s.live ? 1 : 0);
      }
      addEvent(u.id, 'bet', {
        bet_id: betId, type: grp.length > 1 ? 'parlay' : 'single', stake, boost, dec,
        legs: grp.map((s) => ({ key: s.key, label: s.label, matchup: s.matchup, odds: s.odds, game_id: s.game_id, live: s.live })),
      });
    }
  });
  return { ids, balance: db.prepare('SELECT balance FROM users WHERE id=?').get(u.id).balance };
}

function payoutFor(bet, legs) {
  const live = legs.filter((l) => l.status !== 'void' && l.status !== 'push');
  const mult = live.reduce((a, l) => a * odds.dec(l.odds), 1);
  if (!live.length) return { status: 'push', payout: bet.stake };
  const boost = live.length > 1 ? odds.boostFor(live.length) : 0;
  const profit = bet.stake * (mult - 1) * (1 + boost / 100);
  return { status: 'won', payout: Math.min(MAX_PAYOUT, Math.round(bet.stake + profit)), boost };
}
function finishBet(bet, status, payout, legs) {
  db.tx(() => {
    const r = db.prepare("UPDATE bets SET status=?, payout=?, settled_at=? WHERE id=? AND status='pending'").run(status, payout, now(), bet.id);
    if (r.changes !== 1) return;
    if (payout > 0) credit(bet.user_id, payout);
    addEvent(bet.user_id, status === 'cashed' ? 'cashout' : 'result', {
      bet_id: bet.id, status, stake: bet.stake, payout, type: bet.type,
      legs: legs.map((l) => ({ label: l.label, status: l.status })),
    });
  });
}
function evalBet(betId) {
  const bet = db.prepare("SELECT * FROM bets WHERE id=? AND status='pending'").get(betId);
  if (!bet) return;
  const legs = db.prepare('SELECT * FROM legs WHERE bet_id=?').all(betId);
  if (legs.some((l) => l.status === 'lost')) return finishBet(bet, 'lost', 0, legs);
  if (legs.some((l) => l.status === 'pending')) return;
  const r = payoutFor(bet, legs);
  finishBet(bet, r.status, r.payout, legs);
}

function cashoutValue(bet, legs, gmap) {
  if (bet.status !== 'pending') return null;
  let mult = 1;
  for (const l of legs) {
    if (l.status === 'won') mult *= odds.dec(l.odds);
    else if (l.status === 'push' || l.status === 'void') continue;
    else if (l.status === 'pending') {
      const g = gmap.get(l.game_id);
      if (!g) return null;
      const p = odds.legProb(l, g);
      if (!p) return null;
      mult *= p.win * odds.dec(l.odds) + p.push;
    } else return null;
  }
  const v = Math.floor(bet.stake * mult * CASHOUT_EDGE);
  return v >= 1 ? v : null;
}
function cashOut(u, betId, expected) {
  const bet = db.prepare("SELECT * FROM bets WHERE id=? AND user_id=? AND status='pending'").get(betId, u.id);
  if (!bet) throw bad('Bet not found or already settled');
  const legs = db.prepare('SELECT * FROM legs WHERE bet_id=?').all(betId);
  const gmap = new Map(legs.map((l) => [l.game_id, loadGame(l.game_id)]));
  const v = cashoutValue(bet, legs, gmap);
  if (v == null) throw bad('Cash out is not available right now');
  if (expected != null && Math.abs(v - expected) > Math.max(2, expected * 0.02)) throw new HttpError(409, 'Cash out value changed', { value: v });
  finishBet(bet, 'cashed', v, legs);
  return { value: v };
}

// ---------- settlement ----------
function settleAll() {
  const legs = db.prepare("SELECT * FROM legs WHERE status='pending'").all();
  const touched = new Set(), gc = new Map();
  for (const l of legs) {
    if (!gc.has(l.game_id)) gc.set(l.game_id, loadGame(l.game_id));
    const g = gc.get(l.game_id);
    if (!g) continue;
    const res = odds.gradeLeg(l, g);
    if (res) { db.prepare('UPDATE legs SET status=? WHERE id=?').run(res, l.id); touched.add(l.bet_id); }
  }
  for (const id of touched) evalBet(id);
  settleDuels();
}

// ---------- duels ----------
function createDuel(u, { game_id, side, stake, target }) {
  stake = Math.floor(Number(stake));
  if (!(stake >= MIN_STAKE) || stake > 25000) throw bad('Duel stake: 10 to 25,000');
  if (!['home', 'away'].includes(side)) throw bad('Pick a side');
  const g = loadGame(String(game_id));
  if (!g || g.state !== 'pre' || g.start <= now()) throw bad('That game is not open for duels');
  let targetId = null;
  if (target) {
    const t = db.prepare('SELECT id FROM users WHERE username=?').get(String(target).trim());
    if (!t) throw bad('No such friend');
    if (t.id === u.id) throw bad("You can't duel yourself");
    targetId = t.id;
  }
  const hl = g.odds.spread.home_line;
  const line = side === 'home' ? hl : -hl;
  const id = db.tx(() => {
    debit(u.id, stake);
    const r = db.prepare('INSERT INTO duels(game_id,matchup,creator_id,target_id,side,line,stake,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(g.id, `${g.away_abbr} @ ${g.home_abbr}`, u.id, targetId, side, line, stake, now());
    addEvent(u.id, 'duel_new', { duel_id: Number(r.lastInsertRowid), matchup: `${g.away_abbr} @ ${g.home_abbr}`, pick: `${side === 'home' ? g.home_abbr : g.away_abbr} ${odds.fmtLine(line)}`, stake, target: target || null });
    return Number(r.lastInsertRowid);
  });
  return { id };
}
function acceptDuel(u, id) {
  const d = db.prepare("SELECT * FROM duels WHERE id=? AND status='open'").get(id);
  if (!d) throw bad('Duel no longer open');
  if (d.creator_id === u.id) throw bad("You can't accept your own duel");
  if (d.target_id && d.target_id !== u.id) throw bad('This duel was challenged to someone else');
  const g = loadGame(d.game_id);
  if (!g || g.state !== 'pre' || g.start <= now()) throw bad('Game already started');
  db.tx(() => {
    debit(u.id, d.stake);
    db.prepare("UPDATE duels SET status='active', opponent_id=? WHERE id=?").run(u.id, id);
    addEvent(u.id, 'duel_accept', { duel_id: id, matchup: d.matchup, stake: d.stake, vs: d.creator_id });
  });
}
function cancelDuel(u, id) {
  const d = db.prepare("SELECT * FROM duels WHERE id=? AND status='open' AND creator_id=?").get(id, u.id);
  if (!d) throw bad('Duel not found');
  db.tx(() => { db.prepare("UPDATE duels SET status='cancelled' WHERE id=?").run(id); credit(u.id, d.stake); });
}
function settleDuels() {
  for (const d of db.prepare("SELECT * FROM duels WHERE status IN ('open','active')").all()) {
    const g = loadGame(d.game_id);
    if (!g) continue;
    if (d.status === 'open' && (g.state !== 'pre' || g.start <= now())) {
      db.tx(() => { db.prepare("UPDATE duels SET status='cancelled' WHERE id=?").run(d.id); credit(d.creator_id, d.stake); });
      continue;
    }
    if (d.status !== 'active' || (g.state !== 'post' && g.state !== 'void')) continue;
    const mine = d.side === 'home' ? g.home_score : g.away_score, theirs = d.side === 'home' ? g.away_score : g.home_score;
    const adj = g.state === 'void' ? 0 : mine + d.line - theirs;
    db.tx(() => {
      if (adj === 0) {
        db.prepare("UPDATE duels SET status='push' WHERE id=?").run(d.id);
        credit(d.creator_id, d.stake); credit(d.opponent_id, d.stake);
        addEvent(d.creator_id, 'duel_result', { duel_id: d.id, matchup: d.matchup, push: true, stake: d.stake, vs: d.opponent_id });
      } else {
        const winner = adj > 0 ? d.creator_id : d.opponent_id, loser = adj > 0 ? d.opponent_id : d.creator_id;
        db.prepare("UPDATE duels SET status='done', winner_id=? WHERE id=?").run(winner, d.id);
        credit(winner, d.stake * 2);
        addEvent(winner, 'duel_result', { duel_id: d.id, matchup: d.matchup, stake: d.stake, vs: loser });
      }
    });
  }
}

// ---------- friend markets (Yes/No, priced by LMSR) ----------
const MAX_OPEN_MARKETS = 3, MAX_TRADE = 5000;
function createMarket(u, body) {
  const question = String(body.question || '').trim();
  const detail = String(body.detail || '').trim().slice(0, 300);
  const hours = Number(body.hours);
  if (question.length < 8 || question.length > 140) throw bad('Question should be 8 to 140 characters');
  if (!(hours >= 1 && hours <= 24 * 90)) throw bad('Pick a close time between 1 hour and 90 days');
  if (db.prepare("SELECT COUNT(*) c FROM markets WHERE creator_id=? AND status='open'").get(u.id).c >= MAX_OPEN_MARKETS) {
    throw bad(`You can have ${MAX_OPEN_MARKETS} open markets at a time. Resolve one first.`);
  }
  return db.tx(() => {
    const r = db.prepare('INSERT INTO markets(creator_id,question,detail,close_ts,b,created_at) VALUES(?,?,?,?,?,?)')
      .run(u.id, question, detail, now() + Math.round(hours * 3600000), MK.B, now());
    const id = Number(r.lastInsertRowid);
    addEvent(u.id, 'market_new', { market_id: id, question });
    return { id };
  });
}
function tradeMarket(u, id, body) {
  const m = db.prepare('SELECT * FROM markets WHERE id=?').get(id);
  if (!m) throw new HttpError(404, 'Market not found');
  if (m.status !== 'open') throw bad('This market is already resolved');
  if (m.close_ts <= now()) throw bad('Trading is closed. Waiting for the result.');
  const side = body.side === 'yes' || body.side === 'no' ? body.side : null;
  if (!side) throw bad('Pick Yes or No');
  const pos = db.prepare('SELECT * FROM positions WHERE market_id=? AND user_id=?').get(id, u.id) || { yes: 0, no: 0, spent: 0 };
  if (body.kind === 'sell') {
    const have = pos[side];
    let sh = Number(body.shares);
    if (!(sh > 0)) throw bad('Nothing to sell');
    if (sh > have + 1e-6) throw bad("You don't hold that many shares");
    if (sh > have - 1e-6) sh = have;
    const proceeds = Math.floor(MK.sellProceeds(m.qy, m.qn, m.b, side, sh));
    if (proceeds < 1) throw bad('That position is too small to sell');
    const qy = m.qy - (side === 'yes' ? sh : 0), qn = m.qn - (side === 'no' ? sh : 0);
    db.tx(() => {
      credit(u.id, proceeds);
      db.prepare('UPDATE markets SET qy=?, qn=?, volume=volume+? WHERE id=?').run(qy, qn, proceeds, id);
      db.prepare(`UPDATE positions SET ${side}=${side}-?, spent=spent-? WHERE market_id=? AND user_id=?`).run(sh, proceeds, id, u.id);
      db.prepare('INSERT INTO trades(market_id,user_id,side,kind,shares,amount,p_after,ts) VALUES(?,?,?,?,?,?,?,?)').run(id, u.id, side, 'sell', sh, proceeds, MK.priceYes(qy, qn, m.b), now());
    });
    return { amount: proceeds, balance: db.prepare('SELECT balance FROM users WHERE id=?').get(u.id).balance };
  }
  const spend = Math.floor(Number(body.amount));
  if (!(spend >= MIN_STAKE)) throw bad(`Minimum trade is ${MIN_STAKE}`);
  if (spend > MAX_TRADE) throw bad(`Maximum trade is ${MAX_TRADE.toLocaleString()}`);
  const sh = MK.buyShares(m.qy, m.qn, m.b, side, spend);
  if (body.min_shares && sh < Number(body.min_shares) * 0.97) throw new HttpError(409, 'The price moved. Review your order.', { shares: sh });
  const qy = m.qy + (side === 'yes' ? sh : 0), qn = m.qn + (side === 'no' ? sh : 0);
  const py = MK.priceYes(qy, qn, m.b);
  db.tx(() => {
    debit(u.id, spend);
    db.prepare('UPDATE markets SET qy=?, qn=?, volume=volume+? WHERE id=?').run(qy, qn, spend, id);
    db.prepare(`INSERT INTO positions(market_id,user_id,yes,no,spent) VALUES(?,?,?,?,?)
      ON CONFLICT(market_id,user_id) DO UPDATE SET yes=yes+excluded.yes, no=no+excluded.no, spent=spent+excluded.spent`)
      .run(id, u.id, side === 'yes' ? sh : 0, side === 'no' ? sh : 0, spend);
    db.prepare('INSERT INTO trades(market_id,user_id,side,kind,shares,amount,p_after,ts) VALUES(?,?,?,?,?,?,?,?)').run(id, u.id, side, 'buy', sh, spend, py, now());
    if (spend >= 200) addEvent(u.id, 'market_trade', { market_id: id, question: m.question, side, amount: spend, price: side === 'yes' ? py : 1 - py });
  });
  return { shares: sh, balance: db.prepare('SELECT balance FROM users WHERE id=?').get(u.id).balance };
}
function resolveMarket(u, id, outcome) {
  const m = db.prepare('SELECT * FROM markets WHERE id=?').get(id);
  if (!m || m.status !== 'open') throw bad('Market is already resolved');
  if (m.creator_id !== u.id && !u.is_admin) throw new HttpError(403, 'Only the creator or the commissioner can resolve this market');
  if (!['yes', 'no', 'void'].includes(outcome)) throw bad('Pick Yes, No or Void');
  db.tx(() => {
    for (const p of db.prepare('SELECT * FROM positions WHERE market_id=?').all(id)) {
      const pay = outcome === 'void' ? Math.max(0, Math.floor(p.spent)) : Math.round(p[outcome]);
      if (pay > 0) credit(p.user_id, pay);
    }
    db.prepare('UPDATE markets SET status=?, outcome=?, resolved_at=? WHERE id=?').run(outcome === 'void' ? 'void' : 'resolved', outcome, now(), id);
    addEvent(u.id, 'market_result', { market_id: id, question: m.question, outcome });
  });
}
function marketList(uid) {
  const rows = db.prepare(`SELECT m.*, u.username, u.avatar FROM markets m JOIN users u ON u.id=m.creator_id
    WHERE m.status='open' OR m.resolved_at > ? ORDER BY (m.status='open') DESC, m.id DESC LIMIT 60`).all(now() - 7 * 86400000);
  return rows.map((m) => {
    const p = MK.priceYes(m.qy, m.qn, m.b);
    const pos = db.prepare('SELECT yes, no, spent FROM positions WHERE market_id=? AND user_id=?').get(m.id, uid) || { yes: 0, no: 0, spent: 0 };
    const pts = db.prepare('SELECT ts, p_after FROM trades WHERE market_id=? ORDER BY id DESC LIMIT 100').all(m.id).reverse().map((t) => [t.ts, Math.round(t.p_after * 1000) / 1000]);
    const traders = db.prepare('SELECT COUNT(DISTINCT user_id) c FROM trades WHERE market_id=?').get(m.id).c;
    return { id: m.id, question: m.question, detail: m.detail, creator: { id: m.creator_id, username: m.username, avatar: m.avatar },
      close_ts: m.close_ts, status: m.status, outcome: m.outcome, b: m.b, qy: m.qy, qn: m.qn, p, volume: Math.round(m.volume), traders, created_at: m.created_at,
      mine: { yes: pos.yes, no: pos.no, spent: pos.spent, value: pos.yes * p + pos.no * (1 - p) }, pts: [[m.created_at, 0.5], ...pts] };
  });
}
function marketValue(uid) {
  return db.prepare("SELECT p.yes, p.no, m.qy, m.qn, m.b FROM positions p JOIN markets m ON m.id=p.market_id WHERE p.user_id=? AND m.status='open'").all(uid)
    .reduce((a, r) => { const p = MK.priceYes(r.qy, r.qn, r.b); return a + r.yes * p + r.no * (1 - p); }, 0);
}
function gameVolumes() {
  const out = {};
  for (const r of db.prepare(`WITH n AS (SELECT bet_id, COUNT(*) c FROM legs GROUP BY bet_id)
    SELECT l.game_id g, SUM(b.stake * 1.0 / n.c) v FROM legs l JOIN bets b ON b.id=l.bet_id JOIN n ON n.bet_id=b.id GROUP BY l.game_id`).all()) out[r.g] = r.v;
  for (const r of db.prepare("SELECT game_id g, SUM(stake*2) v FROM duels WHERE status IN ('active','done','push') GROUP BY game_id").all()) out[r.g] = (out[r.g] || 0) + r.v;
  return out;
}

// ---------- poker (no-limit hold'em with friends or bots) ----------
const STAKES = { '5/10': [5, 10], '25/50': [25, 50], '100/200': [100, 200] };
const tables = new Map();
for (const r of db.prepare('SELECT * FROM poker_tables').all()) tables.set(r.id, Table.fromJSON(JSON.parse(r.json)));
const saveTable = (t) => db.prepare('INSERT OR REPLACE INTO poker_tables(id, json) VALUES(?,?)').run(t.id, JSON.stringify(t));
function dropTable(t) { tables.delete(t.id); db.prepare('DELETE FROM poker_tables WHERE id=?').run(t.id); }
const ledger = (uid, delta, note) => db.prepare('INSERT INTO poker_ledger(user_id,ts,delta,note) VALUES(?,?,?,?)').run(uid, now(), delta, note);
const seatOf = (t, uid) => t.seats.findIndex((s) => s && s.uid === uid);
const userTable = (uid) => [...tables.values()].find((t) => seatOf(t, uid) >= 0) || null;
function pokerStack(uid) {
  let n = 0;
  for (const t of tables.values()) for (const s of t.seats) if (s && s.uid === uid) n += s.stack + (t.inHand() ? s.totalIn : 0);
  return n;
}
function pokerProfit(uid) { return db.prepare('SELECT COALESCE(SUM(delta),0) d FROM poker_ledger WHERE user_id=?').get(uid).d + pokerStack(uid); }
const humans = (t) => t.seats.filter((s) => s && s.uid != null);
function canStart(t) {
  const el = t.seats.filter((s) => s && s.stack > 0 && !s.sitOut && !s.leaving);
  return el.length >= 2 && el.some((s) => s.uid != null);
}
function reportHand(t) {
  if (t.stage !== 'showdown' || !t.result || t.reportedHand === t.handNo) return;
  t.reportedHand = t.handNo;
  for (const [k, net] of Object.entries(t.result.net)) {
    const s = t.seats[k];
    if (s && s.uid && net >= t.bb * 20) addEvent(s.uid, 'poker_win', { amount: net, hand: t.result.scores[k] || null, table: t.name });
  }
}
function pokerSettle(t) { reportHand(t); saveTable(t); }
function freePersona(t) {
  const used = new Set(t.seats.filter((s) => s && s.bot).map((s) => s.bot.name));
  return pokerBot.PERSONAS.find((p) => !used.has(p.name)) || null;
}
function addBot(t, buyin) {
  const idx = t.freeSeat(), p = freePersona(t);
  if (idx < 0 || !p) throw bad('No free seat for a bot');
  t.sit(idx, { bot: p, name: p.name, avatar: p.avatar }, buyin);
}
function sitHuman(u, t, buyin, want) {
  buyin = Math.floor(Number(buyin));
  if (userTable(u.id)) throw bad('You are already seated at a table. Leave it first.');
  if (!(buyin >= t.minBuy && buyin <= t.maxBuy)) throw bad(`Buy-in is $${t.minBuy.toLocaleString()} to $${t.maxBuy.toLocaleString()}`);
  const idx = want != null && t.seats[want] === null ? want : t.freeSeat();
  if (idx < 0) throw bad('This table is full');
  db.tx(() => { debit(u.id, buyin); ledger(u.id, -buyin, 'buy-in'); t.sit(idx, { uid: u.id, name: u.username, avatar: u.avatar }, buyin); });
}
function startIfReady(t) { if (t.stage === 'waiting' && canStart(t)) t.startHand(now()); }
function createTable(u, body) {
  const st = STAKES[body.stakes];
  if (!st) throw bad('Pick the stakes');
  const nb = Math.max(0, Math.min(5, Math.floor(Number(body.bots) || 0)));
  const t = new Table({ id: crypto.randomBytes(4).toString('hex'), name: `${u.username}'s table`, sb: st[0], bb: st[1], creator: u.id });
  const buyin = Math.floor(Number(body.buyin)) || t.bb * 50;
  sitHuman(u, t, buyin);
  t.botBuy = Math.min(t.maxBuy, Math.max(t.minBuy, buyin));
  for (let k = 0; k < nb; k++) addBot(t, t.botBuy);
  tables.set(t.id, t);
  startIfReady(t); pokerSettle(t);
  return { id: t.id };
}
function pokerLobby(u) {
  const mine = userTable(u.id);
  return {
    stakes: Object.keys(STAKES), mine: mine ? mine.id : null, profit: pokerProfit(u.id),
    tables: [...tables.values()].map((t) => ({ id: t.id, name: t.name, sb: t.sb, bb: t.bb, minBuy: t.minBuy, maxBuy: t.maxBuy, stage: t.stage,
      people: humans(t).map((s) => s.name), bots: t.seats.filter((s) => s && s.bot).length, open: t.seats.filter((s) => !s).length, mine: !!mine && mine.id === t.id })),
  };
}
function getTable(id) { const t = tables.get(String(id)); if (!t) throw new HttpError(404, 'That table is closed'); return t; }
function pokerView(u, id) { const t = getTable(id); return { ...t.view(u.id, now()), profit: pokerProfit(u.id) }; }
function pokerAction(u, id, body) {
  const t = getTable(id), i = seatOf(t, u.id);
  if (i < 0) throw bad('You are not seated at this table');
  const s = t.seats[i];
  if (body.type === 'back') { s.sitOut = false; s.timeouts = 0; startIfReady(t); pokerSettle(t); return { ok: true }; }
  try { t.act(i, body.type, body.amount, now()); }
  catch (e) { throw bad(e.message); }
  s.timeouts = 0;
  pokerSettle(t);
  return { ok: true };
}
function pokerLeave(u, id) {
  const t = getTable(id), i = seatOf(t, u.id);
  if (i < 0) throw bad('You are not seated at this table');
  const s = t.seats[i], n = now();
  db.tx(() => {
    const mid = t.inHand() && s.hole.length > 0;
    if (mid && !s.folded) t.forceFold(i, n);
    if (s.stack > 0) { credit(u.id, s.stack); ledger(u.id, s.stack, 'cash out'); }
    s.stack = 0; s.uid = null; s.leaving = true;
    if (!mid) t.seats[i] = null;
  });
  if (!humans(t).length) dropTable(t); else pokerSettle(t);
  return { ok: true };
}
function pokerRebuy(u, id, amount) {
  const t = getTable(id), i = seatOf(t, u.id);
  if (i < 0) throw bad('You are not seated at this table');
  const s = t.seats[i];
  amount = Math.floor(Number(amount));
  if (t.inHand() && s.hole.length) throw bad('Wait for the hand to finish');
  if (!(amount > 0) || s.stack + amount > t.maxBuy) throw bad(`Your stack can be at most $${t.maxBuy.toLocaleString()}`);
  db.tx(() => { debit(u.id, amount); ledger(u.id, -amount, 'rebuy'); s.stack += amount; });
  startIfReady(t); pokerSettle(t);
  return { ok: true };
}
function pokerBots(u, id, body) {
  const t = getTable(id);
  if (seatOf(t, u.id) < 0) throw bad('Sit down first');
  if (body.remove != null) {
    const s = t.seats[Number(body.remove)];
    if (!s || !s.bot) throw bad('No bot in that seat');
    if (t.inHand() && s.hole.length) throw bad('Wait for the hand to finish');
    t.seats[Number(body.remove)] = null;
  } else addBot(t, t.botBuy || Math.round((t.minBuy + t.maxBuy) / 2));
  startIfReady(t); pokerSettle(t);
  return { ok: true };
}
function pokerCleanup(t) {
  t.seats.forEach((s, i) => {
    if (!s) return;
    if (s.leaving && s.uid == null && !s.bot) t.seats[i] = null;
    else if (s.uid != null && s.stack <= 0) t.seats[i] = null; // busted
  });
}
function pokerTick() {
  const n = now();
  for (const t of [...tables.values()]) {
    let changed = false;
    try {
      if (t.stage === 'showdown' && n >= t.nextHandAt) {
        pokerCleanup(t); changed = true;
        if (!humans(t).length) { dropTable(t); continue; }
        t.stage = 'waiting';
        if (canStart(t)) t.startHand(n);
      } else if (t.stage === 'waiting') {
        if (canStart(t)) { t.startHand(n); changed = true; }
      } else if (t.inHand() && t.toAct >= 0) {
        const s = t.seats[t.toAct];
        if (s && s.bot && n >= t.botAt) {
          const toCall = t.currentBet > s.bet;
          let d; try { d = pokerBot.decide(t, t.toAct, t.rng); } catch (e) { d = { type: toCall ? 'call' : 'check' }; }
          try { t.act(t.toAct, d.type, d.amount, n); } catch (e) { t.act(t.toAct, toCall ? 'call' : 'check', 0, n); }
          changed = true;
        } else if (s && !s.bot && t.deadline && n >= t.deadline) {
          const i = t.toAct;
          t.act(i, t.currentBet > s.bet ? 'fold' : 'check', 0, n);
          s.timeouts = (s.timeouts || 0) + 1; if (s.timeouts >= 2) s.sitOut = true;
          changed = true;
        }
      }
    } catch (e) { console.error('poker tick', e); }
    if (changed) pokerSettle(t);
  }
}

// ---------- sync loop ----------
let lastSync = 0, syncing = false, lastSyncOk = null, lastSyncErr = null;
const yyyymmdd = (ms) => etDate(ms).replace(/-/g, '');
async function syncGames() {
  if (syncing) return;
  syncing = true;
  try {
    const dates = new Set();
    for (let i = -1; i <= 3; i++) dates.add(yyyymmdd(now() + i * 86400000));
    for (const r of db.prepare("SELECT DISTINCT g.start FROM legs l JOIN games g ON g.id=l.game_id WHERE l.status='pending' AND g.state!='pre'").all()) dates.add(yyyymmdd(r.start));
    let okAny = false;
    for (const d of dates) {
      try { for (const n of await espn.fetchBoard(d)) upsertGame(n); okAny = true; }
      catch (e) { lastSyncErr = `${d}: ${e.message}`; }
    }
    // box scores for player-prop grading
    const need = db.prepare(`SELECT DISTINCT g.id FROM legs l JOIN games g ON g.id=l.game_id
      WHERE l.status='pending' AND l.market='prop' AND g.state='post' AND g.box_json IS NULL`).all();
    for (const r of need) {
      try { db.prepare('UPDATE games SET box_json=? WHERE id=?').run(JSON.stringify(await espn.fetchBox(r.id)), r.id); }
      catch (e) { lastSyncErr = `box ${r.id}: ${e.message}`; }
    }
    if (okAny) { lastSyncOk = now(); lastSyncErr = null; }
    settleAll();
  } catch (e) { lastSyncErr = e.message; console.error('sync error', e); }
  finally { syncing = false; lastSync = now(); }
}
// net worth snapshots every few minutes, for the portfolio and leaderboard charts
let lastSnap = 0;
function snapshotNet() {
  lastSnap = now();
  const ins = db.prepare('INSERT INTO net_hist(user_id, ts, net) VALUES(?,?,?)');
  for (const u of leaderboard()) ins.run(u.id, lastSnap, u.net);
}
function netHistory() {
  return {
    users: db.prepare('SELECT id, username, avatar FROM users').all().map((u) => {
      const rows = db.prepare('SELECT ts, net FROM net_hist WHERE user_id=? ORDER BY ts').all(u.id);
      const step = Math.max(1, Math.ceil(rows.length / 250));
      return { ...u, pts: rows.filter((_, i) => i % step === 0 || i === rows.length - 1).map((r) => [r.ts, r.net]) };
    }),
  };
}
function syncLoop() {
  if (now() - lastSnap >= 300000) snapshotNet();
  const anyLive = db.prepare("SELECT COUNT(*) c FROM games WHERE state='in' OR (state='pre' AND start BETWEEN ? AND ?)").get(now() - 60000, now() + 15 * 60000).c > 0;
  if (now() - lastSync >= (anyLive ? 20000 : 90000)) syncGames();
}

// ---------- read models ----------
function publicGame(g) {
  const mk = odds.buildMarkets(g);
  const strip = (s) => (s ? { key: s.key, odds: s.odds, line: s.line, label: s.label, market: s.market, sel: s.sel, live: s.live, family: s.family, game_id: s.game_id, band: s.band } : null);
  const groups = mk.groups.map((gr) => {
    if (gr.kind === 'main') return { ...gr, spread: gr.spread.map(strip), total: gr.total.map(strip), ml: gr.ml.map(strip) };
    if (gr.kind === 'pairs') return { ...gr, rows: gr.rows.map((r) => ({ left: strip(r.left), right: strip(r.right) })) };
    if (gr.kind === 'grid') return { ...gr, sels: gr.sels.map(strip) };
    return { ...gr, rows: gr.rows.map((r) => ({ p: r.p, over: strip(r.over), under: strip(r.under) })) };
  });
  return {
    id: g.id, start: g.start, state: g.state, status_detail: g.status_detail, period: g.period, clock: g.clock,
    home: { abbr: g.home_abbr, name: g.home_name, logo: g.home_logo, color: g.home_color, record: g.home_record, score: g.home_score },
    away: { abbr: g.away_abbr, name: g.away_name, logo: g.away_logo, color: g.away_color, record: g.away_record, score: g.away_score },
    lines_src: g.odds.src, spread: g.odds.spread.home_line, total: g.odds.total.line,
    bettable: mk.bettable, live: mk.live, win_prob_home: mk.win_prob_home, groups,
  };
}

function myBets(uid) {
  const bets = db.prepare('SELECT * FROM bets WHERE user_id=? ORDER BY id DESC LIMIT 100').all(uid);
  const gmap = new Map();
  return bets.map((b) => {
    const legs = db.prepare('SELECT * FROM legs WHERE bet_id=?').all(b.id);
    for (const l of legs) if (!gmap.has(l.game_id)) gmap.set(l.game_id, loadGame(l.game_id));
    const gs = legs.map((l) => gmap.get(l.game_id)).filter(Boolean);
    const potential = b.status === 'pending' ? payoutFor({ stake: b.stake }, legs.map((l) => ({ ...l, status: l.status === 'pending' ? 'won' : l.status }))).payout : null;
    return {
      ...b, potential,
      cashout: cashoutValue(b, legs, gmap),
      legs: legs.map((l) => {
        const g = gmap.get(l.game_id);
        return { id: l.id, label: l.label, matchup: l.matchup, odds: l.odds, status: l.status, live: !!l.live, market: l.market,
          game: g ? { state: g.state, status_detail: g.status_detail, hs: g.home_score, as: g.away_score, h: g.home_abbr, a: g.away_abbr } : null,
          win_prob: g && l.status === 'pending' ? (odds.legProb(l, g) || {}).win ?? null : null };
      }),
      _g: gs.length,
    };
  });
}

function leaderboard() {
  const users = db.prepare('SELECT * FROM users').all();
  const weekAgo = now() - 7 * 86400000;
  return users.map((u) => {
    const pend = db.prepare("SELECT COALESCE(SUM(stake),0) s FROM bets WHERE user_id=? AND status='pending'").get(u.id).s;
    const duelEsc = db.prepare("SELECT COALESCE(SUM(CASE WHEN status='open' AND creator_id=? THEN stake WHEN status='active' THEN stake ELSE 0 END),0) s FROM duels WHERE (creator_id=? OR opponent_id=?) AND status IN ('open','active')").get(u.id, u.id, u.id).s;
    const settled = db.prepare("SELECT * FROM bets WHERE user_id=? AND status!='pending' ORDER BY settled_at DESC").all(u.id);
    const wins = settled.filter((b) => b.status === 'won').length, losses = settled.filter((b) => b.status === 'lost').length;
    const week = settled.filter((b) => b.settled_at >= weekAgo).reduce((a, b) => a + (b.payout - b.stake), 0);
    const streak = (() => { let n = 0; for (const b of settled) { if (b.status === 'won') n++; else if (b.status === 'lost') break; } return n; })();
    const bigParlay = db.prepare("SELECT 1 FROM bets b WHERE user_id=? AND status='won' AND type='parlay' AND (SELECT COUNT(*) FROM legs WHERE bet_id=b.id)>=4").get(u.id);
    const longshot = settled.some((b) => b.status === 'won' && b.odds >= 6);
    const whale = db.prepare('SELECT 1 FROM bets WHERE user_id=? AND stake>=5000').get(u.id);
    const duelWins = db.prepare("SELECT COUNT(*) c FROM duels WHERE winner_id=?").get(u.id).c;
    const badges = [];
    if (wins >= 10) badges.push(['Sharp', '10+ wins']);
    if (streak >= 5) badges.push(['Hot', `${streak} straight wins`]);
    if (bigParlay) badges.push(['Parlay', 'Won a 4+ leg parlay']);
    if (longshot) badges.push(['Longshot', 'Won a +500 or better bet']);
    if (whale) badges.push(['Big stakes', 'Placed a 5,000+ bet']);
    if (duelWins >= 3) badges.push(['Duelist', 'Won 3+ duels']);
    if (u.bailouts) badges.push(['Bailed out', `Bailed out ${u.bailouts}x`]);
    const net = Math.round(u.balance + pend + duelEsc + marketValue(u.id) + pokerStack(u.id));
    return { id: u.id, username: u.username, avatar: u.avatar, balance: u.balance, net, profit: net - u.deposits, roi: u.deposits ? (net - u.deposits) / u.deposits : 0, wins, losses, week, streak, badges, pending: pend };
  }).sort((a, b) => b.net - a.net);
}

function feed() {
  const rows = db.prepare(`SELECT e.*, u.username, u.avatar FROM events e JOIN users u ON u.id=e.user_id ORDER BY e.id DESC LIMIT 60`).all();
  const rx = db.prepare('SELECT event_id, emoji, COUNT(*) c, GROUP_CONCAT(user_id) users FROM reactions WHERE event_id>=? GROUP BY event_id, emoji');
  const minId = rows.length ? rows[rows.length - 1].id : 0;
  const byEvent = {};
  for (const r of rx.all(minId)) (byEvent[r.event_id] ||= []).push({ emoji: r.emoji, c: r.c, users: r.users.split(',').map(Number) });
  const names = new Map(db.prepare('SELECT id, username FROM users').all().map((u) => [u.id, u.username]));
  return rows.map((r) => {
    const d = JSON.parse(r.data);
    if (d.vs) d.vs_name = names.get(d.vs);
    return { id: r.id, ts: r.ts, kind: r.kind, user: r.username, avatar: r.avatar, uid: r.user_id, data: d, reactions: byEvent[r.id] || [] };
  });
}
function chatLog() {
  return db.prepare('SELECT c.id, c.ts, c.text, u.username, u.avatar, u.id uid FROM chat c JOIN users u ON u.id=c.user_id ORDER BY c.id DESC LIMIT 80').all().reverse();
}
function duelList(uid) {
  const names = new Map(db.prepare('SELECT id, username, avatar FROM users').all().map((u) => [u.id, u]));
  return db.prepare("SELECT * FROM duels WHERE status IN ('open','active') OR creator_id=? OR opponent_id=? ORDER BY id DESC LIMIT 60").all(uid, uid).map((d) => {
    const g = loadGame(d.game_id);
    const cu = names.get(d.creator_id), ou = d.opponent_id && names.get(d.opponent_id), tu = d.target_id && names.get(d.target_id);
    const pickAbbr = g ? (d.side === 'home' ? g.home_abbr : g.away_abbr) : '?';
    const oppAbbr = g ? (d.side === 'home' ? g.away_abbr : g.home_abbr) : '?';
    return { ...d, creator: cu, opponent: ou || null, target: tu || null, pick: `${pickAbbr} ${odds.fmtLine(d.line)}`, against: `${oppAbbr} ${odds.fmtLine(-d.line)}`,
      game: g ? { state: g.state, hs: g.home_score, as: g.away_score, h: g.home_abbr, a: g.away_abbr, status_detail: g.status_detail } : null };
  });
}

function meView(u) {
  const f = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
  const today = etDate(now());
  return { id: f.id, username: f.username, avatar: f.avatar, balance: f.balance, streak: f.streak, bonus_ready: f.last_bonus !== today,
    next_bonus: 1000 + 250 * ((f.last_bonus === etDate(now() - 86400000) ? Math.min(f.streak + 1, 7) : 1) - 1),
    can_bailout: f.balance < 100 && db.prepare("SELECT COUNT(*) c FROM bets WHERE user_id=? AND status='pending'").get(u.id).c === 0, is_admin: !!f.is_admin };
}

function stateFor(u) {
  const since = now() - 30 * 3600000;
  const vols = gameVolumes();
  const games = db.prepare('SELECT * FROM games WHERE start > ? ORDER BY start ASC').all(since).map(rowToGame).map((r) => ({ ...publicGame(r), volume: Math.round(vols[r.id] || 0) }));
  return {
    me: meView(u), games, markets: marketList(u.id), bets: myBets(u.id).map(({ _g, ...b }) => b), board: leaderboard(), feed: feed(), chat: chatLog(), duels: duelList(u.id),
    invite: INVITE, sync: { ok: lastSyncOk, err: lastSyncErr }, now: now(),
    config: { min: MIN_STAKE, max_live: MAX_LIVE_STAKE, max_legs: MAX_LEGS, avatars: AVATARS, emojis: EMOJIS, market_max: MAX_TRADE },
  };
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 100000) { reject(bad('Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(bad('Bad JSON')); } });
  });
}

async function api(req, res, url) {
  const m = req.method, p = url.pathname;
  const body = m === 'POST' ? await readBody(req) : {};
  if (m === 'POST' && p === '/api/register') return send(res, 200, register(body));
  if (m === 'POST' && p === '/api/login') return send(res, 200, login(body));
  const u = authUser(req);
  if (!u) throw new HttpError(401, 'Please log in');
  if (m === 'POST' && p === '/api/logout') { db.prepare('DELETE FROM sessions WHERE token=?').run((req.headers.authorization || '').slice(7)); return send(res, 200, { ok: true }); }
  if (m === 'GET' && p === '/api/state') return send(res, 200, stateFor(u));
  if (m === 'POST' && p === '/api/bets') return send(res, 200, placeBet(u, body));
  let mm;
  if (m === 'POST' && (mm = p.match(/^\/api\/bets\/(\d+)\/cashout$/))) return send(res, 200, cashOut(u, Number(mm[1]), body.expected));
  if (m === 'POST' && p === '/api/bonus') return send(res, 200, claimBonus(u));
  if (m === 'POST' && p === '/api/bailout') return send(res, 200, bailout(u));
  if (m === 'POST' && p === '/api/chat') {
    const text = String(body.text || '').trim().slice(0, 280);
    if (!text) throw bad('Say something');
    db.prepare('INSERT INTO chat(ts,user_id,text) VALUES(?,?,?)').run(now(), u.id, text);
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/react') {
    if (!EMOJIS.includes(body.emoji)) throw bad('Bad emoji');
    const ex = db.prepare('SELECT 1 FROM reactions WHERE event_id=? AND user_id=? AND emoji=?').get(body.event_id, u.id, body.emoji);
    if (ex) db.prepare('DELETE FROM reactions WHERE event_id=? AND user_id=? AND emoji=?').run(body.event_id, u.id, body.emoji);
    else db.prepare('INSERT INTO reactions VALUES(?,?,?)').run(body.event_id, u.id, body.emoji);
    return send(res, 200, { ok: true });
  }
  if (m === 'GET' && p === '/api/poker') return send(res, 200, pokerLobby(u));
  if (m === 'POST' && p === '/api/poker/tables') return send(res, 200, createTable(u, body));
  if (m === 'GET' && (mm = p.match(/^\/api\/poker\/tables\/(\w+)$/))) return send(res, 200, pokerView(u, mm[1]));
  if (m === 'POST' && (mm = p.match(/^\/api\/poker\/tables\/(\w+)\/(sit|leave|action|bots|rebuy)$/))) {
    const t = getTable(mm[1]);
    if (mm[2] === 'sit') { sitHuman(u, t, body.buyin, body.seat); startIfReady(t); pokerSettle(t); return send(res, 200, { ok: true }); }
    if (mm[2] === 'leave') return send(res, 200, pokerLeave(u, mm[1]));
    if (mm[2] === 'action') return send(res, 200, pokerAction(u, mm[1], body));
    if (mm[2] === 'bots') return send(res, 200, pokerBots(u, mm[1], body));
    return send(res, 200, pokerRebuy(u, mm[1], body.amount));
  }
  if (m === 'GET' && p === '/api/networth') return send(res, 200, netHistory());
  if (m === 'GET' && (mm = p.match(/^\/api\/games\/([\w-]+)\/history$/))) return send(res, 200, gameHistory(mm[1]));
  if (m === 'POST' && p === '/api/markets') return send(res, 200, createMarket(u, body));
  if (m === 'POST' && (mm = p.match(/^\/api\/markets\/(\d+)\/(trade|resolve)$/))) {
    if (mm[2] === 'trade') return send(res, 200, tradeMarket(u, Number(mm[1]), body));
    resolveMarket(u, Number(mm[1]), body.outcome); return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/duels') return send(res, 200, createDuel(u, body));
  if (m === 'POST' && (mm = p.match(/^\/api\/duels\/(\d+)\/(accept|cancel)$/))) {
    if (mm[2] === 'accept') acceptDuel(u, Number(mm[1])); else cancelDuel(u, Number(mm[1]));
    return send(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Not found');
}

function serveStatic(req, res, url) {
  let f = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.normalize(path.join(__dirname, 'public', f));
  if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    const nets = Object.values(require('os').networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal);
    console.log(`\n  COURTSIDE is live`);
    console.log(`  Local:    http://localhost:${PORT}`);
    for (const n of nets) console.log(`  Network:  http://${n.address}:${PORT}   (friends on your Wi-Fi)`);
    console.log(`  Invite code: ${INVITE}\n`);
  });
  syncGames();
  setInterval(syncLoop, 10000);
  setInterval(pokerTick, 600);
}
module.exports = { createTable, pokerLobby, pokerView, pokerAction, pokerLeave, pokerRebuy, pokerBots, pokerTick, pokerProfit, sitHuman, tables, snapshotNet, netHistory, createMarket, tradeMarket, resolveMarket, marketList, gameHistory, recordPrice, db, server, placeBet, settleAll, upsertGame, loadGame, register, login, cashOut, createDuel, acceptDuel, claimBonus, bailout, stateFor, INVITE: () => INVITE };
