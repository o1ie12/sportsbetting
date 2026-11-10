'use strict';
// No-limit Texas Hold'em: cards, hand evaluator and one table's state machine.
// Cards are ints 0..51: rank = c % 13 (0 is a deuce, 12 an ace), suit = floor(c / 13).
const crypto = require('crypto');

const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
const cardStr = (c) => RANKS[c % 13] + SUITS[(c / 13) | 0];
const defaultRng = () => crypto.randomInt(0, 1 << 30) / (1 << 30);
const HAND_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

function shuffled(rng) {
  const d = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

// Best 5-card hand out of up to 7 cards, as one comparable number.
function score7(cs) {
  const cnt = new Array(15).fill(0), suits = [[], [], [], []];
  for (const c of cs) { const r = (c % 13) + 2; cnt[r]++; suits[(c / 13) | 0].push(r); }
  const enc = (cat, v) => { let s = cat; for (let i = 0; i < 5; i++) s = s * 15 + (v[i] || 0); return s; };
  const straight = (has) => {
    for (let h = 14; h >= 5; h--) {
      let ok = true;
      for (let k = 0; k < 5; k++) { let r = h - k; if (r === 1) r = 14; if (!has[r]) { ok = false; break; } }
      if (ok) return h;
    }
    return 0;
  };
  let flush = null;
  for (const s of suits) if (s.length >= 5) flush = s.slice().sort((a, b) => b - a);
  if (flush) {
    const has = new Array(15).fill(false); flush.forEach((r) => { has[r] = true; });
    const sh = straight(has); if (sh) return enc(8, [sh]);
  }
  const quads = [], trips = [], pairs = [];
  for (let r = 14; r >= 2; r--) { if (cnt[r] === 4) quads.push(r); else if (cnt[r] === 3) trips.push(r); else if (cnt[r] === 2) pairs.push(r); }
  const kick = (excl, n) => { const o = []; for (let r = 14; r >= 2 && o.length < n; r--) if (cnt[r] > 0 && !excl.includes(r)) o.push(r); return o; };
  if (quads.length) return enc(7, [quads[0], ...kick([quads[0]], 1)]);
  if (trips.length && (trips.length > 1 || pairs.length)) return enc(6, [trips[0], Math.max(trips[1] || 0, pairs[0] || 0)]);
  if (flush) return enc(5, flush.slice(0, 5));
  const sh = straight(cnt.map((x) => x > 0)); if (sh) return enc(4, [sh]);
  if (trips.length) return enc(3, [trips[0], ...kick([trips[0]], 2)]);
  if (pairs.length >= 2) return enc(2, [pairs[0], pairs[1], ...kick([pairs[0], pairs[1]], 1)]);
  if (pairs.length === 1) return enc(1, [pairs[0], ...kick([pairs[0]], 3)]);
  return enc(0, kick([], 5));
}
function handName(score) {
  const cat = Math.floor(score / 15 ** 5);
  if (cat === 8 && Math.floor(score / 15 ** 4) % 15 === 14) return 'Royal flush';
  return HAND_NAMES[cat];
}

class Table {
  constructor(o) {
    this.id = o.id; this.name = o.name; this.sb = o.sb; this.bb = o.bb; this.maxSeats = o.maxSeats || 6; this.creator = o.creator || null;
    this.minBuy = o.minBuy || o.bb * 20; this.maxBuy = o.maxBuy || o.bb * 100;
    this.bots = false; this.seats = new Array(this.maxSeats).fill(null);
    this.button = -1; this.stage = 'waiting'; this.board = []; this.deck = []; this.toAct = -1;
    this.currentBet = 0; this.minRaise = this.bb; this.handNo = 0; this.logs = []; this.result = null; this.reveal = false;
    this.flopSeen = false; this.nextHandAt = 0; this.deadline = 0; this.botAt = 0; this.reportedHand = 0; this.created = Date.now();
    Object.defineProperty(this, 'rng', { value: o.rng || defaultRng, writable: true, enumerable: false });
  }
  static fromJSON(obj, rng) { const t = new Table({ ...obj, rng }); Object.assign(t, obj); return t; }

  // ----- seats -----
  log(msg) { this.logs.push(msg); if (this.logs.length > 40) this.logs.shift(); }
  nextFrom(i, pred) { for (let k = 1; k <= this.maxSeats; k++) { const j = (i + k + this.maxSeats * 2) % this.maxSeats; if (pred(j)) return j; } return -1; }
  orderFrom(i, list) { const out = []; for (let k = 1; k <= this.maxSeats; k++) { const j = (i + k) % this.maxSeats; if (list.includes(j)) out.push(j); } return out; }
  canAct(i) { const s = this.seats[i]; return !!s && !s.folded && !s.allIn && s.stack > 0; }
  liveSeats() { const o = []; this.seats.forEach((s, i) => { if (s && !s.folded && s.hole.length) o.push(i); }); return o; }
  inHand() { return ['preflop', 'flop', 'turn', 'river'].includes(this.stage); }
  potTotal() { return this.seats.reduce((a, s) => a + (s ? s.totalIn : 0), 0); }
  sit(idx, p, buyin) {
    if (this.seats[idx]) throw new Error('Seat taken');
    this.seats[idx] = { uid: p.uid || null, bot: p.bot || null, name: p.name, avatar: p.avatar, stack: buyin, buyin,
      bet: 0, totalIn: 0, folded: true, allIn: false, hole: [], acted: false, leaving: false, sitOut: false, timeouts: 0, last: '' };
    if (p.bot) this.bots = true;
  }
  freeSeat() { return this.seats.findIndex((s) => !s); }

  // ----- hand flow -----
  startHand(now) {
    for (const s of this.seats) if (s && s.bot && s.stack < this.bb * 20) s.stack = s.buyin;
    const el = []; this.seats.forEach((s, i) => { if (s && s.stack > 0 && !s.sitOut && !s.leaving) el.push(i); });
    if (el.length < 2) { this.stage = 'waiting'; this.toAct = -1; return false; }
    for (const s of this.seats) if (s) { s.bet = 0; s.totalIn = 0; s.folded = true; s.allIn = false; s.hole = []; s.acted = false; s.last = ''; }
    for (const i of el) this.seats[i].folded = false;
    this.deck = shuffled(this.rng); this.board = []; this.result = null; this.reveal = false; this.flopSeen = false;
    this.button = this.nextFrom(this.button, (i) => el.includes(i));
    const hu = el.length === 2;
    const sbI = hu ? this.button : this.nextFrom(this.button, (i) => el.includes(i));
    const bbI = this.nextFrom(sbI, (i) => el.includes(i));
    this.post(sbI, this.sb); this.post(bbI, this.bb);
    for (let k = 0; k < 2; k++) for (const i of this.orderFrom(this.button, el)) this.seats[i].hole.push(this.deck.pop());
    this.stage = 'preflop'; this.currentBet = Math.max(this.seats[sbI].bet, this.seats[bbI].bet); this.minRaise = this.bb; this.handNo++;
    this.log(`Hand ${this.handNo}. Blinds ${this.sb}/${this.bb}.`);
    this.toAct = bbI;
    this.proceed(now);
    return true;
  }
  post(i, amt) {
    const s = this.seats[i], pay = Math.min(s.stack, amt);
    s.stack -= pay; s.bet += pay; s.totalIn += pay; if (s.stack === 0) s.allIn = true;
  }
  act(i, type, amount, now) {
    if (!this.inHand() || i !== this.toAct) throw new Error('It is not your turn');
    const s = this.seats[i], toCall = this.currentBet - s.bet;
    const pay = (n) => { s.stack -= n; s.bet += n; s.totalIn += n; if (s.stack === 0) s.allIn = true; };
    if (type === 'fold') { s.folded = true; s.last = 'Fold'; this.log(`${s.name} folds`); }
    else if (type === 'check') {
      if (toCall > 0) throw new Error('You have to call or fold');
      s.last = 'Check'; this.log(`${s.name} checks`);
    } else if (type === 'call') {
      if (toCall <= 0) { s.last = 'Check'; this.log(`${s.name} checks`); }
      else { const n = Math.min(toCall, s.stack); pay(n); s.last = s.allIn ? 'All in' : 'Call'; this.log(`${s.name} ${s.allIn ? 'is all in for' : 'calls'} $${n}`); }
    } else if (type === 'raise') {
      const maxTo = s.bet + s.stack;
      const to = Math.min(Math.floor(Number(amount)), maxTo);
      if (!(to > 0)) throw new Error('Enter an amount');
      if (to <= this.currentBet) { // not actually a raise: all-in for less than the call
        if (to < maxTo) throw new Error('Raise must be more than the current bet');
        const n = Math.min(toCall, s.stack); pay(n); s.last = 'All in'; this.log(`${s.name} is all in for $${n}`);
      } else {
        const minTo = this.currentBet === 0 ? this.bb : this.currentBet + this.minRaise;
        if (to < minTo && to < maxTo) throw new Error(`Minimum raise is to $${minTo}`);
        const opening = this.currentBet === 0, size = to - this.currentBet;
        pay(to - s.bet);
        this.minRaise = Math.max(this.minRaise, size); this.currentBet = to;
        for (let j = 0; j < this.maxSeats; j++) if (j !== i && this.seats[j]) this.seats[j].acted = false;
        s.last = s.allIn ? 'All in' : opening ? 'Bet' : 'Raise';
        this.log(`${s.name} ${s.allIn ? 'is all in to' : opening ? 'bets' : 'raises to'} $${to}`);
      }
    } else throw new Error('Unknown action');
    s.acted = true;
    this.proceed(now);
  }
  // fold a player who is not on the clock (they left the table)
  forceFold(i, now) {
    const s = this.seats[i];
    if (!s || s.folded || !this.inHand()) return;
    s.folded = true; s.last = 'Fold'; this.log(`${s.name} folds`);
    this.proceed(now, i !== this.toAct);
  }
  // figure out what happens next: next actor, next street, or showdown
  proceed(now, keepActor) {
    const live = this.liveSeats();
    if (live.length <= 1) return this.showdown(now);
    const active = live.filter((i) => this.canAct(i));
    let need = active.filter((i) => !(this.seats[i].acted && this.seats[i].bet === this.currentBet));
    if (active.length === 1 && this.seats[active[0]].bet >= this.currentBet) need = [];
    if (need.length === 0) return this.nextStage(now);
    if (keepActor && need.includes(this.toAct)) return undefined;
    this.toAct = this.nextFrom(this.toAct, (i) => need.includes(i));
    this.armTimers(now);
    return undefined;
  }
  armTimers(now) {
    const s = this.seats[this.toAct];
    this.deadline = s && !s.bot ? now + 40000 : 0;
    this.botAt = s && s.bot ? now + 800 + Math.floor(this.rng() * 1200) : 0;
  }
  nextStage(now) {
    for (const s of this.seats) if (s) { s.bet = 0; s.acted = false; s.last = ''; }
    this.currentBet = 0; this.minRaise = this.bb;
    const deal = (n) => { this.deck.pop(); for (let k = 0; k < n; k++) this.board.push(this.deck.pop()); };
    if (this.stage === 'preflop') { deal(3); this.stage = 'flop'; this.flopSeen = true; }
    else if (this.stage === 'flop') { deal(1); this.stage = 'turn'; }
    else if (this.stage === 'turn') { deal(1); this.stage = 'river'; }
    else return this.showdown(now);
    const active = this.liveSeats().filter((i) => this.canAct(i));
    if (active.length <= 1) { // everyone left is all in: run the board out
      while (this.board.length < 5) deal(1);
      return this.showdown(now);
    }
    this.toAct = this.button;
    return this.proceed(now);
  }
  returnUncalled() {
    const order = this.seats.map((s, i) => ({ s, i })).filter((x) => x.s && x.s.totalIn > 0).sort((a, b) => b.s.totalIn - a.s.totalIn);
    if (order.length && (order.length === 1 || order[0].s.totalIn > order[1].s.totalIn)) {
      const diff = order[0].s.totalIn - (order[1] ? order[1].s.totalIn : 0);
      if (diff > 0 && !order[0].s.folded) { order[0].s.stack += diff; order[0].s.totalIn -= diff; order[0].s.bet = Math.max(0, order[0].s.bet - diff); }
    }
  }
  buildPots() {
    const levels = [...new Set(this.seats.filter((s) => s && s.totalIn > 0).map((s) => s.totalIn))].sort((a, b) => a - b);
    const pots = []; let prev = 0;
    for (const lv of levels) {
      let amount = 0; const eligible = [];
      this.seats.forEach((s, i) => {
        if (!s) return;
        amount += Math.max(0, Math.min(s.totalIn, lv) - Math.min(s.totalIn, prev));
        if (!s.folded && s.hole.length && s.totalIn >= lv) eligible.push(i);
      });
      if (amount > 0) { if (eligible.length) pots.push({ amount, eligible }); else if (pots.length) pots[pots.length - 1].amount += amount; }
      prev = lv;
    }
    return pots;
  }
  showdown(now) {
    this.stage = 'showdown'; this.toAct = -1; this.deadline = 0; this.botAt = 0;
    this.returnUncalled();
    const live = this.liveSeats(), contested = live.length > 1;
    this.reveal = contested;
    const score = {};
    if (contested) for (const i of live) score[i] = score7([...this.seats[i].hole, ...this.board]);
    const pots = this.buildPots();
    const total = pots.reduce((a, p) => a + p.amount, 0);
    let rake = 0;
    if (this.bots && this.flopSeen && pots.length) { rake = Math.min(Math.floor(total * 0.03), this.bb * 3); pots[0].amount -= rake; }
    const won = {}, lines = [], resPots = [];
    for (const p of pots) {
      if (p.amount <= 0) continue;
      let winners = p.eligible;
      if (contested) { const best = Math.max(...p.eligible.map((i) => score[i])); winners = p.eligible.filter((i) => score[i] === best); }
      const share = Math.floor(p.amount / winners.length); let rem = p.amount - share * winners.length;
      for (const w of this.orderFrom(this.button, winners)) { const g = share + (rem > 0 ? 1 : 0); if (rem > 0) rem--; this.seats[w].stack += g; won[w] = (won[w] || 0) + g; }
      resPots.push({ amount: p.amount, winners, hand: contested ? handName(score[winners[0]]) : null });
    }
    const net = {};
    for (const k of Object.keys(won)) {
      const i = Number(k), s = this.seats[i];
      net[i] = won[k] - s.totalIn;
      const hand = contested ? handName(score[i]) : null;
      lines.push(`${s.name} wins $${won[k]}${hand ? ` with ${hand.toLowerCase()}` : ''}`);
    }
    this.result = { lines, pots: resPots, won, net, rake, scores: contested ? Object.fromEntries(live.map((i) => [i, handName(score[i])])) : {} };
    for (const l of lines) this.log(l);
    this.nextHandAt = now + (contested ? 6500 : 3200);
  }

  // ----- what a player is allowed to see -----
  view(uid, now) {
    const me = uid == null ? -1 : this.seats.findIndex((s) => s && s.uid === uid);
    const reveal = this.stage === 'showdown' && this.reveal;
    const seats = this.seats.map((s, i) => {
      if (!s) return null;
      const dealt = s.hole.length > 0;
      const show = i === me || (reveal && !s.folded);
      return { i, name: s.name, avatar: s.avatar, bot: !!s.bot, stack: s.stack, bet: s.bet, folded: s.folded && dealt, allIn: s.allIn, sitOut: s.sitOut,
        leaving: s.leaving, dealt, last: s.last, dealer: i === this.button && this.stage !== 'waiting', acting: i === this.toAct && this.inHand(),
        mine: i === me, hole: dealt ? (show ? s.hole.map(cardStr) : ['??', '??']) : [], hand: reveal && !s.folded && this.result ? this.result.scores[i] || null : null,
        won: this.stage === 'showdown' && this.result && this.result.won[i] ? this.result.won[i] : 0 };
    });
    const mine = me >= 0 ? this.seats[me] : null;
    const toCall = mine && this.inHand() ? Math.max(0, Math.min(this.currentBet - mine.bet, mine.stack)) : 0;
    const minTo = this.currentBet === 0 ? this.bb : this.currentBet + this.minRaise;
    return {
      id: this.id, name: this.name, sb: this.sb, bb: this.bb, minBuy: this.minBuy, maxBuy: this.maxBuy, maxSeats: this.maxSeats,
      stage: this.stage, board: this.board.map(cardStr), pot: this.potTotal(), currentBet: this.currentBet, minRaiseTo: minTo, bots: this.bots,
      me, myTurn: me >= 0 && me === this.toAct && this.inHand(), toCall, canCheck: !!mine && this.currentBet - mine.bet <= 0,
      maxTo: mine ? mine.bet + mine.stack : 0, deadline: this.deadline, now, handNo: this.handNo, button: this.button,
      seats, log: this.logs.slice(-14), result: this.stage === 'showdown' && this.result ? { lines: this.result.lines, rake: this.result.rake } : null,
    };
  }
}
module.exports = { Table, score7, handName, shuffled, cardStr, RANKS, SUITS };
