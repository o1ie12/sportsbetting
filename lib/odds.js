'use strict';
// Odds math + pricing model. The same normal-distribution model prices
// alt lines, winning-margin bands, live in-play lines and cash-out offers.

const SD_M = 12.5; // std-dev of NBA final margin
const SD_T = 18;   // std-dev of NBA final total

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
const dec = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
const imp = (a) => 1 / dec(a);
function toAmerican(p) {
  p = Math.min(0.985, Math.max(0.015, p));
  let a = p >= 0.5 ? (-100 * p) / (1 - p) : (100 * (1 - p)) / p;
  a = Math.round(a / 5) * 5;
  if (Math.abs(a) < 100) a = a < 0 ? -100 : 100;
  return a;
}
const fmtAm = (a) => (a > 0 ? `+${a}` : `${a}`);
const fmtLine = (l) => (l > 0 ? `+${l}` : l === 0 ? 'PK' : `${l}`);

// P(win) and P(push) for a leg that wins when X + L > 0, X ~ N(mu, sd) on integer outcomes
function pWinLine(mu, sd, L) {
  const isInt = Number.isInteger(L);
  const win = 1 - normCdf((-L + (isInt ? 0.5 : 0) - mu) / sd);
  const push = isInt ? normCdf((-L + 0.5 - mu) / sd) - normCdf((-L - 0.5 - mu) / sd) : 0;
  return { win, push };
}
const pHomeWin = (mu, sd) => 1 - normCdf(-mu / sd);

const MARGIN_BANDS = [
  ['1-5', 0, 5.5], ['6-10', 5.5, 10.5], ['11-15', 10.5, 15.5], ['16+', 15.5, 99],
];
function pBand(mu, sd, lo, hi) { return normCdf((hi - mu) / sd) - normCdf((lo - mu) / sd); }

// ---- parlay boost (profit boost, like the real books) ----
function boostFor(n) { return n >= 7 ? 30 : n === 6 ? 25 : n === 5 ? 20 : n === 4 ? 15 : n === 3 ? 10 : 0; }

// ---- game model ----
function remFrac(g) {
  if (g.state === 'pre') return 1;
  if (g.state === 'post' || g.state === 'void') return 0;
  const p = g.period || 1, clk = g.clock || 0;
  if (p <= 4) return Math.max(0.02, ((4 - p) * 12 + clk / 60) / 48);
  return Math.max(0.02, clk / 60 / 48);
}
function model(g) {
  const o = g.odds;
  const rem = remFrac(g);
  const preMu = -o.spread.home_line, preT = o.total.line;
  const hs = g.home_score || 0, as = g.away_score || 0;
  const f = Math.sqrt(rem);
  return {
    rem,
    mu: hs - as + preMu * rem,
    muT: hs + as + preT * rem,
    sd: Math.max(1.5, SD_M * f),
    sdT: Math.max(2, SD_T * f),
  };
}

function houseOdds(hRec, aRec) {
  const wp = (rec) => {
    const m = /(\d+)-(\d+)/.exec(rec || '');
    if (!m) return 0.5;
    const w = +m[1], l = +m[2];
    return (w + 3) / (w + l + 6);
  };
  const diff = (wp(hRec) - wp(aRec)) * 14 + 2.5; // expected home margin
  const hl = -(Math.floor(diff) + 0.5);
  const mu = -hl;
  const p = pHomeWin(mu, SD_M);
  return {
    src: 'house',
    ml: { home: toAmerican(p * 1.045), away: toAmerican((1 - p) * 1.045) },
    spread: { home_line: hl, home_odds: -110, away_odds: -110 },
    total: { line: 226.5, over: -110, under: -110 },
  };
}

// ---- market builder ----
const key = (gid, market, sel, line, extra) => `${gid}|${market}|${sel}|${line ?? ''}|${extra ?? ''}`;

