'use strict';
// End-to-end logic test against a throwaway DB (no network).
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'courtside-')), 't.db');
process.env.DB_FILE = tmp;
const S = require('../server');
const odds = require('../lib/odds');

const game = (id, o = {}) => ({
  id, start: Date.now() + 3600e3, state: 'pre', status_detail: '', period: 0, clock: 0,
  home_abbr: 'HOM' + id, away_abbr: 'AWY' + id, home_name: 'Home', away_name: 'Away', home_logo: '', away_logo: '',
  home_color: '#111', away_color: '#222', home_record: '5-2', away_record: '3-4', home_score: 0, away_score: 0,
  odds: { src: 'test', ml: { home: -150, away: 130 }, spread: { home_line: -3.5, home_odds: -110, away_odds: -110 }, total: { line: 220.5, over: -110, under: -110 } },
  props: [{ id: '9:PTS', athlete_id: '9', name: 'J. Tester', team: 'HOM' + id, stat: 'PTS', avg: 24.3, line: 24.5, headshot: null }],
  ...o,
});
const sel = (gid, pred) => {
  const g = S.loadGame(gid); const mk = odds.buildMarkets(g);
  return [...mk.index.values()].find(pred);
};
const bal = (u) => S.db.prepare('SELECT balance FROM users WHERE id=?').get(u).balance;
const userId = (n) => S.db.prepare('SELECT id FROM users WHERE username=?').get(n).id;

S.register({ username: 'alice', pin: '1234', code: S.INVITE() });
S.register({ username: 'bob', pin: '1234', code: S.INVITE() });
assert.throws(() => S.register({ username: 'x', pin: '1234', code: 'nope' }));
const A = S.db.prepare("SELECT * FROM users WHERE username='alice'").get();
const B = S.db.prepare("SELECT * FROM users WHERE username='bob'").get();

S.upsertGame(game('1')); S.upsertGame(game('2'));
let mk = odds.buildMarkets(S.loadGame('1'));
console.log('groups:', mk.groups.map((g) => g.id).join(','));
assert(mk.groups.find((g) => g.id === 'props'), 'props market exists');
assert(mk.groups.find((g) => g.id === 'margin'), 'margin market exists');

// single bet: home -3.5 (home wins by 4+ covers)
const home1 = sel('1', (s) => s.market === 'spread' && s.sel === 'home' && !s.key.endsWith('|alt'));
const over2 = sel('2', (s) => s.market === 'total' && s.sel === 'over' && !s.key.endsWith('|alt'));
const prop1 = sel('1', (s) => s.market === 'prop' && s.sel === 'over');
const ml2 = sel('2', (s) => s.market === 'ml' && s.sel === 'away');

