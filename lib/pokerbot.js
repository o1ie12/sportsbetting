'use strict';
// Computer opponents. They size up their hand with a quick Monte Carlo equity
// estimate against random hands, then play it by pot odds with a bit of style and noise.
const { score7 } = require('./poker');

const PERSONAS = [
  { name: 'Rex', avatar: '#8c2f1b', style: { tight: 0.25, aggr: 0.55, bluff: 0.07 } },
  { name: 'Mira', avatar: '#6b3a7a', style: { tight: 0.6, aggr: 0.35, bluff: 0.03 } },
  { name: 'Dutch', avatar: '#b07a12', style: { tight: 0.05, aggr: 0.7, bluff: 0.12 } },
  { name: 'Nova', avatar: '#1d5c8a', style: { tight: 0.4, aggr: 0.5, bluff: 0.05 } },
  { name: 'Bishop', avatar: '#37474f', style: { tight: 0.85, aggr: 0.25, bluff: 0.02 } },
  { name: 'Lou', avatar: '#3d5a2a', style: { tight: 0.1, aggr: 0.3, bluff: 0.04 } },
];

function equity(hole, board, opp, sims, rng) {
  const known = new Set([...hole, ...board]), deck = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) deck.push(c);
  const need = 5 - board.length, k = 2 * opp + need;
  let win = 0;
  for (let n = 0; n < sims; n++) {
    for (let j = 0; j < k; j++) { const r = j + Math.floor(rng() * (deck.length - j)); const t = deck[j]; deck[j] = deck[r]; deck[r] = t; }
    const full = board.concat(deck.slice(0, need));
    const me = score7(hole.concat(full));
    let best = true, ties = 1;
    for (let o = 0; o < opp; o++) {
      const sc = score7([deck[need + 2 * o], deck[need + 2 * o + 1]].concat(full));
      if (sc > me) { best = false; break; }
      if (sc === me) ties++;
    }
    if (best) win += 1 / ties;
  }
  return win / sims;
}

// returns { type: 'fold'|'check'|'call'|'raise', amount? }
function decide(t, i, rng) {
  const s = t.seats[i], st = s.bot.style;
  const toCall = Math.min(t.currentBet - s.bet, s.stack);
  const opp = t.liveSeats().filter((j) => j !== i).length;
  const pre = t.stage === 'preflop';
  const eq = equity(s.hole, t.board, opp, pre ? 140 : 220, rng) + (rng() - 0.5) * 0.06;
  const pot = t.potTotal(), fair = 1 / (opp + 1), maxTo = s.bet + s.stack;
  const minTo = t.currentBet === 0 ? t.bb : t.currentBet + t.minRaise;
  const raiseTo = (frac) => {
    let to = t.currentBet + Math.max(t.minRaise, Math.round((pot + toCall) * frac));
    to = Math.max(minTo, to);
    if (to >= maxTo * 0.8) to = maxTo;
    return Math.min(to, maxTo);
  };
  const strong = fair + 0.26 + st.tight * 0.08;
  if (toCall === 0) {
    if (eq > strong && rng() < 0.5 + st.aggr * 0.45) return { type: 'raise', amount: raiseTo(0.45 + rng() * 0.35) };
    if (!pre && opp <= 2 && rng() < st.bluff) return { type: 'raise', amount: raiseTo(0.5) };
    return { type: 'check' };
  }
  const potOdds = toCall / (pot + toCall);
  const callT = potOdds * (pre ? 0.85 : 1) + 0.02 + st.tight * 0.04;
  if (eq < callT) return { type: 'fold' };
  if (eq > strong + 0.1 && rng() < st.aggr + 0.25 && maxTo > t.currentBet) return { type: 'raise', amount: raiseTo(0.6 + rng() * 0.4) };
  return { type: 'call' };
}
module.exports = { PERSONAS, decide, equity };