function buildMarkets(g, now = Date.now()) {
  const live = g.state === 'in';
  const m = model(g);
  const bettable = (g.state === 'pre' && g.start > now) || (live && m.rem >= 0.15);
  const out = { live, bettable, groups: [], index: new Map(), win_prob_home: pHomeWin(m.mu, m.sd) };
  if (!bettable) return out;
  const A = g.away_abbr, H = g.home_abbr;
  const add = (s) => { out.index.set(s.key, s); return s; };
  const mk = (market, sel, line, odds, label, family, extra, more) =>
    add({ key: key(g.id, market, sel, line, extra), game_id: g.id, market, sel, line: line ?? null, odds, label, family, live, ...more });

  const o = g.odds;
  let spreadHome, totalLine, vigP = 1;
  const S = {};
  if (!live) {
    spreadHome = o.spread.home_line; totalLine = o.total.line;
    S.spH = o.spread.home_odds; S.spA = o.spread.away_odds;
    S.ovO = o.total.over; S.unO = o.total.under;
    S.mlH = o.ml.home; S.mlA = o.ml.away;
  } else {
    vigP = 1.05;
    spreadHome = Math.floor(-m.mu) + 0.5; totalLine = Math.floor(m.muT) + 0.5;
    const sh = pWinLine(m.mu, m.sd, spreadHome).win;
    S.spH = toAmerican(sh * vigP); S.spA = toAmerican((1 - sh) * vigP);
    const ov = pWinLine(m.muT, m.sdT, -totalLine).win;
    S.ovO = toAmerican(ov * vigP); S.unO = toAmerican((1 - ov) * vigP);
    const ph = pHomeWin(m.mu, m.sd);
    S.mlH = ph > 0.03 && ph < 0.97 ? toAmerican(ph * vigP) : null;
    S.mlA = ph > 0.03 && ph < 0.97 ? toAmerican((1 - ph) * vigP) : null;
  }
  const spreadAway = -spreadHome;
  out.groups.push({
    id: 'main', kind: 'main', title: live ? 'Live lines' : 'Game lines',
    spread: [mk('spread', 'away', spreadAway, S.spA, `${A} ${fmtLine(spreadAway)}`, 'side'), mk('spread', 'home', spreadHome, S.spH, `${H} ${fmtLine(spreadHome)}`, 'side')],
    total: [mk('total', 'over', totalLine, S.ovO, `Over ${totalLine}`, 'total'), mk('total', 'under', totalLine, S.unO, `Under ${totalLine}`, 'total')],
    ml: [S.mlA == null ? null : mk('ml', 'away', null, S.mlA, `${A} ML`, 'side'), S.mlH == null ? null : mk('ml', 'home', null, S.mlH, `${H} ML`, 'side')],
  });
  if (live) return out;

  // alt spreads
  const altS = [];
  for (const s of [-9, -6, -3, 3, 6, 9]) {
    const hl = spreadHome + s, al = -hl;
    const ph = pWinLine(m.mu, m.sd, hl).win, pa = pWinLine(-m.mu, m.sd, al).win;
    if (ph < 0.1 || ph > 0.9) continue;
    altS.push({ left: mk('spread', 'home', hl, toAmerican(ph * 1.04), `${H} ${fmtLine(hl)}`, 'side', 'alt'), right: mk('spread', 'away', al, toAmerican(pa * 1.04), `${A} ${fmtLine(al)}`, 'side', 'alt') });
  }
  altS.sort((a, b) => a.left.line - b.left.line);
  if (altS.length) out.groups.push({ id: 'alt_spread', kind: 'pairs', title: 'Alternate spreads', rows: altS, leftName: H, rightName: A });

  // alt totals
  const altT = [];
  for (const s of [-10, -5, 5, 10]) {
    const L = totalLine + s;
    const po = pWinLine(m.muT, m.sdT, -L).win, pu = pWinLine(-m.muT, m.sdT, L).win;
    altT.push({ left: mk('total', 'over', L, toAmerican(po * 1.04), `Over ${L}`, 'total', 'alt'), right: mk('total', 'under', L, toAmerican(pu * 1.04), `Under ${L}`, 'total', 'alt') });
  }
  altT.sort((a, b) => a.left.line - b.left.line);
  out.groups.push({ id: 'alt_total', kind: 'pairs', title: 'Alternate totals', rows: altT, leftName: 'Over', rightName: 'Under' });

  // winning margin bands
  const bands = [];
  for (const [side, abbr, sgn] of [['away', A, -1], ['home', H, 1]]) {
    for (const [name, lo, hi] of MARGIN_BANDS) {
      const p = pBand(sgn * m.mu, m.sd, lo, hi);
      bands.push(mk('margin', `${side}:${name}`, null, toAmerican(p * 1.12), `${abbr} by ${name}`, 'side', null, { band: name }));
    }
  }
  out.groups.push({ id: 'margin', kind: 'grid', title: 'Winning margin', sels: bands });

  // player props (lines locked from season averages)
  const props = (g.props || []).map((p) => ({
    p,
    over: mk('prop', 'over', p.line, -115, `${p.name} O ${p.line} ${p.stat}`, `prop:${p.id}`, p.id, { prop: p }),
    under: mk('prop', 'under', p.line, -115, `${p.name} U ${p.line} ${p.stat}`, `prop:${p.id}`, p.id, { prop: p }),
  }));
  if (props.length) out.groups.push({ id: 'props', kind: 'props', title: 'Player props', rows: props });
  return out;
}

