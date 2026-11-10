'use strict';
// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Math.round(n).toLocaleString('en-US');
const usd = (n) => (n < 0 ? '-$' : '$') + money(Math.abs(n));
const dec = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
const clampC = (x) => Math.max(1, Math.min(99, Math.round(x)));
const px = (n) => `$${(n / 100).toFixed(2)}`;
const am = (o) => (o == null ? '–' : S.fmt === 'cents' ? px(clampC(100 / dec(o))) : S.fmt === 'dec' ? dec(o).toFixed(2) : o > 0 ? `+${o}` : `${o}`);
const c100 = (p) => px(clampC(p * 100));
const fl = (l) => (l > 0 ? `+${l}` : l === 0 ? 'PK' : `${l}`);
const decToAm = (d) => (S.fmt === 'cents' ? px(clampC(100 / d)) : S.fmt === 'dec' ? d.toFixed(2) : d >= 2 ? `+${Math.round((d - 1) * 100)}` : `${Math.round(-100 / (d - 1))}`);
const boostFor = (n) => (n >= 7 ? 30 : n === 6 ? 25 : n === 5 ? 20 : n === 4 ? 15 : n === 3 ? 10 : 0);
const volFmt = (n) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : `$${Math.round(n)}`);
const until = (ts) => {
  const ms = ts - Date.now();
  if (ms <= 0) return 'closed';
  const m = ms / 60000;
  return m < 60 ? `${Math.ceil(m)}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};
const COLORS = ['#8c2f1b', '#1d5c8a', '#2f6b3c', '#6b3a7a', '#b07a12', '#37474f', '#a3365a', '#3d5a2a'];
const av = (name, color, small) => `<span class="av ${small ? 's' : ''}" style="background:${esc(color || COLORS[0])}">${esc((name || '?')[0])}</span>`;

// same LMSR pricing the server uses, so quotes match what you get
const lm = {
  cost: (y, n, b) => { const m = Math.max(y, n); return m + b * Math.log(Math.exp((y - m) / b) + Math.exp((n - m) / b)); },
  buy(m, side, spend) {
    const mine = side === 'yes' ? m.qy : m.qn, other = side === 'yes' ? m.qn : m.qy;
    const T = lm.cost(m.qy, m.qn, m.b) + spend;
    return (T - mine) + m.b * Math.log(1 - Math.exp((other - T) / m.b));
  },
  sell(m, side, sh) {
    const y = side === 'yes' ? m.qy - sh : m.qy, n = side === 'no' ? m.qn - sh : m.qn;
    return lm.cost(m.qy, m.qn, m.b) - lm.cost(y, n, m.b);
  },
};

let token = localStorage.getItem('cs_token');
const S = {
  tab: ((t) => (t === 'duels' ? 'social' : t || 'games'))(localStorage.getItem('cs_tab')), data: null, slip: [], mode: 'auto', stake: '', slipOpen: false,
  openGroups: new Set(), openGame: new Set(), betFilter: 'open', boardMode: 'all', social: 'feed', modal: null,
  authMode: 'login', color: COLORS[0], prevBets: null, sels: new Map(), busy: false,
  filter: 'all', q: '', fmt: localStorage.getItem('cs_fmt') || 'cents', theme: localStorage.getItem('cs_theme') || 'light', moved: new Map(),
  charts: {}, hist: {}, chartOpen: new Set(), newMarket: false, openMarket: null, mt: { side: 'yes', kind: 'buy', amt: '', pct: 0 }, showResults: false, net: null, range: 'all',
  pk: { lobby: null, id: null, view: null, at: 0, raise: '', stakes: '5/10', bots: 3, buyin: '', last: '' },
};
document.documentElement.dataset.theme = S.theme;

async function api(path, body) {
  const r = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { logout(true); throw Object.assign(new Error('Please log in'), { status: 401 }); }
  if (!r.ok) throw Object.assign(new Error(j.error || 'Something went wrong'), { status: r.status, data: j });
  return j;
}
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}
function logout(silent) {
  if (!silent && token) api('/api/logout', {}).catch(() => {});
  token = null; localStorage.removeItem('cs_token'); S.data = null; S.slip = []; S.modal = null; render();
}
const ago = (ts) => {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

// ---------- charts ----------
// Step chart of a probability over time. Hover is handled by one delegated listener below.
function chart(cid, pts, label, color) {
  S.charts[cid] = pts;
  if (!pts || !pts.length) return '';
  const t0 = pts[0][0], t1 = Math.max(pts[pts.length - 1][0], t0 + 1);
  const ps = pts.map((p) => p[1]);
  let lo = Math.max(0, Math.floor((Math.min(...ps) - 0.08) * 10) / 10), hi = Math.min(1, Math.ceil((Math.max(...ps) + 0.08) * 10) / 10);
  if (hi - lo < 0.3) { const mid = (hi + lo) / 2; lo = Math.max(0, mid - 0.15); hi = Math.min(1, lo + 0.3); lo = Math.max(0, hi - 0.3); }
  const X = (t) => ((t - t0) / (t1 - t0)) * 100, Y = (p) => ((hi - p) / (hi - lo)) * 100;
  let d = `M${X(pts[0][0]).toFixed(2)} ${Y(pts[0][1]).toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${X(pts[i][0]).toFixed(2)} V${Y(pts[i][1]).toFixed(2)}`;
  d += ' H100';
  const last = ps[ps.length - 1];
  const grid = [hi, (hi + lo) / 2, lo].map((v) => `<i class="gl" style="top:${Y(v)}%">${Math.round(v * 100)}%</i>`).join('');
  return `<div class="chart" data-cid="${esc(cid)}" data-lo="${lo}" data-hi="${hi}" data-lbl="${esc(label)}" data-def="${esc(label)} ${c100(last)}">
    <div class="cr">${esc(label)} <b>${c100(last)}</b></div>
    <div class="plot"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/><line class="cx" x1="-5" x2="-5" y1="0" y2="100" vector-effect="non-scaling-stroke"/></svg>${grid}</div>
    <div class="cax"><span>${new Date(t0).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span><span>${new Date(t1).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span></div></div>`;
}
const dateTime = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
document.addEventListener('pointermove', (ev) => {
  const c = ev.target.closest && ev.target.closest('.chart');
  if (!c) return;
  const d = S.charts[c.dataset.cid]; if (!d) return;
  const plot = $('.plot', c).getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (ev.clientX - plot.left) / plot.width));
  const cx = $('.cx', c); cx.setAttribute('x1', f * 100); cx.setAttribute('x2', f * 100);
  if (!Array.isArray(d)) { $('.cr', c).innerHTML = d.mr(d.t0 + f * (d.t1 - d.t0)); return; }
  const t0 = d[0][0], t1 = Math.max(d[d.length - 1][0], t0 + 1), t = t0 + f * (t1 - t0);
  let p = d[0][1]; for (const q of d) { if (q[0] <= t) p = q[1]; else break; }
  $('.cr', c).innerHTML = `${esc(c.dataset.lbl)} <b>${c100(p)}</b> <span>${dateTime(t)}</span>`;
});
document.addEventListener('pointerout', (ev) => {
  const c = ev.target.closest && ev.target.closest('.chart');
  if (!c || c.contains(ev.relatedTarget)) return;
  const d = S.charts[c.dataset.cid];
  const cx = $('.cx', c); cx.setAttribute('x1', -5); cx.setAttribute('x2', -5);
  if (d && !Array.isArray(d)) { $('.cr', c).innerHTML = d.mr(d.t1); return; }
  const v = d && d.length ? d[d.length - 1][1] : 0;
  $('.cr', c).innerHTML = `${esc(c.dataset.lbl)} <b>${c100(v)}</b>`;
});
// several series over time (net worth). Values are dollars.
function lineChart(cid, series, fmt = usd) {
  series = series.filter((x) => x.pts.length);
  if (!series.length) return '';
  const all = series.flatMap((x) => x.pts);
  const t0 = Math.min(...all.map((p) => p[0])), t1 = Math.max(Math.max(...all.map((p) => p[0])), t0 + 1);
  let lo = Math.min(...all.map((p) => p[1])), hi = Math.max(...all.map((p) => p[1]));
  const pad = Math.max((hi - lo) * 0.12, Math.abs(hi) * 0.01, 1); lo -= pad; hi += pad;
  const X = (t) => ((t - t0) / (t1 - t0)) * 100, Y = (v) => ((hi - v) / (hi - lo)) * 100;
  const valAt = (pts, t) => { let v = pts[0][1]; for (const q of pts) { if (q[0] <= t) v = q[1]; else break; } return v; };
  const mr = (t) => {
    if (series.length === 1) return `<b>${fmt(valAt(series[0].pts, t))}</b> <span>${dateTime(t)}</span>`;
    const rows = series.map((x) => ({ x, v: valAt(x.pts, t) })).sort((a, b) => b.v - a.v);
    return `<span>${dateTime(t)}</span>${rows.map((r) => `<em class="lg"><i style="background:${esc(r.x.color)}"></i>${esc(r.x.name)} <b>${fmt(r.v)}</b></em>`).join('')}`;
  };
  S.charts[cid] = { t0, t1, mr };
  const paths = series.map((x) => `<path d="${x.pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(2)} ${Y(p[1]).toFixed(2)}`).join(' ')} L100 ${Y(x.pts[x.pts.length - 1][1]).toFixed(2)}" fill="none" stroke="${esc(x.color)}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`).join('');
  const grid = [hi, (hi + lo) / 2, lo].map((v) => `<i class="gl" style="top:${Y(v)}%">${fmt(v)}</i>`).join('');
  const day = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `<div class="chart" data-cid="${esc(cid)}"><div class="cr">${mr(t1)}</div>
    <div class="plot"><svg viewBox="0 0 100 100" preserveAspectRatio="none">${paths}<line class="cx" x1="-5" x2="-5" y1="0" y2="100" vector-effect="non-scaling-stroke"/></svg>${grid}</div>
    <div class="cax"><span>${day(t0)}</span><span>${day(t1)}</span></div></div>`;
}
// profit and loss per day, as columns around a zero line
function barChart(days) {
  const maxP = Math.max(0, ...days.map((d) => d.v)), maxN = Math.max(0, ...days.map((d) => -d.v)), range = (maxP + maxN) || 1;
  const z = (maxN / range) * 100;
  return `<div class="bars" style="--z:${z}%">${days.map((d) => {
    const h = (Math.abs(d.v) / range) * 100;
    return `<div class="bar" title="${esc(d.label)}: ${d.v >= 0 ? '+' : '-'}${usd(Math.abs(d.v))}">${d.v ? `<i class="${d.v > 0 ? 'up' : 'dn'}" style="${d.v > 0 ? `bottom:${z}%` : `top:${100 - z}%`};height:${h}%"></i>` : ''}</div>`;
  }).join('')}<u class="zero" style="bottom:${z}%"></u></div>
    <div class="bax">${days.map((d, i) => `<span>${i % 2 === 0 || days.length < 8 ? esc(d.short) : ''}</span>`).join('')}</div>`;
}
// horizontal bars from a centre line, one per person
function hbars(rows) {
  const m = Math.max(1, ...rows.map((r) => Math.abs(r.v)));
  return `<div class="hb">${rows.map((r) => `<div class="hbr"><span class="hn">${esc(r.name)}</span><div class="ht"><i class="${r.v >= 0 ? 'up' : 'dn'}" style="${r.v >= 0 ? 'left:50%' : 'right:50%'};width:${(Math.abs(r.v) / m) * 50}%"></i></div><b class="${r.v >= 0 ? 'win' : 'loss'}">${r.v >= 0 ? '+' : '-'}${usd(Math.abs(r.v))}</b></div>`).join('')}</div>`;
}
async function loadNet() {
  try {
    const r = await api('/api/networth');
    if (JSON.stringify(S.net) !== JSON.stringify(r)) { S.net = r; lastTabHtml = ''; render(); }
  } catch (e) { /* ignore */ }
}

async function loadHist(id) {
  try {
    const r = await api(`/api/games/${id}/history`);
    if (JSON.stringify(S.hist[id]) !== JSON.stringify(r.points)) { S.hist[id] = r.points; lastTabHtml = ''; render(); }
  } catch (e) { /* ignore */ }
}

// ---------- data ----------
async function refresh(force) {
  if (!token) return;
  if (!force && document.hidden) return;
  try {
    const d = await api('/api/state');
    const prev = S.prevBets;
    S.prevBets = new Map(d.bets.map((b) => [b.id, b.status]));
    if (prev) for (const b of d.bets) {
      if (prev.get(b.id) === 'pending' && b.status === 'won') toast(`Bet won: +${usd(b.payout - b.stake)}`, 'good');
      else if (prev.get(b.id) === 'pending' && b.status === 'lost') toast(`Bet lost: -${usd(b.stake)}`, 'bad');
    }
    S.data = d;
    const oldSels = S.sels;
    S.sels = new Map();
    for (const g of d.games) for (const gr of g.groups) {
      const add = (s) => s && S.sels.set(s.key, { ...s, matchup: `${g.away.abbr} @ ${g.home.abbr}` });
      if (gr.kind === 'main') [...gr.spread, ...gr.total, ...gr.ml].forEach(add);
      else if (gr.kind === 'pairs') gr.rows.forEach((r) => { add(r.left); add(r.right); });
      else if (gr.kind === 'grid') gr.sels.forEach(add);
      else gr.rows.forEach((r) => { add(r.over); add(r.under); });
    }
    S.moved = new Map();
    for (const [k, s] of S.sels) { const o = oldSels.get(k); if (o && o.odds !== s.odds) S.moved.set(k, dec(s.odds) > dec(o.odds) ? 'up' : 'dn'); }
    syncSlip();
    render();
    for (const id of S.chartOpen) loadHist(id);
    if (S.tab === 'bets' || S.tab === 'board') loadNet();
    if (S.tab === 'poker' && !S.pk.lobby) loadLobby();
  } catch (e) { if (e.status !== 401) console.warn(e); }
}
function syncSlip() {
  S.slip = S.slip.filter((l) => {
    const cur = S.sels.get(l.key);
    if (!cur) { toast(`"${l.label}" is no longer available`, 'bad'); return false; }
    if (cur.odds !== l.odds) { l.flash = true; l.old = l.odds; l.odds = cur.odds; }
    return true;
  });
}

// ---------- auth ----------
function authView() {
  const join = S.authMode === 'join';
  return `<div class="auth">
    <div class="logo big">Courtside</div>
    <p>NBA lines and friend markets. Play money.</p>
    <div class="card"><div class="seg block auth-sw"><button class="${!join ? 'on' : ''}" data-act="authmode" data-v="login">Log in</button><button class="${join ? 'on' : ''}" data-act="authmode" data-v="join">Join</button></div>
    <form id="authform">
      <div class="field"><label>Username</label><input name="username" autocomplete="username" autocapitalize="off" maxlength="16" required></div>
      <div class="field"><label>PIN or password</label><input name="pin" type="password" autocomplete="${join ? 'new-password' : 'current-password'}" required></div>
      ${join ? `<div class="field"><label>Invite code</label><input name="code" autocapitalize="characters" required></div>
      <div class="field"><label>Color</label><div class="swatches">${COLORS.map((c) => `<button type="button" data-act="color" data-v="${c}" class="${S.color === c ? 'on' : ''}" style="background:${c}" aria-label="color"></button>`).join('')}</div></div>` : ''}
      <div class="err" id="autherr"></div>
      <button class="btn">${join ? 'Join with $10,000' : 'Log in'}</button>
    </form></div>
  </div>`;
}

// ---------- sports ----------
function dayLabel(ms) {
  const d = new Date(ms), t = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, t)) return 'Today';
  if (same(d, new Date(t.getTime() + 86400000))) return 'Tomorrow';
  if (same(d, new Date(t.getTime() - 86400000))) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}
const inSlip = (k) => S.slip.some((l) => l.key === k);
const mvCls = (k) => (S.moved.has(k) ? 'mv-' + S.moved.get(k) : '');
const lumOf = (hex) => { const n = parseInt(String(hex).slice(1), 16) || 0; return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
function cell(s, kind, color) {
  if (!s) return `<button class="cell na"><span class="o">–</span></button>`;
  const top = kind === 'spread' ? `<span class="l">${fl(s.line)}</span>` : kind === 'total' ? `<span class="l">${s.sel === 'over' ? 'O' : 'U'} ${s.line}</span>` : '';
  return `<button class="cell ${kind === 'ml' ? 'ml' : ''} ${inSlip(s.key) ? 'on' : ''} ${mvCls(s.key)}" ${color && kind === 'ml' ? `style="--tc:${esc(color)};--tf:${lumOf(color) > 0.65 ? '#1d2b39' : '#fff'}"` : ''} data-act="pick" data-key="${esc(s.key)}">${top}<span class="o">${am(s.odds)}</span></button>`;
}
const opt = (s) => (s ? `<button class="opt ${inSlip(s.key) ? 'on' : ''} ${mvCls(s.key)}" data-act="pick" data-key="${esc(s.key)}"><span>${esc(s.label)}</span><span class="o">${am(s.odds)}</span></button>` : '');
function gameStatus(g) {
  if (g.state === 'in') return `<span><span class="live">Live</span> ${esc(g.status_detail)}</span>`;
  if (g.state === 'post') return `<span>Final</span>`;
  if (g.state === 'void') return `<span>Postponed</span>`;
  return `<span>${new Date(g.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>`;
}
function chartPanel(g) {
  const pts = S.hist[g.id];
  if (!pts) return `<div class="chart-load">Loading chart</div>`;
  return `<div class="chartbox">${chart(`g${g.id}`, pts, `${g.home.abbr} to win`, g.home.color || 'var(--fg)')}<div class="note">Win probability since the market opened. It moves with the line and, once the game starts, the score.</div></div>`;
}
function gameCard(g) {
  const main = g.groups.find((x) => x.kind === 'main');
  const showScore = g.state === 'in' || g.state === 'post';
  const lead = g.home.score > g.away.score ? 'home' : 'away';
  const team = (t, side) => `<div class="tm"><img src="${esc(t.logo)}" alt=""><div class="n"><b>${esc(t.abbr)}</b><small>${esc(t.record)}</small></div>${showScore ? `<span class="sc ${lead === side ? '' : 'dim'}">${t.score}</span>` : ''}</div>`;
  const right = g.state === 'pre' ? `${esc(g.lines_src)} lines` : g.state === 'in' && main ? 'Live odds' : '';
  let rows;
  if (main) {
    rows = `<div class="g-row">${team(g.away, 'away')}${cell(main.spread[0], 'spread')}${cell(main.total[0], 'total')}${cell(main.ml[0], 'ml', g.away.color)}</div>
            <div class="g-row">${team(g.home, 'home')}${cell(main.spread[1], 'spread')}${cell(main.total[1], 'total')}${cell(main.ml[1], 'ml', g.home.color)}</div>`;
  } else {
    rows = `<div class="g-row">${team(g.away, 'away')}<div class="closed" style="grid-row:span 2">${g.state === 'pre' ? 'Betting closed' : g.state === 'in' ? 'Live betting paused' : ''}</div></div><div class="g-row">${team(g.home, 'home')}</div>`;
  }
  const more = g.groups.filter((x) => x.kind !== 'main');
  const open = S.openGame.has(g.id), chartOn = S.chartOpen.has(g.id);
  const groupsHtml = open ? more.map((gr) => {
    const k = `${g.id}:${gr.id}`, o = S.openGroups.has(k);
    let inner = '';
    if (o) {
      if (gr.kind === 'pairs') inner = `<div class="opts"><span class="opt-h">${esc(gr.leftName)}</span><span class="opt-h">${esc(gr.rightName)}</span></div>` + gr.rows.map((r) => `<div class="opts">${opt(r.left)}${opt(r.right)}</div>`).join('');
      else if (gr.kind === 'grid') inner = `<div class="grid4">${gr.sels.map(opt).join('')}</div>`;
      else inner = gr.rows.map((r) => `<div class="prop"><div class="pl">${r.p.headshot ? `<img src="${esc(r.p.headshot)}" alt="">` : '<span class="av s" style="background:#999"></span>'}<div style="min-width:0"><b>${esc(r.p.name)}</b><small>${esc(r.p.team)} · ${r.p.stat} · avg ${r.p.avg}</small></div></div>
        <button class="opt ${inSlip(r.over.key) ? 'on' : ''}" data-act="pick" data-key="${esc(r.over.key)}"><span>O ${r.p.line}</span><span class="o">${am(r.over.odds)}</span></button>
        <button class="opt ${inSlip(r.under.key) ? 'on' : ''}" data-act="pick" data-key="${esc(r.under.key)}"><span>U ${r.p.line}</span><span class="o">${am(r.under.odds)}</span></button></div>`).join('');
    }
    return `<div class="grp"><button class="grp-h" data-act="grp" data-k="${k}"><span>${esc(gr.title)}</span><span>${o ? '−' : '+'}</span></button>${o ? `<div class="grp-b">${inner}</div>` : ''}</div>`;
  }).join('') : '';
  return `<article class="game" id="g-${g.id}"><div class="g-meta"><span>${gameStatus(g)}${g.volume ? `<span class="vol">${volFmt(g.volume)} Vol</span>` : ''}</span><span>${right}</span></div>
    ${main ? '<div class="g-row head"><span></span><span>Spread</span><span>Total</span><span>Money</span></div>' : ''}
    ${rows}
    <div class="morerow">${g.state !== 'void' ? `<button class="more" data-act="chart" data-id="${g.id}">${chartOn ? 'Hide chart' : 'Chart'}</button>` : ''}${more.length ? `<button class="more" data-act="game" data-id="${g.id}">${open ? 'Hide extra markets' : 'Alt lines, margin, props'}</button>` : ''}</div>
    ${chartOn ? chartPanel(g) : ''}${groupsHtml}</article>`;
}
// scoreboard tape under the nav
function ticker() {
  const today = (g) => dayLabel(g.start) === 'Today';
  const gs = S.data.games.filter((g) => g.state === 'in' || (g.state !== 'void' && today(g)));
  gs.sort((a, b) => (b.state === 'in') - (a.state === 'in') || (a.state === 'post') - (b.state === 'post') || a.start - b.start);
  if (!gs.length) return '';
  return `<div class="tape">${gs.slice(0, 16).map((g) => {
    const sc = g.state !== 'pre';
    const st = g.state === 'in' ? `<em class="live">${esc(g.status_detail)}</em>` : g.state === 'post' ? '<em>Final</em>' : `<em>${new Date(g.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</em>`;
    return `<button data-act="jump" data-id="${g.id}"><span>${esc(g.away.abbr)} <b>${sc ? g.away.score : ''}</b></span><span>${esc(g.home.abbr)} <b>${sc ? g.home.score : ''}</b></span>${st}</button>`;
  }).join('')}</div>`;
}
function filtersBar() {
  const live = S.data.games.filter((g) => g.state === 'in').length;
  const tabs = [['all', 'All'], ['live', `Live${live ? ` ${live}` : ''}`], ['today', 'Today'], ['tomorrow', 'Tomorrow']];
  return `<div class="filters"><div class="subtabs">${tabs.map(([k, l]) => `<button class="${S.filter === k ? 'on' : ''}" data-act="filter" data-v="${k}">${l}</button>`).join('')}</div>
    <input id="gsearch" class="search" type="search" placeholder="Search teams" value="${esc(S.q)}" autocomplete="off"></div>`;
}
function gamesTab() {
  if (!S.data.games.length) return `<div class="empty">No NBA games found yet.${S.data.sync.err ? `<br><small>Data feed: ${esc(S.data.sync.err)}</small>` : ' Fetching the schedule.'}</div>`;
  return ticker() + filtersBar() + `<div id="glist">${gameList()}</div>`;
}
function gameList() {
  const q = S.q.trim().toLowerCase();
  const gs = S.data.games.filter((g) => {
    if (S.filter === 'live' && g.state !== 'in') return false;
    if (S.filter === 'today' && !(g.state === 'in' || dayLabel(g.start) === 'Today')) return false;
    if (S.filter === 'tomorrow' && dayLabel(g.start) !== 'Tomorrow') return false;
    return !q || [g.home.abbr, g.home.name, g.away.abbr, g.away.name].join(' ').toLowerCase().includes(q);
  });
  if (!gs.length) return `<div class="empty">No games match.</div>`;
  let html = '', lastDay = '';
  const live = gs.filter((g) => g.state === 'in'), upcoming = gs.filter((g) => g.state === 'pre' || g.state === 'void');
  const done = gs.filter((g) => g.state === 'post').reverse();
  const order = [...live.map((g) => ({ g, day: 'In progress' })), ...upcoming.map((g) => ({ g, day: dayLabel(g.start) }))];
  for (const { g, day } of order) {
    if (day !== lastDay) { html += `<div class="day">${esc(day)}</div>`; lastDay = day; }
    html += gameCard(g);
  }
  if (done.length) {
    html += `<div class="day"><button class="link" data-act="results">${S.showResults ? 'Hide' : 'Show'} recent results (${done.length})</button></div>`;
    if (S.showResults) html += done.map(gameCard).join('');
  }
  return html;
}

// ---------- slip ----------
function slipCalc() {
  const n = S.slip.length;
  const conflict = (() => { const seen = {}; for (const l of S.slip) { const k = `${l.game_id}|${l.family}`; if (seen[k]) return true; seen[k] = 1; } return false; })();
  const mode = S.mode === 'auto' ? (n > 1 && !conflict ? 'parlay' : 'singles') : (S.mode === 'parlay' && n < 2 ? 'singles' : S.mode);
  const stake = Math.floor(Number(String(S.stake).replace(/,/g, ''))) || 0;
  let total, win = 0, pdec = 1, boost = 0;
  if (mode === 'parlay') {
    pdec = S.slip.reduce((a, l) => a * dec(l.odds), 1); boost = boostFor(n);
    win = stake * (pdec - 1) * (1 + boost / 100); total = stake;
  } else { win = S.slip.reduce((a, l) => a + stake * (dec(l.odds) - 1), 0); total = stake * n; }
  return { n, conflict, mode, stake, total, win, pdec, boost };
}
function slipRows(c) {
  if (!c.stake || !(c.mode === 'parlay' || c.n === 1)) return '';
  const payout = c.stake + c.win;
  return `<div class="sum"><span>Avg price</span><b>${px(clampC((c.stake / payout) * 100))}</b></div><div class="sum"><span>Shares</span><b>${money(payout)}</b></div><div class="sum"><span>Payout if it hits</span><b>${usd(payout)}</b></div>`;
}
function slipView() {
  const d = S.data, c = slipCalc();
  const legName = (l) => (l.key.endsWith('|alt') ? 'Alt ' : '') + ({ spread: 'spread', total: 'total', ml: 'moneyline', margin: 'winning margin', prop: 'player prop' }[l.market] || '') + (l.live ? ' (live)' : '');
  if (!c.n) return `<section class="ticket"><h3><span>Bet slip</span></h3><div class="none">Pick any price to start a slip. Three or more legs in a parlay get a profit boost.</div></section>`;
  const quick = [[100, '+100'], [500, '+500'], [1000, '+1K'], [2500, '+2.5K']].map(([v, t]) => `<button class="qk" data-act="stake" data-v="${v}">${t}</button>`).join('') + `<button class="qk" data-act="stake" data-v="max">Max</button>`;
  const nextBoost = c.mode === 'parlay' && c.n < 7 ? boostFor(c.n + 1) : 0;
  return `<section class="ticket"><h3><span>Bet slip (${c.n})</span><button class="link" data-act="clear">Clear</button></h3>
    ${c.n > 1 ? `<div class="seg block" style="margin:12px 0 0"><button class="${c.mode === 'singles' ? 'on' : ''}" data-act="mode" data-v="singles">Singles</button><button class="${c.mode === 'parlay' ? 'on' : ''}" data-act="mode" data-v="parlay" ${c.conflict ? 'disabled' : ''}>Parlay</button></div>` : ''}
    ${c.conflict && c.n > 1 ? `<div class="note warn">Two of these picks are the same market in one game, so they can only go in as singles.</div>` : ''}
    ${S.slip.map((l) => `<div class="leg ${l.flash ? 'flash' : ''}"><div class="t"><b>${esc(l.label)}</b><small>${legName(l)} · ${esc(l.matchup)}</small></div><div class="o">${l.old != null && l.old !== l.odds ? `<s>${am(l.old)}</s>` : ''}${am(l.odds)}</div><button class="x" data-act="rm" data-key="${esc(l.key)}" aria-label="Remove">×</button></div>`).join('')}
    <div class="field"><label>${c.mode === 'parlay' ? 'Amount' : c.n > 1 ? 'Amount per bet' : 'Amount'}</label><input id="stake" inputmode="numeric" placeholder="$0" value="${esc(S.stake)}" autocomplete="off"></div>
    <div class="chips">${quick}</div>
    ${c.mode === 'parlay' ? `<div class="sum"><span>Parlay price</span><b>${decToAm(c.pdec)}</b></div><div class="note">${c.boost ? `Parlay boost +${c.boost}% on winnings${nextBoost ? `. One more leg makes it +${nextBoost}%.` : '.'}` : 'A third leg adds a +10% boost.'}</div>` : ''}
    <div id="s-rows">${slipRows(c)}</div>
    <div class="sum"><span>Total</span><b id="s-total">${usd(c.total)}</b></div>
    <div class="sum big"><span>To win</span><b id="s-win">${usd(c.win)}</b></div>
    ${c.total > d.me.balance ? `<div class="note warn">Not enough cash (${usd(d.me.balance)}).</div>` : ''}
    <div style="margin-top:12px"><button class="btn" data-act="place" ${S.busy || !c.stake || c.total > d.me.balance ? 'disabled' : ''}>Place ${c.mode === 'parlay' ? 'parlay' : c.n > 1 ? `${c.n} bets` : 'bet'}</button></div>
    ${S.slip.some((l) => l.live) ? `<div class="note">Live bets are capped at ${usd(d.config.max_live)}. Prices move with the score.</div>` : ''}
  </section>`;
}
function renderSlip() {
  const el = $('#slip');
  if (!el || !S.data) return;
  const keep = document.activeElement && document.activeElement.id === 'stake';
  const pos = keep ? document.activeElement.selectionStart : 0;
  el.innerHTML = slipView();
  const bar = $('#slipbar');
  if (bar) {
    const c = slipCalc();
    bar.style.display = c.n && !S.slipOpen ? '' : 'none';
    bar.innerHTML = `<span>Bet slip (${c.n})</span><span>${c.stake ? `To win ${usd(c.win)}` : c.mode === 'parlay' && c.n > 1 ? `Parlay ${decToAm(c.pdec)}` : ''}</span>`;
  }
  el.classList.toggle('open', S.slipOpen);
  const sc = $('#scrim'); if (sc) sc.style.display = S.slipOpen ? '' : 'none';
  if (keep) { const i = $('#stake'); i.focus(); i.setSelectionRange(pos, pos); }
}
function updateSlipTotals() {
  const c = slipCalc();
  const t = $('#s-total'), w = $('#s-win'), r = $('#s-rows'); if (t) t.textContent = usd(c.total); if (w) w.textContent = usd(c.win); if (r) r.innerHTML = slipRows(c);
  const b = $('.ticket .btn[data-act=place]'); if (b) b.disabled = S.busy || !c.stake || c.total > S.data.me.balance;
}

// ---------- markets (friend yes/no questions) ----------
function newMarketForm() {
  return `<form id="mkform" class="card"><div class="field"><label>Question</label><input name="question" maxlength="140" placeholder="Will Oliver be late to Friday's game?" required></div>
    <div class="field"><label>Details (optional)</label><input name="detail" maxlength="300" placeholder="How it resolves"></div>
    <div class="two"><div class="field"><label>Trading closes in</label><select name="hours"><option value="1">1 hour</option><option value="6">6 hours</option><option value="24" selected>1 day</option><option value="72">3 days</option><option value="168">1 week</option><option value="720">30 days</option></select></div>
    <div class="field"><label>&nbsp;</label><button class="btn">Create market</button></div></div>
    <div class="note">You settle this market when it ends. Price starts at $0.50.</div></form>`;
}
function quote(m) {
  const t = S.mt, side = t.side;
  if (t.kind === 'buy') {
    const amt = Math.floor(Number(t.amt)) || 0;
    if (amt < 10) return { ok: false };
    const sh = lm.buy(m, side, amt);
    return { ok: true, amt, sh, avg: amt / sh, payout: sh, ret: (sh - amt) / amt };
  }
  const sh = m.mine[side] * (t.pct / 100);
  if (!(sh > 0)) return { ok: false };
  return { ok: true, sh, get: Math.floor(lm.sell(m, side, sh)) };
}
function quoteHtml(m) {
  const q = quote(m), S2 = S.mt.side.toUpperCase();
  if (!q.ok) return `<div class="note">${S.mt.kind === 'buy' ? 'Enter an amount of at least $10.' : 'Choose how much to sell.'}</div>`;
  if (S.mt.kind === 'buy') return `<div class="sum"><span>Avg price</span><b>${px(clampC(q.avg * 100))}</b></div><div class="sum"><span>Shares</span><b>${money(q.sh)}</b></div><div class="sum"><span>Payout if ${S2}</span><b class="win">${usd(q.payout)}</b></div><div class="sum"><span>Return</span><b class="win">+${Math.round(q.ret * 100)}%</b></div>`;
  return `<div class="sum"><span>Shares sold</span><b>${money(q.sh)}</b></div><div class="sum"><span>You receive</span><b class="win">${usd(q.get)}</b></div>`;
}
function tradeBtnState(m) {
  const q = quote(m);
  return !q.ok || (S.mt.kind === 'buy' && q.amt > S.data.me.balance) || S.busy;
}
function tradePanel(m) {
  const t = S.mt, side = t.side, py = m.p, pn = 1 - m.p;
  const closed = m.close_ts <= Date.now();
  const mine = m.mine;
  const me = S.data.me;
  const canResolve = m.creator.id === me.id || me.is_admin;
  const pos = mine.yes > 0.01 || mine.no > 0.01 ? `<div class="pos"><b>Your position</b>${mine.yes > 0.01 ? `<span>${money(mine.yes)} Yes · worth ${usd(mine.yes * py)}</span>` : ''}${mine.no > 0.01 ? `<span>${money(mine.no)} No · worth ${usd(mine.no * pn)}</span>` : ''}<span class="faint">Net cost ${usd(mine.spent)}</span></div>` : '';
  const resolve = canResolve ? `<div class="resolve"><span>Settle this market</span><div><button class="btn sm line" data-act="mresolve" data-id="${m.id}" data-v="yes">Yes</button><button class="btn sm line" data-act="mresolve" data-id="${m.id}" data-v="no">No</button><button class="btn sm line" data-act="mresolve" data-id="${m.id}" data-v="void">Void</button></div></div>` : '';
  const pts = chart(`m${m.id}`, m.pts, 'Yes', 'var(--yes)');
  let body;
  if (closed) body = `<div class="note">Trading is closed. ${canResolve ? 'Settle it below.' : `Waiting for ${esc(m.creator.username)} or the commissioner to settle it.`}</div>`;
  else {
    const have = mine[side] > 0.01;
    body = `<div class="tk-tabs"><button class="${t.kind === 'buy' ? 'on' : ''}" data-act="mkind" data-v="buy">Buy</button><button class="${t.kind === 'sell' ? 'on' : ''}" data-act="mkind" data-v="sell">Sell</button></div>
      <div class="yn"><button class="yes ${side === 'yes' ? 'on' : ''}" data-act="mside" data-v="yes">Yes ${c100(py)}</button><button class="no ${side === 'no' ? 'on' : ''}" data-act="mside" data-v="no">No ${c100(pn)}</button></div>
      ${t.kind === 'buy' ? `<div class="field"><label>Amount</label><input id="mamt" inputmode="numeric" placeholder="$0" value="${t.amt ? money(Number(t.amt)) : ''}" autocomplete="off"></div>
        <div class="chips">${[[10, '+10'], [50, '+50'], [100, '+100'], [500, '+500']].map(([v, l]) => `<button class="qk" data-act="mquick" data-v="${v}">${l}</button>`).join('')}<button class="qk" data-act="mquick" data-v="max">Max</button></div>`
      : have ? `<div class="chips" style="margin-top:12px">${[25, 50, 100].map((p) => `<button class="qk ${t.pct === p ? 'on' : ''}" data-act="mpct" data-v="${p}">${p === 100 ? 'All' : p + '%'}</button>`).join('')}</div><div class="note">You hold ${money(mine[side])} ${side.toUpperCase()} shares.</div>` : `<div class="note">You don't hold any ${side.toUpperCase()} shares.</div>`}
      <div id="mquote">${quoteHtml(m)}</div>
      <button class="btn ${side}" id="mgo" data-act="mtrade" ${tradeBtnState(m) ? 'disabled' : ''}>${t.kind === 'buy' ? 'Buy' : 'Sell'} ${side === 'yes' ? 'Yes' : 'No'}</button>`;
  }
  return `<div class="mk-panel">${m.detail ? `<p class="mk-d">${esc(m.detail)}</p>` : ''}<div class="chartbox">${pts}</div>${pos}<div class="trade">${body}</div>${resolve}</div>`;
}
function gauge(p) {
  const v = Math.max(0.01, Math.min(0.99, p)), th = Math.PI * (1 - v);
  const x = (22 + 18 * Math.cos(th)).toFixed(2), y = (22 - 18 * Math.sin(th)).toFixed(2);
  return `<div class="gauge"><svg viewBox="0 0 44 26" aria-hidden="true"><path d="M4 22A18 18 0 0 1 40 22" class="gb"/><path d="M4 22A18 18 0 0 1 ${x} ${y}" class="gf ${p >= 0.5 ? 'hi' : 'lo'}"/></svg><b>${Math.round(p * 100)}%</b><small>chance</small></div>`;
}
function marketCard(m) {
  const open = m.status === 'open', isOpen = S.openMarket === m.id;
  const closed = m.close_ts <= Date.now();
  const result = !open ? `<span class="res ${m.outcome}">${m.status === 'void' ? 'Voided' : `Resolved ${m.outcome === 'yes' ? 'Yes' : 'No'}`}</span>` : '';
  const sub = `${esc(m.creator.username)} · ${open ? (closed ? 'trading closed' : `closes in ${until(m.close_ts)}`) : ago(m.created_at)} · ${volFmt(m.volume)} Vol · ${m.traders} trader${m.traders === 1 ? '' : 's'}`;
  const mine = m.mine;
  const held = !open && (mine.yes > 0.01 || mine.no > 0.01) ? `<div class="note">You held ${mine.yes > 0.01 ? `${money(mine.yes)} Yes ` : ''}${mine.no > 0.01 ? `${money(mine.no)} No` : ''}.</div>` : '';
  return `<article class="mk ${isOpen ? 'open' : ''}" id="m-${m.id}">
    <button class="mk-top" data-act="mopen" data-id="${m.id}">${av(m.creator.username, m.creator.avatar)}<div class="mk-q"><b>${esc(m.question)}</b><small>${sub}</small></div>${open ? gauge(m.p) : result}</button>
    ${open ? `<div class="yn"><button class="yes" data-act="mbuy" data-id="${m.id}" data-side="yes">Yes ${c100(m.p)}</button><button class="no" data-act="mbuy" data-id="${m.id}" data-side="no">No ${c100(1 - m.p)}</button></div>` : held}
    ${isOpen && open ? tradePanel(m) : ''}</article>`;
}
function marketsTab() {
  const ms = S.data.markets;
  const open = ms.filter((m) => m.status === 'open'), done = ms.filter((m) => m.status !== 'open');
  return `<div class="tabhead"><h2>Markets</h2><button class="btn sm" data-act="mnew">${S.newMarket ? 'Cancel' : 'New market'}</button></div>
    ${S.newMarket ? newMarketForm() : ''}
    ${open.length ? open.map(marketCard).join('') : `<div class="empty">No open markets.</div>`}
    ${done.length ? `<div class="sect">Recently resolved</div>${done.map(marketCard).join('')}` : ''}`;
}
async function tradeMarketAct() {
  const m = S.data.markets.find((x) => x.id === S.openMarket);
  if (!m || S.busy) return;
  const q = quote(m); if (!q.ok) return;
  S.busy = true;
  try {
    const kind = S.mt.kind, side = S.mt.side;
    const r = await api(`/api/markets/${m.id}/trade`, kind === 'buy' ? { side, kind, amount: q.amt, min_shares: q.sh } : { side, kind, shares: q.sh });
    toast(kind === 'buy' ? `Bought ${money(r.shares)} ${side.toUpperCase()} shares` : `Sold for ${usd(r.amount)}`, 'good');
    S.mt.amt = ''; S.mt.pct = 0;
  } catch (e) { toast(e.message, 'bad'); }
  S.busy = false; lastTabHtml = ''; await refresh(true);
}
function updateQuote() {
  const m = S.data.markets.find((x) => x.id === S.openMarket); if (!m) return;
  const q = $('#mquote'); if (q) q.innerHTML = quoteHtml(m);
  const b = $('#mgo'); if (b) b.disabled = tradeBtnState(m);
}

// ---------- portfolio ----------
function netSection(meId, mine) {
  const u = S.net && S.net.users.find((x) => x.id === meId);
  if (!u) return '';
  let pts = u.pts.concat([[Date.now(), mine.net]]);
  const span = { '1d': 864e5, '1w': 6048e5 }[S.range];
  if (span) { const f = pts.filter((p) => p[0] >= Date.now() - span); pts = f.length >= 2 ? f : pts.slice(-2); }
  const rng = [['1d', '1D'], ['1w', '1W'], ['all', 'All']];
  return `<div class="sect hd"><span>Net worth</span><span class="rng">${rng.map(([k, l]) => `<button class="${S.range === k ? 'on' : ''}" data-act="range" data-v="${k}">${l}</button>`).join('')}</span></div>${lineChart('nw', [{ name: 'You', color: 'var(--fg)', pts }])}`;
}
function plSection(bets) {
  const done = bets.filter((b) => b.status !== 'pending' && b.settled_at);
  if (!done.length) return '';
  const days = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i * 864e5); days.push({ key: d.toDateString(), label: d.toLocaleDateString([], { month: 'short', day: 'numeric' }), short: String(d.getDate()), v: 0 }); }
  for (const b of done) { const d = days.find((x) => x.key === new Date(b.settled_at).toDateString()); if (d) d.v += b.payout - b.stake; }
  const wins = done.filter((b) => b.status === 'won').length, losses = done.filter((b) => b.status === 'lost').length;
  const staked = done.reduce((a, b) => a + b.stake, 0), profit = done.reduce((a, b) => a + b.payout - b.stake, 0);
  const best = Math.max(...done.map((b) => b.payout - b.stake));
  return `<div class="sect">Profit by day</div>${barChart(days)}
    <div class="note">${done.length} settled · ${wins}-${losses}${wins + losses ? ` · ${Math.round((wins / (wins + losses)) * 100)}% win rate` : ''} · ROI ${profit >= 0 ? '+' : ''}${staked ? ((profit / staked) * 100).toFixed(1) : '0.0'}% · best ${usd(Math.max(0, best))}</div>`;
}
function betsTab() {
  const all = S.data.bets, me = S.data.me;
  const mine = S.data.board.find((u) => u.id === me.id) || { net: me.balance, profit: 0 };
  const openB = all.filter((b) => b.status === 'pending'), done = all.filter((b) => b.status !== 'pending');
  const list = S.betFilter === 'open' ? openB : done;
  const mpos = S.data.markets.filter((m) => m.status === 'open' && (m.mine.yes > 0.01 || m.mine.no > 0.01));
  const mark = { won: 'W', lost: 'L', push: 'P', void: 'P', pending: '' };
  const card = (b) => {
    const label = b.type === 'parlay' ? `${b.legs.length}-leg parlay${b.boost ? `, +${b.boost}% boost` : ''}` : 'Single';
    return `<div class="bet"><div class="bet-h"><span><b>${label}</b> <span class="faint">${decToAm(b.odds)}</span></span><span class="tag ${b.status}">${b.status}</span></div>
      ${b.legs.map((l) => `<div class="bleg"><span class="m ${l.status}">${mark[l.status] || ''}</span><div class="t">${esc(l.label)}${l.live ? ' <span class="faint">(live bet)</span>' : ''}<small>${esc(l.matchup)}${l.game && l.game.state !== 'pre' ? ` · ${l.game.a} ${l.game.as}, ${l.game.h} ${l.game.hs} (${esc(l.game.status_detail)})` : ''}${l.win_prob != null && l.status === 'pending' ? ` · ${Math.round(l.win_prob * 100)}% to hit` : ''}</small></div><div class="o">${am(l.odds)}</div></div>`).join('')}
      <div class="bet-f"><div>Cost <span class="mono">${usd(b.stake)}</span>${b.status === 'pending' ? `<br>Pays <span class="mono win">${usd(b.potential)}</span>` : b.status === 'won' || b.status === 'cashed' ? `<br>Paid <span class="mono win">${usd(b.payout)}</span>` : ''}</div>
      ${b.status === 'pending' && b.cashout ? `<button class="btn sm line" data-act="cashout" data-id="${b.id}" data-v="${b.cashout}">Sell for ${usd(b.cashout)}</button>` : ''}</div></div>`;
  };
  const mcard = (m) => `<div class="bet"><div class="bet-h"><span><b>${esc(m.question)}</b></span><span class="faint">${Math.round(m.p * 100)}% chance</span></div>
    <div class="bet-f"><div>${m.mine.yes > 0.01 ? `<span class="mono">${money(m.mine.yes)}</span> Yes · worth <span class="mono win">${usd(m.mine.yes * m.p)}</span>` : ''}${m.mine.yes > 0.01 && m.mine.no > 0.01 ? '<br>' : ''}${m.mine.no > 0.01 ? `<span class="mono">${money(m.mine.no)}</span> No · worth <span class="mono win">${usd(m.mine.no * (1 - m.p))}</span>` : ''}</div>
    <button class="btn sm line" data-act="gomarket" data-id="${m.id}">Trade</button></div></div>`;
  const stats = `<dl class="stats"><div><dt>Portfolio</dt><dd>${usd(mine.net)}</dd></div><div><dt>Cash</dt><dd>${usd(me.balance)}</dd></div><div><dt>In positions</dt><dd>${usd(Math.max(0, mine.net - me.balance))}</dd></div><div><dt>Profit</dt><dd class="${mine.profit >= 0 ? 'win' : 'loss'}">${mine.profit >= 0 ? '+' : '-'}${usd(Math.abs(mine.profit))}</dd></div></dl>`;
  const empty = S.betFilter === 'open' ? 'No open positions.' : 'Nothing settled yet.';
  const charts = netSection(me.id, mine) + plSection(all);
  const items = (S.betFilter === 'open' ? mpos.map(mcard) : []).concat(list.map(card));
  return `${stats}${charts}<div class="seg"><button class="${S.betFilter === 'open' ? 'on' : ''}" data-act="betfilter" data-v="open">Open (${openB.length + mpos.length})</button><button class="${S.betFilter === 'done' ? 'on' : ''}" data-act="betfilter" data-v="done">Settled (${done.length})</button></div>
    ${items.length ? items.join('') : `<div class="empty">${empty}</div>`}`;
}

// ---------- duels ----------
function duelsTab() {
  const d = S.data, me = d.me;
  const games = d.games.filter((g) => g.state === 'pre' && g.bettable);
  const friends = d.board.filter((u) => u.id !== me.id);
  const create = `<div class="card" style="margin-top:16px"><b>New duel</b>
    <div class="mid" style="margin:4px 0 4px;font-size:14px">Take a side against the spread and put money up. Anyone, or just the friend you name, can take the other side. Winner takes the pot; a push refunds both.</div>
    ${games.length ? `<form id="duelform"><div class="two"><div class="field"><label>Game</label><select name="game_id">${games.map((g) => `<option value="${g.id}">${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</option>`).join('')}</select></div>
    <div class="field"><label>Your side</label><select name="side"></select></div></div>
    <div class="two"><div class="field"><label>Amount</label><input name="stake" inputmode="numeric" value="500"></div>
    <div class="field"><label>Challenge</label><select name="target"><option value="">Anyone</option>${friends.map((f) => `<option>${esc(f.username)}</option>`).join('')}</select></div></div>
    <div style="margin-top:14px"><button class="btn">Post duel</button></div></form>` : '<div class="mid" style="margin-top:10px">No games open for betting right now.</div>'}</div>`;
  const nm = (u) => (u ? esc(u.username) : 'Open');
  const row = (x) => {
    const mine = x.creator_id === me.id || x.opponent_id === me.id;
    const status = { open: 'waiting', active: 'locked in', done: 'settled', push: 'push', cancelled: 'cancelled' }[x.status];
    let action = '';
    if (x.status === 'open' && x.creator_id === me.id) action = `<button class="link" data-act="duelcancel" data-id="${x.id}">Cancel and refund</button>`;
    else if (x.status === 'open' && (!x.target_id || x.target_id === me.id)) action = `<button class="btn sm" data-act="duelaccept" data-id="${x.id}">Take it for ${usd(x.stake)}</button>`;
    const result = x.status === 'done' ? (x.winner_id === me.id ? '<b class="win">You won</b>' : mine ? '<b class="loss">You lost</b>' : `<b>${x.winner_id === x.creator_id ? nm(x.creator) : nm(x.opponent)} won</b>`) : '';
    return `<div class="duel"><div class="vs"><div>${nm(x.creator)}<b>${esc(x.pick)}</b></div><span class="x">vs</span><div>${x.opponent ? nm(x.opponent) : x.target ? `${nm(x.target)} <span class="faint">(challenged)</span>` : 'Anyone'}<b>${esc(x.against)}</b></div></div>
      <div class="foot2"><span>${esc(x.matchup)} · ${usd(x.stake)} each · ${status}${x.game && x.game.state !== 'pre' ? ` · ${x.game.a} ${x.game.as}, ${x.game.h} ${x.game.hs}` : ''}</span>${action || result}</div></div>`;
  };
  const live = d.duels.filter((x) => x.status === 'open' || x.status === 'active');
  const hist = d.duels.filter((x) => !['open', 'active'].includes(x.status) && (x.creator_id === me.id || x.opponent_id === me.id));
  return `${create}<div class="sect">Open and active</div>${live.length ? live.map(row).join('') : '<div class="empty" style="padding:24px 0">No duels yet.</div>'}
    ${hist.length ? `<div class="sect">Your history</div>${hist.map(row).join('')}` : ''}`;
}

// ---------- leaderboard ----------
function boardCharts(rows, wk) {
  const series = S.net ? S.net.users.map((u) => { const b = S.data.board.find((r) => r.id === u.id); return { name: u.username, color: u.avatar, pts: u.pts.concat(b ? [[Date.now(), b.net]] : []) }; }) : [];
  return `${series.length ? `<div class="sect">Net worth over time</div>${lineChart('lb', series)}` : ''}
    <div class="sect">${wk ? 'Profit, last 7 days' : 'Profit since joining'}</div>${hbars(rows.map((u) => ({ name: u.username, v: wk ? u.week : u.profit })))}`;
}
function boardTab() {
  const rows = [...S.data.board];
  const wk = S.boardMode === 'week';
  if (wk) rows.sort((a, b) => b.week - a.week);
  const me = S.data.me;
  return `<div class="seg"><button class="${!wk ? 'on' : ''}" data-act="boardmode" data-v="all">Net worth</button><button class="${wk ? 'on' : ''}" data-act="boardmode" data-v="week">Last 7 days</button></div>
  <div class="list">${rows.map((u, i) => `<div class="row ${u.id === me.id ? 'me' : ''}"><span class="rank r${i + 1}">${i + 1}</span>${av(u.username, u.avatar)}
    <div class="rw"><b>${esc(u.username)}</b><small>${u.wins}-${u.losses}${u.streak >= 2 ? `, ${u.streak} in a row` : ''}${u.pending ? ` · ${usd(u.pending)} open` : ''}</small>${u.badges.length ? `<div class="tags">${u.badges.map((b) => `<span title="${esc(b[1])}">${esc(b[0])}</span>`).join('')}</div>` : ''}</div>
    <div class="amt">${wk ? `<span class="${u.week >= 0 ? 'win' : 'loss'}">${u.week >= 0 ? '+' : '-'}${usd(Math.abs(u.week))}</span>` : `${usd(u.net)}<small class="${u.profit >= 0 ? 'win' : 'loss'}">${u.profit >= 0 ? '+' : '-'}${usd(Math.abs(u.profit))}</small>`}</div></div>`).join('')}</div>
  ${boardCharts(rows, wk)}
  <div class="foot">Net worth is cash plus open bets and market positions. Profit is measured against the starting cash plus any bonuses and bailouts.</div>`;
}

// ---------- activity + chat ----------
function feedLine(e) {
  const d = e.data, you = e.uid === S.data.me.id;
  const who = `<b>${esc(e.user)}</b>`;
  let txt = '', extra = '';
  switch (e.kind) {
    case 'join': txt = `${who} joined the league`; break;
    case 'bonus': txt = `${who} claimed the daily bonus, ${usd(d.amount)} (day ${d.streak})`; break;
    case 'bailout': txt = `${who} took a ${usd(d.amount)} bailout`; break;
    case 'bet': {
      const cur = d.legs.map((l) => S.sels.get(l.key)).filter(Boolean);
      const canTail = !you && cur.length === d.legs.length;
      txt = `${who} bet ${usd(d.stake)} on a ${d.type === 'parlay' ? `${d.legs.length}-leg parlay` : 'single'}${d.boost ? ` (+${d.boost}% boost)` : ''}`;
      extra = `<div class="mini">${d.legs.map((l) => `<div><span>${esc(l.label)} <span class="faint">${esc(l.matchup)}</span></span><span>${am(l.odds)}</span></div>`).join('')}</div>${canTail ? `<button class="link" data-act="tail" data-id="${e.id}">Tail this bet</button>` : ''}`;
      break;
    }
    case 'result': txt = d.status === 'won' ? `${who} <span class="win">won ${usd(d.payout - d.stake)}</span>` : d.status === 'lost' ? `${who} <span class="loss">lost ${usd(d.stake)}</span>` : `${who} pushed, ${usd(d.stake)} back`;
      extra = `<div class="mini">${d.legs.map((l) => `<div><span>${esc(l.label)}</span><span>${{ won: 'W', lost: 'L', push: 'P', void: 'P' }[l.status] || ''}</span></div>`).join('')}</div>`; break;
    case 'cashout': txt = `${who} sold a ticket for ${usd(d.payout)} <span class="faint">(cost ${usd(d.stake)})</span>`; break;
    case 'duel_new': txt = `${who} put ${usd(d.stake)} on <b>${esc(d.pick)}</b> in ${esc(d.matchup)}${d.target ? `, challenging <b>${esc(d.target)}</b>` : ''}`; break;
    case 'duel_accept': txt = `${who} took ${esc(d.vs_name || 'a')}'s duel for ${usd(d.stake)}`; break;
    case 'duel_result': txt = d.push ? `${who} and ${esc(d.vs_name || '?')} pushed their duel` : `${who} beat ${esc(d.vs_name || 'a rival')} in a duel and won ${usd(d.stake * 2)}`; break;
    case 'market_new': txt = `${who} opened a market: <b>${esc(d.question)}</b>`; extra = `<button class="link" data-act="gomarket" data-id="${d.market_id}">Trade it</button>`; break;
    case 'market_trade': txt = `${who} bought ${usd(d.amount)} of <b>${d.side === 'yes' ? 'Yes' : 'No'}</b> at ${c100(d.price)} on <b>${esc(d.question)}</b>`; extra = `<button class="link" data-act="gomarket" data-id="${d.market_id}">Trade it</button>`; break;
    case 'poker_win': txt = `${who} won ${usd(d.amount)} at poker${d.hand ? ` with ${esc(d.hand.toLowerCase())}` : ''}`; break;
    case 'market_result': txt = `${who} settled <b>${esc(d.question)}</b> as <b>${d.outcome === 'void' ? 'void' : d.outcome === 'yes' ? 'Yes' : 'No'}</b>`; break;
  }
  const rx = S.data.config.emojis.map((em) => {
    const r = e.reactions.find((x) => x.emoji === em);
    return `<button class="${r && r.users.includes(S.data.me.id) ? 'mine' : ''}" data-act="react" data-id="${e.id}" data-e="${em}">${em}${r ? ` ${r.c}` : ''}</button>`;
  }).join('');
  return `<div class="fi">${av(e.user, e.avatar, true)}<div class="b">${txt}<div class="meta">${ago(e.ts)}</div>${extra}<div class="rx">${rx}</div></div></div>`;
}
function socialTab() {
  const d = S.data;
  const seg = `<div class="seg"><button class="${S.social === 'feed' ? 'on' : ''}" data-act="social" data-v="feed">Activity</button><button class="${S.social === 'chat' ? 'on' : ''}" data-act="social" data-v="chat">Chat</button><button class="${S.social === 'duels' ? 'on' : ''}" data-act="social" data-v="duels">Duels</button></div>`;
  if (S.social === 'duels') return seg + duelsTab();
  if (S.social === 'chat') {
    return seg + `<div class="list"><div class="chat" id="chatbox">${d.chat.length ? d.chat.map((m) => `<div class="msg">${av(m.username, m.avatar, true)}<div><b>${esc(m.username)}</b><small>${ago(m.ts)}</small><div>${esc(m.text)}</div></div></div>`).join('') : '<div class="empty" style="padding:24px 0">No messages yet.</div>'}</div>
      <form class="chatin" id="chatform"><input name="text" maxlength="280" placeholder="Message the group" autocomplete="off"><button class="btn sm">Send</button></form></div>`;
  }
  return seg + `<div class="list">${d.feed.length ? d.feed.map(feedLine).join('') : '<div class="empty">No activity yet.</div>'}</div>`;
}

// ---------- poker ----------
const SUITCH = { s: '♠︎', h: '♥︎', d: '♦︎', c: '♣︎' };
function pcard(c, size = '') {
  if (!c) return `<span class="cd empty ${size}"></span>`;
  if (c === '??') return `<span class="cd back ${size}"></span>`;
  const red = c[1] === 'h' || c[1] === 'd';
  return `<span class="cd ${red ? 'r' : ''} ${size}"><b>${c[0] === 'T' ? '10' : c[0]}</b><i>${SUITCH[c[1]]}</i></span>`;
}
const pkBlinds = (st) => st.split('/').map(Number);
function pokerLobbyHtml() {
  const L = S.pk.lobby;
  if (!L) return '<div class="empty">Loading</div>';
  const [, bb] = pkBlinds(S.pk.stakes);
  const buy = Number(S.pk.buyin) || bb * 50;
  const seg = (act, cur, items) => `<div class="seg" style="margin:0">${items.map(([v, l]) => `<button class="${String(cur) === String(v) ? 'on' : ''}" data-act="${act}" data-v="${v}">${l}</button>`).join('')}</div>`;
  const rows = L.tables.map((t) => {
    const join = Number(S.pk.buyin) >= t.minBuy && Number(S.pk.buyin) <= t.maxBuy ? Number(S.pk.buyin) : t.bb * 50;
    return `<div class="pkrow"><div class="pkr-l"><b>${esc(t.name)}</b><small>$${t.sb}/$${t.bb} · ${t.people.length} player${t.people.length === 1 ? '' : 's'}${t.bots ? ` + ${t.bots} bot${t.bots === 1 ? '' : 's'}` : ''} · ${t.open} open seat${t.open === 1 ? '' : 's'}</small></div>
      ${t.mine ? `<button class="btn sm" data-act="pkopen" data-id="${t.id}">Return</button>` : `<button class="btn sm line" data-act="pkjoin" data-id="${t.id}" data-buy="${join}" ${t.open ? '' : 'disabled'}>Join for ${usd(join)}</button>`}</div>`;
  }).join('');
  return `<div class="tabhead"><h2>Poker</h2><span class="pkp ${L.profit >= 0 ? 'win' : 'loss'}">${L.profit >= 0 ? '+' : '-'}${usd(Math.abs(L.profit))} <small>poker profit</small></span></div>
    ${L.mine ? `<div class="strip"><span>You have a seat at a table.</span><button class="btn sm" data-act="pkopen" data-id="${L.mine}">Return to table</button></div>` : ''}
    <div class="card"><b>New table</b>
      <div class="field"><label>Stakes</label>${seg('pkstakes', S.pk.stakes, L.stakes.map((x) => [x, '$' + x.replace('/', '/$')]))}</div>
      <div class="field"><label>Bots at the table</label>${seg('pkbots', S.pk.bots, [0, 1, 2, 3, 4, 5].map((n) => [n, String(n)]))}</div>
      <div class="field"><label>Buy-in, $${money(bb * 20)} to $${money(bb * 100)}</label><input id="pkbuy" inputmode="numeric" value="${money(buy)}" autocomplete="off"></div>
      <div style="margin-top:14px"><button class="btn" data-act="pkcreate" ${L.mine ? 'disabled' : ''}>Sit down</button></div>
      <div class="note">With no bots the table is open for friends to join. Tables with bots take a 3% rake after the flop, up to 3 big blinds. Friend tables take nothing.</div></div>
    <div class="sect">Open tables</div>${rows || '<div class="empty" style="padding:24px 0">No tables yet.</div>'}`;
}
function pokerActionsHtml(v, me) {
  if (!me) {
    const buy = Number(S.pk.buyin) >= v.minBuy && Number(S.pk.buyin) <= v.maxBuy ? Number(S.pk.buyin) : v.bb * 50;
    return `<div class="pkact"><button class="btn" data-act="pkjoin" data-id="${v.id}" data-buy="${buy}">Sit down for ${usd(buy)}</button></div>`;
  }
  if (me.sitOut) return `<div class="pkact"><div class="note">You timed out and are sitting out.</div><button class="btn" data-act="pkreturn">I'm back</button></div>`;
  if (v.myTurn) {
    const secs = Math.max(0, Math.ceil((v.deadline - v.now - (Date.now() - S.pk.at)) / 1000));
    const minTo = Math.min(v.minRaiseTo, v.maxTo), amt = Number(S.pk.raise) || 0;
    const canRaise = v.maxTo > v.currentBet && me.stack > v.toCall;
    const ok = amt >= minTo && amt <= v.maxTo || amt === v.maxTo;
    const quick = [['min', 'Min'], ['half', '1/2 pot'], ['pot', 'Pot'], ['all', 'All in']].map(([k, l]) => `<button class="qk" data-act="pkquick" data-v="${k}">${l}</button>`).join('');
    const rz = canRaise && S.pk.rz;
    return `<div class="pkact turn"><div class="pkt">Your move <span>${secs}s</span></div>
      <div class="${canRaise ? 'pk3' : 'pk2'}"><button class="btn line" data-act="pkfold">Fold</button><button class="btn" data-act="pkcall">${v.toCall > 0 ? `Call ${usd(v.toCall)}` : 'Check'}</button>${canRaise ? `<button class="btn line ${rz ? 'sel' : ''}" data-act="pkrz">${v.currentBet ? 'Raise' : 'Bet'}</button>` : ''}</div>
      ${rz ? `<div class="field"><label>${v.currentBet ? 'Raise to' : 'Bet'}</label><input id="pkamt" inputmode="numeric" placeholder="${money(minTo)}" value="${amt ? money(amt) : ''}" autocomplete="off"></div>
        <div class="chips">${quick}</div><button class="btn" id="pkgo" data-act="pkraise" ${ok ? '' : 'disabled'}>${v.currentBet ? 'Raise' : 'Bet'}${amt ? ` to ${usd(amt)}` : ''}</button>` : ''}</div>`;
  }
  const acting = v.seats.find((s) => s && s.acting);
  const inHand = ['preflop', 'flop', 'turn', 'river'].includes(v.stage);
  const msg = v.stage === 'showdown' ? 'Next hand starts in a moment.' : v.stage === 'waiting' ? 'Waiting for another player. Add a bot or invite a friend.' : me.folded ? 'You folded this hand.' : acting ? `Waiting for ${esc(acting.name)}.` : '';
  const free = v.seats.some((s, i) => !s) ;
  return `<div class="pkact"><div class="note">${msg}</div>${!inHand || !me.dealt ? `<div class="pkbar">${me.stack < v.maxBuy ? '<button class="btn sm line" data-act="pkrebuy">Add cash</button>' : ''}${free ? '<button class="btn sm line" data-act="pkbot">Add bot</button>' : ''}</div>` : ''}</div>`;
}
function pokerTableHtml() {
  const v = S.pk.view;
  if (!v) return '<div class="empty">Loading table</div>';
  const me = v.me >= 0 ? v.seats[v.me] : null;
  const opp = v.seats.filter((s) => s && !s.mine);
  const inHand = ['preflop', 'flop', 'turn', 'river'].includes(v.stage);
  const open = v.seats.filter((s) => !s).length;
  const boardCards = Array.from({ length: 5 }, (_, i) => pcard(v.board[i], 'md')).join('');
  const seat = (s) => `<div class="ps ${s.acting ? 'act' : ''} ${s.folded ? 'fold' : ''}">
    <div class="ps-n">${av(s.name, s.avatar, true)}<b>${esc(s.name)}</b>${s.dealer ? '<i class="dlr">D</i>' : ''}</div>
    <div class="ps-c">${s.hole.length ? s.hole.map((c) => pcard(c, 'sm')).join('') : '<span class="cd empty sm"></span><span class="cd empty sm"></span>'}</div>
    <div class="ps-s">${usd(s.stack)}${s.allIn ? ' <em>all in</em>' : ''}</div>
    <div class="ps-l">${s.won ? `<b class="win">+${usd(s.won)}</b>` : s.bet ? `bet ${usd(s.bet)}` : s.sitOut ? 'sitting out' : s.folded ? 'folded' : esc(s.last)}${s.hand ? ` · ${esc(s.hand)}` : ''}</div>
    ${s.bot && !(inHand && s.dealt) ? `<button class="link ps-x" data-act="pkrmbot" data-seat="${s.i}">remove</button>` : ''}</div>`;
  const mine = me ? `<div class="pkme ${me.acting ? 'act' : ''}"><div class="pkme-c">${me.hole.length ? me.hole.map((c) => pcard(c, 'big')).join('') : '<span class="cd empty big"></span><span class="cd empty big"></span>'}</div>
    <div class="pkme-i"><b>${esc(me.name)}${me.dealer ? ' <i class="dlr">D</i>' : ''}</b><span>${usd(me.stack)}${me.allIn ? ' · all in' : ''}</span><small>${me.won ? `won ${usd(me.won)}` : me.bet ? `bet ${usd(me.bet)}` : me.folded ? 'folded' : esc(me.last)}${me.hand ? ` · ${esc(me.hand)}` : ''}</small></div></div>` : '';
  return `<div class="pkhead"><div><b>${esc(v.name)}</b><small>$${v.sb}/$${v.bb}${v.bots ? ' · 3% rake' : ''} · hand ${v.handNo}</small></div>
      <div class="pkbtns">${me ? '<button class="btn sm line" data-act="pkleave">Cash out</button>' : '<button class="btn sm line" data-act="pkback">Back</button>'}</div></div>
    <div class="pktable"><div class="pk-opp">${opp.map(seat).join('')}${open ? `<div class="ps empty-seat">${open} open seat${open === 1 ? '' : 's'}</div>` : ''}</div>
      <div class="pkboard">${boardCards}</div>
      <div class="pkpot">Pot <b>${usd(v.pot)}</b></div>
      ${v.result ? `<div class="pkres">${v.result.lines.map(esc).join('<br>')}${v.result.rake ? `<small>Rake ${usd(v.result.rake)}</small>` : ''}</div>` : ''}
      ${mine}</div>
    ${pokerActionsHtml(v, me)}
    <div class="pklog">${v.log.slice(-8).reverse().map((l) => `<div>${esc(l)}</div>`).join('')}</div>`;
}
function pokerHtml() { return S.pk.id ? pokerTableHtml() : pokerLobbyHtml(); }
const pokerTab = () => `<div id="pk">${pokerHtml()}</div>`;
function renderPoker() {
  const el = $('#pk'); if (!el) return;
  if (document.activeElement && el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  const html = pokerHtml();
  if (html !== S.pk.last) { el.innerHTML = html; S.pk.last = html; }
}
async function loadLobby() {
  try {
    S.pk.lobby = await api('/api/poker');
    if (S.pk.lobby.mine && !S.pk.id && !S.pk.left) { S.pk.id = S.pk.lobby.mine; await loadView(); }
    lastTabHtml = ''; if (S.tab === 'poker') render();
  } catch (e) { /* ignore */ }
}
async function loadView() {
  if (!S.pk.id) return;
  try { S.pk.view = await api(`/api/poker/tables/${S.pk.id}`); S.pk.at = Date.now(); renderPoker(); }
  catch (e) {
    if (e.status === 404) { S.pk.id = null; S.pk.view = null; toast('That table has closed'); loadLobby(); }
  }
}
let pkTick = 0;
async function pokerPoll() {
  if (!token || !S.data || S.tab !== 'poker' || document.hidden) return;
  if (S.pk.id) await loadView(); else if (pkTick++ % 3 === 0) await loadLobby();
}
async function pokerDo(path, body, okMsg) {
  if (S.busy) return;
  S.busy = true;
  try { await api(path, body); if (okMsg) toast(okMsg, 'good'); }
  catch (e) { toast(e.message, 'bad'); }
  S.busy = false;
  await loadView();
}
function pokerQuick(k) {
  const v = S.pk.view; if (!v) return;
  const minTo = Math.min(v.minRaiseTo, v.maxTo);
  let amt = k === 'min' ? minTo : k === 'half' ? v.currentBet + Math.round((v.pot + v.toCall) * 0.5) : k === 'pot' ? v.currentBet + v.pot + v.toCall : v.maxTo;
  amt = Math.max(minTo, Math.min(amt, v.maxTo));
  S.pk.raise = String(amt); S.pk.last = ''; renderPoker();
}

// ---------- shell ----------
function tabContent() {
  return { games: gamesTab, markets: marketsTab, poker: pokerTab, bets: betsTab, board: boardTab, social: socialTab }[S.tab]();
}
function syncDuelSides() {
  const f = $('#duelform'); if (!f) return;
  const g = S.data.games.find((x) => x.id === f.game_id.value); if (!g) return;
  const cur = f.side.value;
  f.side.innerHTML = `<option value="away">${esc(g.away.abbr)} ${fl(-g.spread)}</option><option value="home">${esc(g.home.abbr)} ${fl(g.spread)}</option>`;
  if (cur) f.side.value = cur;
}
function headerHtml() {
  const m = S.data.me;
  const mine = S.data.board.find((u) => u.id === m.id);
  return `<div class="logo">Courtside</div>
    <div class="hstats"><span><i>Portfolio</i> ${usd(mine ? mine.net : m.balance)}</span><span><i>Cash</i> ${usd(m.balance)}</span></div>
    <button class="who" data-act="menu" aria-label="Account menu">${av(m.username, m.avatar, true)}<span class="wn">${esc(m.username)}</span></button>`;
}
const ICON = {
  games: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>',
  markets: '<path d="M3 17l5-5 4 4 8-9"/><path d="M15 7h5v5"/>',
  poker: '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M12 8l2.500 4L12 16l-2.500-4z"/>',
  bets: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5h6v2M3 13h18"/>',
  board: '<path d="M3 20h18M5 20v-7h4v7M10 20V6h4v14M15 20v-10h4v10"/>',
  social: '<path d="M4 5h16v11H9l-5 4z"/>',
};
function counts() {
  const openN = S.data.bets.filter((b) => b.status === 'pending').length + S.data.markets.filter((m) => m.status === 'open' && (m.mine.yes > 0.01 || m.mine.no > 0.01)).length;
  const duelN = S.data.duels.filter((d) => d.status === 'open' && d.creator_id !== S.data.me.id && (!d.target_id || d.target_id === S.data.me.id)).length;
  return { openN, duelN };
}
const TABS = [['games', 'Sports'], ['markets', 'Markets'], ['poker', 'Poker'], ['bets', 'Portfolio'], ['board', 'Leaders'], ['social', 'Social']];
function navHtml() {
  const { openN, duelN } = counts();
  return TABS.map(([k, l]) => { const n = k === 'bets' ? openN : k === 'social' ? duelN : 0; return `<button class="${S.tab === k ? 'on' : ''}" data-act="tab" data-v="${k}">${l}${n ? ` <i class="bdg2">${n}</i>` : ''}</button>`; }).join('');
}
function tabbarHtml() {
  const { openN, duelN } = counts();
  return TABS.map(([k, l]) => { const n = k === 'bets' ? openN : k === 'social' ? duelN : 0; return `<button class="${S.tab === k ? 'on' : ''}" data-act="tab" data-v="${k}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg><span>${l}</span>${n ? `<i class="bdg">${n}</i>` : ''}</button>`; }).join('');
}
function stripHtml() {
  const m = S.data.me;
  if (m.bonus_ready) return `<div class="strip"><span>Daily bonus: ${usd(m.next_bonus)}${m.streak ? `, day ${Math.min(m.streak + 1, 7)}` : ''}</span><button class="btn sm" data-act="bonus">Claim</button></div>`;
  if (m.can_bailout) return `<div class="strip"><span>Out of cash.</span><button class="btn sm" data-act="bailout">Take a $2,500 bailout</button></div>`;
  return '';
}
function shellHtml() {
  return `<header class="top"><div class="wrap"><div class="hdr" id="hdr"></div><div class="nav" id="nav"></div></div></header>
    <div class="shell"><div id="strip"></div>
    <div class="layout"><div id="tab"></div><aside class="slipwrap" id="slip"></aside></div></div>
    <div id="scrim" class="scrim" data-act="slipclose" style="display:none"></div>
    <button id="slipbar" class="slipbar" data-act="slipopen" style="display:none"></button>
    <nav id="tabbar" class="tabbar"></nav>`;
}
function renderModal() {
  let m = $('#modal'); if (m) m.remove();
  if (!S.modal) return;
  const d = S.data;
  const el = document.createElement('div');
  el.id = 'modal'; el.className = 'modal-bg'; el.dataset.act = 'modalclose';
  const segOf = (act, cur, items) => `<div class="seg block" style="margin:0">${items.map(([v, l]) => `<button class="${cur === v ? 'on' : ''}" data-act="${act}" data-v="${v}">${l}</button>`).join('')}</div>`;
  el.innerHTML = `<div class="modal" data-stop="1"><h3>${esc(d.me.username)}</h3>
    <div class="mid">Invite code for friends joining ${esc(location.host)}:</div><div class="code">${esc(d.invite)}</div>
    <div class="field"><label>Price format</label>${segOf('fmt', S.fmt, [['cents', 'Dollars'], ['am', 'American'], ['dec', 'Decimal']])}</div>
    <div class="field"><label>Theme</label>${segOf('theme', S.theme, [['dark', 'Dark'], ['light', 'Light']])}</div>
    <div style="display:grid;gap:8px;margin-top:14px"><button class="btn" data-act="copyinvite">Copy invite message</button>
    ${d.me.can_bailout ? `<button class="btn line" data-act="bailout">Take a bailout (+$2,500)</button>` : ''}
    <button class="btn line" data-act="logout">Log out</button></div>
    <div class="foot">Daily bonus is $1,000, plus $250 for each consecutive day, up to 7 days.<br>${d.sync.ok ? `Scores updated ${ago(d.sync.ok)}.` : 'Waiting for the first score update.'}${d.sync.err ? `<br>Feed warning: ${esc(d.sync.err)}` : ''}</div></div>`;
  document.body.appendChild(el);
}
let lastTabHtml = '';
function render() {
  const app = $('#app');
  if (!token) { app.innerHTML = authView(); return; }
  if (!S.data) { if (!$('#hdr')) app.innerHTML = `<div class="empty" style="padding-top:120px">Loading</div>`; return; }
  if (!$('#hdr')) { app.innerHTML = shellHtml(); lastTabHtml = ''; }
  $('#hdr').innerHTML = headerHtml();
  $('#strip').innerHTML = stripHtml();
  $('#nav').innerHTML = navHtml();
  $('#tabbar').innerHTML = tabbarHtml();
  const tabEl = $('#tab');
  const typing = document.activeElement && tabEl.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  if (!typing) {
    const html = tabContent();
    if (html !== lastTabHtml) {
      const sy = window.scrollY;
      const cb = $('#chatbox'), atBottom = cb ? cb.scrollTop + cb.clientHeight >= cb.scrollHeight - 30 : true;
      tabEl.innerHTML = html; lastTabHtml = html;
      syncDuelSides();
      const cb2 = $('#chatbox'); if (cb2 && atBottom) cb2.scrollTop = cb2.scrollHeight;
      window.scrollTo(0, sy);
    }
  }
  const slipTyping = document.activeElement && document.activeElement.id === 'stake';
  if (!slipTyping) renderSlip(); else updateSlipTotals();
  S.slip.forEach((l) => { delete l.flash; delete l.old; });
  renderModal();
}

// ---------- actions ----------
const gotoMarket = (id) => {
  S.tab = 'markets'; S.openMarket = Number(id); S.mt = { side: 'yes', kind: 'buy', amt: '', pct: 0 }; lastTabHtml = ''; render();
  const t = document.getElementById(`m-${id}`); if (t) t.scrollIntoView({ block: 'start' });
};
async function act(el) {
  const a = el.dataset.act, v = el.dataset.v;
  if (document.activeElement && ['gsearch', 'mamt', 'pkamt', 'pkbuy'].includes(document.activeElement.id)) document.activeElement.blur();
  switch (a) {
    case 'tab':
      if (v === 'duels') { S.tab = 'social'; S.social = 'duels'; } else S.tab = v;
      localStorage.setItem('cs_tab', S.tab); lastTabHtml = ''; render(); window.scrollTo(0, 0);
      if (S.tab === 'bets' || S.tab === 'board') loadNet();
      if (S.tab === 'poker') { S.pk.left = false; loadLobby(); }
      break;
    case 'range': S.range = v; lastTabHtml = ''; render(); break;
    case 'authmode': S.authMode = v; render(); break;
    case 'color': { const f = $('#authform'); const keep = f ? Object.fromEntries(new FormData(f)) : {}; S.color = v; render(); const f2 = $('#authform'); for (const k in keep) if (f2[k]) f2[k].value = keep[k]; break; }
    case 'pick': {
      const s = S.sels.get(el.dataset.key); if (!s) return;
      const i = S.slip.findIndex((l) => l.key === s.key);
      if (i >= 0) S.slip.splice(i, 1);
      else {
        const j = S.slip.findIndex((l) => l.game_id === s.game_id && l.family === s.family);
        if (j >= 0) S.slip.splice(j, 1);
        S.slip.push({ key: s.key, odds: s.odds, label: s.label, matchup: s.matchup, family: s.family, game_id: s.game_id, live: s.live, market: s.market });
      }
      lastTabHtml = ''; render(); break;
    }
    case 'rm': S.slip = S.slip.filter((l) => l.key !== el.dataset.key); if (!S.slip.length) S.slipOpen = false; lastTabHtml = ''; render(); break;
    case 'clear': S.slip = []; S.slipOpen = false; lastTabHtml = ''; render(); break;
    case 'mode': S.mode = v; renderSlip(); break;
    case 'stake': {
      const bal = S.data.me.balance, c = slipCalc();
      S.stake = v === 'max' ? String(Math.max(0, Math.floor(bal / (c.mode === 'singles' ? c.n : 1)))) : String((Math.floor(Number(String(S.stake).replace(/,/g, ''))) || 0) + Number(v));
      renderSlip(); break;
    }
    case 'slipopen': S.slipOpen = true; renderSlip(); break;
    case 'slipclose': S.slipOpen = false; renderSlip(); break;
    case 'game': S.openGame.has(el.dataset.id) ? S.openGame.delete(el.dataset.id) : S.openGame.add(el.dataset.id); lastTabHtml = ''; render(); break;
    case 'chart': {
      const id = el.dataset.id;
      if (S.chartOpen.has(id)) S.chartOpen.delete(id); else { S.chartOpen.add(id); loadHist(id); }
      lastTabHtml = ''; render(); break;
    }
    case 'grp': S.openGroups.has(el.dataset.k) ? S.openGroups.delete(el.dataset.k) : S.openGroups.add(el.dataset.k); lastTabHtml = ''; render(); break;
    case 'place': await placeBet(); break;
    case 'results': S.showResults = !S.showResults; lastTabHtml = ''; render(); break;
    case 'filter': S.filter = v; lastTabHtml = ''; render(); break;
    case 'fmt': S.fmt = v; localStorage.setItem('cs_fmt', v); lastTabHtml = ''; render(); break;
    case 'theme': S.theme = v; localStorage.setItem('cs_theme', v); document.documentElement.dataset.theme = v; render(); break;
    case 'jump': {
      const g = S.data.games.find((x) => x.id === el.dataset.id);
      S.filter = 'all'; S.q = ''; S.tab = 'games'; if (g && g.state === 'post') S.showResults = true;
      lastTabHtml = ''; render();
      const t = document.getElementById(`g-${el.dataset.id}`);
      if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); t.classList.add('ping'); setTimeout(() => t.classList.remove('ping'), 1800); }
      break;
    }
    case 'betfilter': S.betFilter = v; lastTabHtml = ''; render(); break;
    case 'boardmode': S.boardMode = v; lastTabHtml = ''; render(); break;
    case 'social': S.social = v; lastTabHtml = ''; render(); break;
    case 'menu': S.modal = true; renderModal(); break;
    case 'modalclose': S.modal = null; renderModal(); break;
    case 'logout': logout(); break;
    case 'copyinvite': {
      const msg = `Join my NBA betting league (play money)\n${location.origin}\nInvite code: ${S.data.invite}`;
      try { await navigator.clipboard.writeText(msg); toast('Invite copied', 'good'); } catch { prompt('Copy this:', msg); }
      break;
    }
    case 'bonus': try { const r = await api('/api/bonus', {}); toast(`Claimed ${usd(r.amount)} (day ${r.streak})`, 'good'); refresh(true); } catch (e) { toast(e.message, 'bad'); } break;
    case 'bailout': try { const r = await api('/api/bailout', {}); toast(`Bailout: +${usd(r.amount)}`, 'good'); S.modal = null; refresh(true); } catch (e) { toast(e.message, 'bad'); } break;
    case 'cashout': {
      try { const r = await api(`/api/bets/${el.dataset.id}/cashout`, { expected: Number(el.dataset.v) }); toast(`Sold for ${usd(r.value)}`, 'good'); }
      catch (e) { toast(e.status === 409 ? `The sell price is now ${usd(e.data.value)}. Tap again to confirm.` : e.message, 'bad'); }
      refresh(true); break;
    }
    case 'react': try { await api('/api/react', { event_id: Number(el.dataset.id), emoji: el.dataset.e }); refresh(true); } catch (e) { toast(e.message, 'bad'); } break;
    case 'tail': {
      const ev = S.data.feed.find((f) => f.id === Number(el.dataset.id)); if (!ev) return;
      let n = 0;
      for (const l of ev.data.legs) {
        const s = S.sels.get(l.key); if (!s || S.slip.some((x) => x.key === s.key)) continue;
        S.slip = S.slip.filter((x) => !(x.game_id === s.game_id && x.family === s.family));
        S.slip.push({ key: s.key, odds: s.odds, label: s.label, matchup: s.matchup, family: s.family, game_id: s.game_id, live: s.live, market: s.market }); n++;
      }
      toast(n ? `Added ${n} pick${n > 1 ? 's' : ''} to your slip` : 'Already on your slip');
      S.slipOpen = window.innerWidth < 960; render(); break;
    }
    case 'duelaccept': try { await api(`/api/duels/${el.dataset.id}/accept`, {}); toast('Duel accepted', 'good'); refresh(true); } catch (e) { toast(e.message, 'bad'); } break;
    case 'duelcancel': try { await api(`/api/duels/${el.dataset.id}/cancel`, {}); toast('Duel cancelled, refunded'); refresh(true); } catch (e) { toast(e.message, 'bad'); } break;
    // markets
    case 'mnew': S.newMarket = !S.newMarket; lastTabHtml = ''; render(); break;
    case 'gonew': S.tab = 'markets'; S.newMarket = true; lastTabHtml = ''; render(); window.scrollTo(0, 0); break;
    case 'mopen': S.openMarket = S.openMarket === Number(el.dataset.id) ? null : Number(el.dataset.id); S.mt = { side: 'yes', kind: 'buy', amt: '', pct: 0 }; lastTabHtml = ''; render(); break;
    case 'mbuy': S.openMarket = Number(el.dataset.id); S.mt = { side: el.dataset.side, kind: 'buy', amt: '', pct: 0 }; lastTabHtml = ''; render(); break;
    case 'mside': S.mt.side = v; S.mt.pct = 0; lastTabHtml = ''; render(); break;
    case 'mkind': S.mt.kind = v; S.mt.pct = 0; lastTabHtml = ''; render(); break;
    case 'mquick': {
      const cur = Number(S.mt.amt) || 0;
      S.mt.amt = String(v === 'max' ? Math.min(S.data.me.balance, S.data.config.market_max) : Math.min(cur + Number(v), S.data.config.market_max));
      lastTabHtml = ''; render(); break;
    }
    case 'mpct': S.mt.pct = Number(v); lastTabHtml = ''; render(); break;
    case 'mtrade': await tradeMarketAct(); break;
    case 'gomarket': gotoMarket(el.dataset.id); break;
    case 'pkstakes': S.pk.stakes = v; S.pk.buyin = ''; renderPoker(); break;
    case 'pkbots': S.pk.bots = Number(v); renderPoker(); break;
    case 'pkcreate': {
      try {
        const r = await api('/api/poker/tables', { stakes: S.pk.stakes, bots: S.pk.bots, buyin: Number(S.pk.buyin) || undefined });
        S.pk.id = r.id; S.pk.left = false; S.pk.raise = ''; await loadView(); refresh(true);
      } catch (e) { toast(e.message, 'bad'); }
      break;
    }
    case 'pkjoin': {
      try { await api(`/api/poker/tables/${el.dataset.id}/sit`, { buyin: Number(el.dataset.buy) }); S.pk.id = el.dataset.id; S.pk.left = false; S.pk.raise = ''; await loadView(); refresh(true); }
      catch (e) { toast(e.message, 'bad'); }
      break;
    }
    case 'pkopen': S.pk.id = el.dataset.id; S.pk.left = false; S.pk.view = null; S.pk.last = ''; renderPoker(); loadView(); break;
    case 'pkback': S.pk.id = null; S.pk.view = null; S.pk.left = true; S.pk.last = ''; lastTabHtml = ''; render(); loadLobby(); break;
    case 'pkleave': {
      if (S.busy) break;
      try { await api(`/api/poker/tables/${S.pk.id}/leave`, {}); toast('Cashed out', 'good'); } catch (e) { toast(e.message, 'bad'); }
      S.pk.id = null; S.pk.view = null; S.pk.left = true; S.pk.last = ''; lastTabHtml = ''; render(); loadLobby(); refresh(true);
      break;
    }
    case 'pkfold': S.pk.rz = false; await pokerDo(`/api/poker/tables/${S.pk.id}/action`, { type: 'fold' }); break;
    case 'pkcall': S.pk.rz = false; await pokerDo(`/api/poker/tables/${S.pk.id}/action`, { type: 'call' }); S.pk.raise = ''; break;
    case 'pkraise': await pokerDo(`/api/poker/tables/${S.pk.id}/action`, { type: 'raise', amount: Number(S.pk.raise) }); S.pk.raise = ''; S.pk.rz = false; break;
    case 'pkrz': S.pk.rz = !S.pk.rz; S.pk.last = ''; renderPoker(); break;
    case 'pkquick': pokerQuick(v); break;
    case 'pkreturn': await pokerDo(`/api/poker/tables/${S.pk.id}/action`, { type: 'back' }); break;
    case 'pkbot': await pokerDo(`/api/poker/tables/${S.pk.id}/bots`, {}); break;
    case 'pkrmbot': await pokerDo(`/api/poker/tables/${S.pk.id}/bots`, { remove: Number(el.dataset.seat) }); break;
    case 'pkrebuy': {
      const max = S.pk.view ? S.pk.view.maxBuy - S.pk.view.seats[S.pk.view.me].stack : 0;
      const a = Number(String(prompt(`Add how much? (up to $${money(max)})`, String(Math.min(max, S.pk.view.bb * 50))) || '').replace(/[^\d]/g, ''));
      if (a > 0) { await pokerDo(`/api/poker/tables/${S.pk.id}/rebuy`, { amount: a }); refresh(true); }
      break;
    }
    case 'mresolve': {
      const m = S.data.markets.find((x) => x.id === Number(el.dataset.id));
      if (!m || !confirm(`Settle "${m.question}" as ${v === 'void' ? 'void (everyone is refunded)' : v.toUpperCase()}? This can't be undone.`)) break;
      try { await api(`/api/markets/${m.id}/resolve`, { outcome: v }); toast('Market settled', 'good'); S.openMarket = null; } catch (e) { toast(e.message, 'bad'); }
      lastTabHtml = ''; refresh(true); break;
    }
  }
}
async function placeBet() {
  const c = slipCalc();
  if (S.busy) return;
  S.busy = true; renderSlip();
  try {
    const r = await api('/api/bets', { type: c.mode, stake: c.stake, legs: S.slip.map((l) => ({ key: l.key, odds: l.odds })) });
    toast(r.ids.length > 1 ? `${r.ids.length} bets placed` : 'Bet placed', 'good');
    S.slip = []; S.stake = ''; S.slipOpen = false; S.mode = 'auto'; lastTabHtml = '';
  } catch (e) {
    if (e.status === 409 && e.data) {
      for (const ch of e.data.changed || []) { const l = S.slip.find((x) => x.key === ch.key); if (l) { l.old = l.odds; l.odds = ch.odds; l.flash = true; } }
      for (const k of e.data.gone || []) S.slip = S.slip.filter((x) => x.key !== k);
    }
    toast(e.message, 'bad');
  }
  S.busy = false; await refresh(true);
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled) return;
  if (el.dataset.act === 'modalclose' && ev.target.closest('[data-stop]')) return;
  act(el);
});
document.addEventListener('input', (ev) => {
  if (ev.target.id === 'stake') {
    const raw = ev.target.value.replace(/[^\d]/g, '');
    S.stake = raw; ev.target.value = raw ? Number(raw).toLocaleString('en-US') : ''; updateSlipTotals();
  } else if (ev.target.id === 'gsearch') {
    S.q = ev.target.value; const l = $('#glist'); if (l) l.innerHTML = gameList();
  } else if (ev.target.id === 'pkbuy') {
    const raw = ev.target.value.replace(/[^\d]/g, '');
    S.pk.buyin = raw; ev.target.value = raw ? Number(raw).toLocaleString('en-US') : '';
  } else if (ev.target.id === 'pkamt') {
    const raw = ev.target.value.replace(/[^\d]/g, '');
    S.pk.raise = raw; ev.target.value = raw ? Number(raw).toLocaleString('en-US') : '';
    const v = S.pk.view, go = $('#pkgo');
    if (v && go) { const a = Number(raw) || 0, minTo = Math.min(v.minRaiseTo, v.maxTo); go.disabled = !((a >= minTo && a <= v.maxTo) || a === v.maxTo); go.textContent = `${v.currentBet ? 'Raise' : 'Bet'}${a ? ' to ' + usd(a) : ''}`; }
  } else if (ev.target.id === 'mamt') {
    const raw = ev.target.value.replace(/[^\d]/g, '');
    S.mt.amt = raw; ev.target.value = raw ? Number(raw).toLocaleString('en-US') : ''; updateQuote();
  }
});
document.addEventListener('change', (ev) => { if (ev.target.name === 'game_id') syncDuelSides(); });
document.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  if (f.id === 'authform') {
    const body = Object.fromEntries(new FormData(f)); if (S.authMode === 'join') body.avatar = S.color;
    try {
      const r = await api(S.authMode === 'join' ? '/api/register' : '/api/login', body);
      token = r.token; localStorage.setItem('cs_token', token); S.prevBets = null; await refresh(true);
    } catch (e) { $('#autherr').textContent = e.message; }
  } else if (f.id === 'chatform') {
    const text = f.text.value.trim(); if (!text) return;
    f.text.value = '';
    try { await api('/api/chat', { text }); lastTabHtml = ''; await refresh(true); const cb = $('#chatbox'); if (cb) cb.scrollTop = cb.scrollHeight; $('#chatform input').focus(); } catch (e) { toast(e.message, 'bad'); }
  } else if (f.id === 'duelform') {
    const b = Object.fromEntries(new FormData(f));
    try { await api('/api/duels', { ...b, stake: Number(String(b.stake).replace(/,/g, '')) }); toast('Duel posted', 'good'); lastTabHtml = ''; refresh(true); } catch (e) { toast(e.message, 'bad'); }
  } else if (f.id === 'mkform') {
    const b = Object.fromEntries(new FormData(f));
    try {
      const r = await api('/api/markets', { question: b.question, detail: b.detail, hours: Number(b.hours) });
      toast('Market created', 'good'); S.newMarket = false; S.openMarket = r.id; lastTabHtml = ''; await refresh(true);
    } catch (e) { toast(e.message, 'bad'); }
  }
});

render();
if (token) refresh(true);
setInterval(pokerPoll, 1200);
setInterval(refresh, 12000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