// stale odds are rejected
assert.throws(() => S.placeBet(A, { type: 'singles', stake: 100, legs: [{ key: home1.key, odds: -120 }] }), /Odds changed/);
// conflicting same-family legs rejected
assert.throws(() => S.placeBet(A, { type: 'parlay', stake: 100, legs: [{ key: home1.key, odds: home1.odds }, { key: sel('1', (s) => s.market === 'ml' && s.sel === 'home').key, odds: -150 }] }), /Can't combine/);

const r1 = S.placeBet(A, { type: 'singles', stake: 500, legs: [{ key: home1.key, odds: home1.odds }] });
assert.strictEqual(bal(A.id), 9500);
const r2 = S.placeBet(A, { type: 'parlay', stake: 1000, legs: [home1, over2, prop1].map((s) => ({ key: s.key, odds: s.odds })) });
assert.strictEqual(bal(A.id), 8500);
const parlay = S.db.prepare('SELECT * FROM bets WHERE id=?').get(r2.ids[0]);
assert.strictEqual(parlay.boost, 10, '3-leg boost');
const r3 = S.placeBet(B, { type: 'singles', stake: 300, legs: [{ key: ml2.key, odds: ml2.odds }] });

// cash out on a pre-game single returns slightly less than stake
const co = S.cashOut(B, r3.ids[0]);
console.log('cashout value on 300 stake:', co.value);
assert(co.value > 200 && co.value < 300);
assert.strictEqual(bal(B.id), 9700 + co.value);

// duels
const d = S.createDuel(B, { game_id: '1', side: 'away', stake: 1000 });
assert.strictEqual(bal(B.id), 9700 + co.value - 1000);
S.acceptDuel(A, d.id);
assert.strictEqual(bal(A.id), 7500);

// game 1 finishes: home wins 110-100 (covers -3.5), J. Tester scores 30; game 2 finishes 100-90 (under)
S.upsertGame(game('1', { state: 'post', home_score: 110, away_score: 100 }));
S.upsertGame(game('2', { state: 'post', home_score: 100, away_score: 90 }));
S.db.prepare('UPDATE games SET box_json=? WHERE id=?').run(JSON.stringify({ 9: { dnp: false, PTS: 30, REB: 5, AST: 5 } }), '1');
S.settleAll();

const single = S.db.prepare('SELECT * FROM bets WHERE id=?').get(r1.ids[0]);
assert.strictEqual(single.status, 'won');
assert.strictEqual(single.payout, Math.round(500 * odds.dec(-110)));
const lost = S.db.prepare('SELECT * FROM bets WHERE id=?').get(r2.ids[0]); // over 220.5 lost (190 total)
assert.strictEqual(lost.status, 'lost');
// duel: bob took away +3.5, lost by 10 -> alice (home -3.5) wins
const duel = S.db.prepare('SELECT * FROM duels WHERE id=?').get(d.id);
assert.strictEqual(duel.status, 'done'); assert.strictEqual(duel.winner_id, A.id);
assert.strictEqual(bal(A.id), 7500 + single.payout + 2000);

// bonus + bailout
const b1 = S.claimBonus(B); assert.strictEqual(b1.amount, 1000);
assert.throws(() => S.claimBonus(B), /Already/);

// live model sanity: team up 20 late should be a heavy favorite
const g = S.loadGame('1'); g.state = 'in'; g.period = 4; g.clock = 300; g.home_score = 100; g.away_score = 80;
const ph = odds.pHomeWin(odds.model(g).mu, odds.model(g).sd);
console.log('home win prob up 20 with 5:00 left:', ph.toFixed(3));
assert(ph > 0.95);
const liveMk = odds.buildMarkets(g);
assert(liveMk.live && !liveMk.bettable, 'live betting closes late in Q4');
g.period = 3; g.clock = 360; g.home_score = 70; g.away_score = 60;
const mid = odds.buildMarkets(g);
assert(mid.live && mid.bettable, 'live betting open mid Q3');
const ml = mid.groups[0].ml; console.log('live ML up 10 mid-Q3:', ml.map((s) => s && s.odds).join(' / '));
assert(mid.groups[0].ml[1].odds < -150, 'leader is a clear favorite');

// ---- friend markets (LMSR) ----
const MKT = require('../lib/market');
const sh0 = MKT.buyShares(0, 0, MKT.B, 'yes', 300);
assert(Math.abs(sh0 - 447) < 3, 'LMSR: $300 at 50c buys about 447 shares, got ' + sh0);
const back = MKT.sellProceeds(sh0, 0, MKT.B, 'yes', sh0);
assert(Math.abs(back - 300) < 0.01, 'selling everything straight back returns the spend');
assert(Math.abs(MKT.priceYes(0, 0) - 0.5) < 1e-9);
const balA0 = bal(A.id), balB0 = bal(B.id);
assert.throws(() => S.createMarket(A, { question: 'short', hours: 24 }), /Question/);
const { id: mid1 } = S.createMarket(A, { question: 'Will Bob win the fantasy league?', hours: 24 });
let mv = S.marketList(A.id).find((m) => m.id === mid1);
assert(Math.abs(mv.p - 0.5) < 1e-9);
const buyRes = S.tradeMarket(B, mid1, { side: 'yes', amount: 300 });
assert(bal(B.id) === balB0 - 300 && buyRes.shares > 440);
mv = S.marketList(B.id).find((m) => m.id === mid1);
assert(mv.p > 0.78 && mv.p < 0.84, 'price moved up after a $300 yes buy: ' + mv.p);
assert(mv.mine.yes > 440 && mv.volume === 300 && mv.traders === 1 && mv.pts.length === 2);
S.tradeMarket(A, mid1, { side: 'no', amount: 100 });
assert.throws(() => S.tradeMarket(A, mid1, { side: 'no', amount: 5 }), /Minimum/);
assert.throws(() => S.tradeMarket(A, mid1, { side: 'no', kind: 'sell', shares: 9999 }), /hold/);
assert.throws(() => S.resolveMarket(B, mid1, 'yes'), /creator/);
// partial sell, then resolve yes: winners get $1 per share
const bPos = S.marketList(B.id).find((m) => m.id === mid1).mine.yes;
const sold = S.tradeMarket(B, mid1, { side: 'yes', kind: 'sell', shares: bPos / 2 });
assert(sold.amount > 100 && sold.amount < 300);
const before = bal(B.id);
S.resolveMarket(A, mid1, 'yes');
const after = S.marketList(B.id).find((m) => m.id === mid1);
assert(after.status === 'resolved' && after.outcome === 'yes');
assert(Math.abs(bal(B.id) - before - Math.round(bPos / 2)) <= 1, 'winner paid $1 a share');
assert.throws(() => S.tradeMarket(B, mid1, { side: 'yes', amount: 50 }), /resolved/);
// void refunds net spend
const { id: mid2 } = S.createMarket(B, { question: 'Will it rain in Boston on Friday?', hours: 2 });
const balA1 = bal(A.id);
S.tradeMarket(A, mid2, { side: 'yes', amount: 200 });
S.resolveMarket(B, mid2, 'void');
assert(bal(A.id) === balA1, 'void gives the money back');
for (let i = 0; i < 3; i++) S.createMarket(A, { question: 'Another question number ' + i, hours: 5 });
assert.throws(() => S.createMarket(A, { question: 'One more than allowed', hours: 5 }), /open markets/);
console.log('markets ok');

// ---- game price history ----
S.upsertGame(game('7'));
S.recordPrice('7');
const h = S.gameHistory('7');
assert(h.points.length >= 1 && h.points[0][1] > 0 && h.points[0][1] < 1, 'price point recorded');
S.upsertGame(game('7', { state: 'in', period: 3, clock: 360, home_score: 70, away_score: 55 }));
const h2 = S.gameHistory('7');
assert(h2.points.length > h.points.length && h2.points[h2.points.length - 1][1] > 0.9, 'live price moved with the score');
const st2 = S.stateFor(A);
assert(Array.isArray(st2.markets) && st2.games.every((x) => typeof x.volume === 'number'));
S.snapshotNet();
const nh = S.netHistory();
assert(nh.users.length === 2 && nh.users.every((u) => u.pts.length >= 2), 'net worth history has the join point and a snapshot');
const state = S.stateFor(A);
assert(state.board.length === 2 && state.feed.length > 0);
console.log('board:', state.board.map((b) => `${b.username} ${b.net} (${b.profit >= 0 ? '+' : ''}${b.profit})`).join(' | '));
console.log('ALL TESTS PASSED');
process.exit(0);