// ---- grading ----
function gradeLeg(leg, g) {
  if (g.state === 'void') return 'void';
  if (g.state !== 'post') return null;
  const hs = g.home_score, as = g.away_score;
  const sign = (v) => (v > 0 ? 'won' : v < 0 ? 'lost' : 'push');
  switch (leg.market) {
    case 'ml': return leg.sel === 'home' ? sign(hs - as) : sign(as - hs);
    case 'spread': return leg.sel === 'home' ? sign(hs + leg.line - as) : sign(as + leg.line - hs);
    case 'total': return leg.sel === 'over' ? sign(hs + as - leg.line) : sign(leg.line - hs - as);
    case 'margin': {
      const [side, band] = leg.sel.split(':');
      const x = side === 'home' ? hs - as : as - hs;
      const b = MARGIN_BANDS.find((b) => b[0] === band);
      return x > b[1] && x < b[2] ? 'won' : 'lost';
    }
    case 'prop': {
      const ex = JSON.parse(leg.extra || '{}');
      if (!g.box) return null;
      const row = g.box[ex.athlete_id];
      if (!row || row.dnp) return 'void';
      const v = row[ex.stat];
      return leg.sel === 'over' ? sign(v - leg.line) : sign(leg.line - v);
    }
  }
  return null;
}

// P(win) / P(push) of a still-pending leg
function legProb(leg, g) {
  if (g.state === 'void') return { win: 0, push: 1 };
  if (g.state === 'post') return null;
  const m = model(g);
  switch (leg.market) {
    case 'ml': { const p = pHomeWin(m.mu, m.sd); return { win: leg.sel === 'home' ? p : 1 - p, push: 0 }; }
    case 'spread': return leg.sel === 'home' ? pWinLine(m.mu, m.sd, leg.line) : pWinLine(-m.mu, m.sd, leg.line);
    case 'total': return leg.sel === 'over' ? pWinLine(m.muT, m.sdT, -leg.line) : pWinLine(-m.muT, m.sdT, leg.line);
    case 'margin': {
      const [side, band] = leg.sel.split(':');
      const b = MARGIN_BANDS.find((b) => b[0] === band);
      return { win: pBand(side === 'home' ? m.mu : -m.mu, m.sd, b[1], b[2]), push: 0 };
    }
    case 'prop': return g.state === 'pre' ? { win: 0.5, push: 0 } : null;
  }
  return null;
}

module.exports = { SD_M, SD_T, normCdf, dec, imp, toAmerican, fmtAm, fmtLine, pWinLine, pHomeWin, boostFor, model, houseOdds, buildMarkets, gradeLeg, legProb, key };
