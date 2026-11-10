'use strict';
// Poker engine and money-flow tests. Throwaway DB, no network.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'courtside-poker-')), 't.db');
const { Table, score7, handName } = require('../lib/poker');
const bot = require('../lib/pokerbot');

// small seeded rng so failures reproduce
const seeded = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const C = (s) => 'shdc'.indexOf(s[1]) * 13 + '23456789TJQKA'.indexOf(s[0]);
const H = (...cs) => cs.map(C);

// ---- evaluator ordering ----
const rank = (cards) => score7(H(...cards));
const order = [
  ['high', ['Ah', 'Kd', '9c', '7s', '4h', '3d', '2c']],
  ['pair', ['Ah', 'Ad', '9c', '7s', '4h', '3d', '2c']],
  ['two pair', ['Ah', 'Ad', '9c', '9s', '4h', '3d', '2c']],
  ['trips', ['Ah', 'Ad', 'Ac', '7s', '4h', '3d', '2c']],
  ['wheel', ['Ah', '2d', '3c', '4s', '5h', '9d', 'Kc']],
  ['six-high straight', ['2h', '3d', '4c', '5s', '6h', '9d', 'Kc']],
  ['broadway', ['Th', 'Jd', 'Qc', 'Ks', 'Ah', '2d', '3c']],
  ['flush', ['Ah', '9h', '7h', '4h', '2h', 'Kd', 'Kc']],
  ['full house', ['Ah', 'Ad', 'Ac', 'Ks', 'Kh', '2d', '3c']],
  ['quads', ['Ah', 'Ad', 'Ac', 'As', 'Kh', '2d', '3c']],
  ['straight flush', ['5h', '6h', '7h', '8h', '9h', 'Kd', 'Kc']],
  ['royal', ['Th', 'Jh', 'Qh', 'Kh', 'Ah', '2d', '3c']],
];
for (let i = 1; i < order.length; i++) assert(rank(order[i][1]) > rank(order[i - 1][1]), `${order[i][0]} beats ${order[i - 1][0]}`);
assert(rank(['Ah', 'Kd', 'Qc', '7s', '4h', '3d', '2c']) > rank(['Ah', 'Kd', 'Jc', '7s', '4h', '3d', '2c']), 'kicker decides');
assert.strictEqual(rank(['Ah', 'Ad', 'Kc', 'Ks', 'Qh', 'Qd', '2c']), rank(['Ah', 'Ad', 'Kc', 'Ks', 'Qh', 'Qd', '3c']), 'three pair plays the best two plus the best kicker');
assert(handName(rank(order[11][1])) === 'Royal flush' && handName(rank(order[8][1])) === 'Full house');
assert(rank(['Ah', 'Ad', 'Ac', 'Ks', 'Kh', 'Qd', 'Qc']) > rank(['Kh', 'Kd', 'Kc', 'As', 'Ah', '2d', '3c']), 'trip aces full beats trip kings full');
console.log('evaluator ok');

// ---- chips are conserved over many bot-only hands ----
const run = (t, now) => {
  let guard = 0;
  while (t.stage !== 'showdown') {
    if (++guard > 400) throw new Error('hand never ended');
    const i = t.toAct, s = t.seats[i], rng = t.rng;
    const d = bot.decide(t, i, rng);
    t.act(i, d.type, d.amount, now);
  }
};
let totalRake = 0, showdowns = 0, folds = 0;
for (const nSeats of [2, 3, 6]) {
  const t = new Table({ id: 'x', name: 't', sb: 5, bb: 10, rng: seeded(nSeats * 7919) });
  for (let k = 0; k < nSeats; k++) t.sit(k, { bot: bot.PERSONAS[k], name: bot.PERSONAS[k].name, avatar: '#000' }, 500);
  let now = 1000;
  for (let h = 0; h < 120; h++) {
    assert(t.startHand(now), 'hand starts');
    const before = t.seats.reduce((a, s) => a + (s ? s.stack + s.totalIn : 0), 0);
    run(t, now);
    const after = t.seats.reduce((a, s) => a + (s ? s.stack : 0), 0);
    assert.strictEqual(after, before - t.result.rake, `chips conserved (seats ${nSeats}, hand ${h}): ${before} -> ${after}, rake ${t.result.rake}`);
    totalRake += t.result.rake; if (t.reveal) showdowns++; else folds++;
    assert(t.seats.every((s) => !s || s.stack >= 0));
    now += 10000;
  }
}
console.log(`120 hands x 3 table sizes: chips conserved, ${showdowns} showdowns, ${folds} fold-outs, rake taken ${totalRake}`);
assert(showdowns > 30 && folds > 30, 'bots both fight and fold');

// ---- side pots: short stack wins main, middle wins side, big stack gets the rest back ----
{
  const t = new Table({ id: 's', name: 's', sb: 5, bb: 10, rng: seeded(11) });
  t.sit(0, { name: 'A', avatar: '#1' }, 100); t.sit(1, { name: 'B', avatar: '#2' }, 300); t.sit(2, { name: 'C', avatar: '#3' }, 500);
  t.startHand(0);
  t.seats[0].hole = H('As', 'Ah'); t.seats[1].hole = H('Ks', 'Kh'); t.seats[2].hole = H('Qs', 'Qh');
  const board = H('2c', '5d', '9h', 'Jc', '3d');
  t.deck = [H('4s')[0], board[0], board[1], board[2], H('6s')[0], board[3], H('7s')[0], board[4]].reverse();
  let guard = 0;
  while (t.stage !== 'showdown') {
    if (++guard > 30) throw new Error('stuck');
    const i = t.toAct, s = t.seats[i];
    if (i === 2) t.act(i, 'call', 0, 0); else t.act(i, 'raise', s.bet + s.stack, 0);
  }
  assert.deepStrictEqual(t.seats.filter(Boolean).map((s) => s.stack), [300, 400, 200], 'side pots paid correctly');
  assert.strictEqual(t.seats.filter(Boolean).reduce((a, s) => a + s.stack, 0), 900);
}
console.log('side pots ok');

