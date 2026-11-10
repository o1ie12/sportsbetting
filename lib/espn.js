'use strict';
// Free, key-less ESPN endpoints: schedule/scores/lines + box scores for prop grading.
const { houseOdds } = require('./odds');
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'courtside-friends-app' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

const parseAm = (s) => {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  s = String(s).trim();
  if (/^even$/i.test(s)) return 100;
  const n = parseInt(s.replace('+', ''), 10);
  return Number.isNaN(n) ? null : n;
};

function parseOdds(comp) {
  const o = (comp.odds || [])[0];
  if (!o) return null;
  const pick = (x) => x && (x.close || x.open);
  const mh = parseAm(pick(o.moneyline?.home)?.odds), ma = parseAm(pick(o.moneyline?.away)?.odds);
  const sh = pick(o.pointSpread?.home), sa = pick(o.pointSpread?.away);
  let hl = parseFloat(sh?.line);
  if (Number.isNaN(hl) && /^(pk|even)$/i.test(String(sh?.line || ''))) hl = 0;
  const to = pick(o.total?.over), tu = pick(o.total?.under);
  const tl = parseFloat(String(to?.line || '').replace(/[^\d.]/g, ''));
  if ([mh, ma, hl, tl].some((v) => v == null || Number.isNaN(v))) return null;
  return {
    src: (o.provider?.displayName || o.provider?.name || 'Sportsbook').replace('Draft Kings', 'DraftKings'),
    ml: { home: mh, away: ma },
    spread: { home_line: hl, home_odds: parseAm(sh.odds) ?? -110, away_odds: parseAm(sa?.odds) ?? -110 },
    total: { line: tl, over: parseAm(to?.odds) ?? -110, under: parseAm(tu?.odds) ?? -110 },
  };
}

function parseProps(comp) {
  const out = [];
  const cats = { pointsPerGame: 'PTS', reboundsPerGame: 'REB', assistsPerGame: 'AST' };
  for (const c of comp.competitors || []) {
    for (const cat of c.leaders || []) {
      const stat = cats[cat.name];
      const l = cat.leaders && cat.leaders[0];
      if (!stat || !l || !l.athlete) continue;
      const avg = Number(l.value);
      if (!(avg >= 2)) continue;
      out.push({
        id: `${l.athlete.id}:${stat}`, athlete_id: String(l.athlete.id), name: l.athlete.shortName || l.athlete.displayName,
        full_name: l.athlete.displayName, team: c.team.abbreviation, headshot: l.athlete.headshot || null,
        stat, avg: Math.round(avg * 10) / 10, line: Math.floor(avg) + 0.5,
      });
    }
  }
  return out;
}

function normalize(e) {
  const comp = e.competitions[0];
  const home = comp.competitors.find((c) => c.homeAway === 'home');
  const away = comp.competitors.find((c) => c.homeAway === 'away');
  const t = e.status.type;
  let state = t.state; // pre | in | post
  if (/POSTPONED|CANCEL/i.test(t.name)) state = 'void';
  const rec = (c) => (c.records && c.records[0] && c.records[0].summary) || '0-0';
  const logo = (c) => c.team.logo || `https://a.espncdn.com/i/teamlogos/nba/500/scoreboard/${c.team.abbreviation.toLowerCase()}.png`;
  return {
    id: String(e.id), start: Date.parse(e.date), state, status_detail: t.shortDetail || t.detail || '',
    period: e.status.period || 0, clock: Number(e.status.clock) || 0,
    home_abbr: home.team.abbreviation, away_abbr: away.team.abbreviation,
    home_name: home.team.displayName, away_name: away.team.displayName,
    home_logo: logo(home), away_logo: logo(away),
    home_color: '#' + (home.team.color || '555555'), away_color: '#' + (away.team.color || '555555'),
    home_record: rec(home), away_record: rec(away),
    home_score: Number(home.score) || 0, away_score: Number(away.score) || 0,
    odds: parseOdds(comp), props: parseProps(comp),
  };
}

async function fetchBoard(yyyymmdd) {
  const j = await getJson(`${BASE}/scoreboard?dates=${yyyymmdd}`);
  return (j.events || []).filter((e) => e.competitions && e.competitions[0]).map(normalize);
}

async function fetchBox(eventId) {
  const j = await getJson(`${BASE}/summary?event=${eventId}`);
  const out = {};
  for (const team of (j.boxscore && j.boxscore.players) || []) {
    for (const grp of team.statistics || []) {
      const labels = grp.labels || [];
      const ix = (l) => labels.indexOf(l);
      for (const a of grp.athletes || []) {
        const st = a.stats || [];
        const num = (l) => { const v = parseFloat(st[ix(l)]); return Number.isNaN(v) ? 0 : v; };
        const dnp = a.didNotPlay || !st.length || num('MIN') === 0;
        out[String(a.athlete.id)] = { dnp, PTS: num('PTS'), REB: num('REB'), AST: num('AST') };
      }
    }
  }
  return out;
}

module.exports = { fetchBoard, fetchBox, normalize, houseOdds };