// ---- heads-up: button is small blind and acts first; folding hands over the blind ----
{
  const t = new Table({ id: 'h', name: 'h', sb: 5, bb: 10, rng: seeded(5) });
  t.sit(0, { name: 'A', avatar: '#1' }, 1000); t.sit(3, { name: 'B', avatar: '#2' }, 1000);
  t.startHand(0);
  assert.strictEqual(t.toAct, t.button, 'button acts first heads-up');
  assert.strictEqual(t.seats[t.button].bet, 5);
  const b = t.button, other = t.seats.findIndex((s, i) => s && i !== b);
  t.act(b, 'fold', 0, 0);
  assert.strictEqual(t.stage, 'showdown');
  assert.strictEqual(t.seats[other].stack, 1005); assert.strictEqual(t.seats[b].stack, 995);
  assert(!t.reveal, 'no cards shown when everyone folds');
  assert.throws(() => t.act(b, 'check', 0, 0));
}
// raise rules
{
  const t = new Table({ id: 'r', name: 'r', sb: 5, bb: 10, rng: seeded(9) });
  t.sit(0, { name: 'A', avatar: '#1' }, 1000); t.sit(1, { name: 'B', avatar: '#2' }, 1000); t.sit(2, { name: 'C', avatar: '#3' }, 1000);
  t.startHand(0);
  const i = t.toAct;
  assert.throws(() => t.act(i, 'check', 0, 0), /call or fold/);
  assert.throws(() => t.act(i, 'raise', 15, 0), /Minimum raise/);
  t.act(i, 'raise', 30, 0);
  assert.strictEqual(t.currentBet, 30); assert.strictEqual(t.minRaise, 20);
}
console.log('betting rules ok');

// ---- server: buy-in, play with a human, cash out, money adds up ----
const S = require('../server');
S.register({ username: 'pat', pin: '1234', code: S.INVITE() });
S.register({ username: 'quinn', pin: '1234', code: S.INVITE() });
const U = (n) => S.db.prepare('SELECT * FROM users WHERE username=?').get(n);
const bal = (n) => U(n).balance;
const pat = U('pat');
assert.throws(() => S.createTable(pat, { stakes: 'nope' }), /stakes/);
assert.throws(() => S.createTable(pat, { stakes: '5/10', buyin: 50, bots: 1 }), /Buy-in/);
const { id } = S.createTable(pat, { stakes: '5/10', buyin: 500, bots: 3 });
assert.strictEqual(bal('pat'), 9500, 'buy-in leaves your cash');
assert.strictEqual(S.pokerProfit(pat.id), 0, 'no profit or loss before any hands');
assert.throws(() => S.createTable(pat, { stakes: '5/10', buyin: 500, bots: 1 }), /already seated/);
let v = S.pokerView(pat, id);
assert.strictEqual(v.stage, 'preflop'); assert.strictEqual(v.seats.filter(Boolean).length, 4);
const me = v.seats[v.me]; assert(me.hole.every((c) => c !== '??') && me.hole.length === 2);
assert(v.seats.filter((s) => s && !s.mine && s.dealt).every((s) => s.hole[0] === '??'), 'opponent cards are hidden');
const t = S.tables.get(id);
for (let h = 0, guard = 0; h < 25 && guard < 4000; guard++) {
  t.botAt = 0; t.nextHandAt = 0;
  const handBefore = t.handNo;
  S.pokerTick();
  const w = S.pokerView(pat, id);
  if (w.myTurn) { try { S.pokerAction(pat, id, { type: w.canCheck ? 'check' : (w.toCall > w.seats[w.me].stack * 0.5 ? 'fold' : 'call') }); } catch (e) { /* hand moved on */ } }
  if (t.handNo !== handBefore) h++;
  if (!S.tables.has(id)) break;
}
assert(S.tables.has(id), 'table still running');
const mid = S.pokerProfit(pat.id), seated = t.seats.find((s) => s && s.uid === pat.id);
assert.strictEqual(bal('pat') + seated.stack + (t.inHand() ? seated.totalIn : 0), 10000 + mid, 'cash + stack matches profit');
// someone else joins, then both leave
const quinn = U('quinn');
assert.throws(() => S.sitHuman(quinn, t, 50), /Buy-in/);
S.sitHuman(quinn, t, 400);
assert.strictEqual(bal('quinn'), 9600);
S.pokerLeave(quinn, id);
assert.strictEqual(S.pokerProfit(quinn.id), bal('quinn') - 10000);
assert(bal('quinn') >= 9600 && bal('quinn') <= 10000 + 400 * 50, 'quinn got a stack back');
const before = bal('pat');
const stackNow = t.seats.find((s) => s && s.uid === pat.id).stack;
S.pokerLeave(pat, id);
assert.strictEqual(bal('pat'), before + stackNow);
assert(!S.tables.has(id), 'table closes when the last human leaves');
assert.strictEqual(S.pokerProfit(pat.id), bal('pat') - 10000, 'profit equals change in cash');
const lb = S.stateFor(U('pat')).board.find((b) => b.username === 'pat');
assert.strictEqual(lb.net, bal('pat'), 'leaderboard sees cash only after cashing out');
console.log('server poker ok');
console.log('POKER TESTS PASSED');
process.exit(0);
