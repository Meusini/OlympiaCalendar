// tables.js -- league table of one pool, computed from its matches. The new hockey.be site
// (since 25 Nov 2026) publishes matches and scores but no tables.
//
// Rules, checked against the federation's own tables of 24 Nov 2026 (59 pools):
// - 3 points for a win, 1 for a draw; equal points split on most wins, then goal difference,
//   then goals scored, then the points taken in their matches against each other;
// - national youth leagues give a bonus point for winning a shoot-out after a draw. The new
//   site shows only the drawn score, so the bonus cannot be computed. standings/archive.js
//   carries each team's bonus from the last official table (read before 25 Nov 2026); a
//   shoot-out after that is missing;
// - a withdrawn team is left out with all its results. On the new site such a team has no
//   club link (no club name, no logo) and only a few early rows. A combined team also lacks
//   the link but keeps a full schedule, so it stays;
// - before the first match every team is listed with zeros.
// Columns and order as the old feed's standing endpoint served them.

const COLUMNS = ['Rank', 'Team', 'Played', 'Won', 'Lost', 'Draw', 'Own Goals', 'Against Goals', 'Points'];

// rows: parsed match rows of one pool ({date, home:{club,full}, away:{...}, homeScore, awayScore}).
// Only matches before `today` with a score count. Returns null for a pool without teams.
// bonus: { team: points } added on top (shoot-out bonus carried from the last official table).
function computeTable(rows, today, { numeric = false, bonus = null } = {}) {
  const perTeam = {};
  for (const r of rows) for (const s of [r.home, r.away]) {
    const x = (perTeam[s.full] = perTeam[s.full] || { n: 0, linked: false });
    x.n++; if (s.club) x.linked = true;
  }
  const counts = Object.values(perTeam).map(x => x.n).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)] || 0;
  const withdrawn = new Set(Object.entries(perTeam).filter(([, x]) => !x.linked && x.n < median / 2).map(([k]) => k));

  const t = {};
  const h2h = {};   // h2h[a][b] = points a took from b
  const team = name => (t[name] = t[name] || { name, p: 0, w: 0, l: 0, d: 0, gf: 0, ga: 0, pts: 0 });
  const addH2h = (a, b, pts) => { (h2h[a] = h2h[a] || {})[b] = (h2h[a][b] || 0) + pts; };
  for (const r of rows) {
    if (withdrawn.has(r.home.full) || withdrawn.has(r.away.full)) continue;
    team(r.home.full); team(r.away.full);
    if (r.homeScore == null || r.date >= today) continue;
    const hp = r.homeScore > r.awayScore ? 3 : r.homeScore === r.awayScore ? 1 : 0;
    addH2h(r.home.full, r.away.full, hp); addH2h(r.away.full, r.home.full, hp === 3 ? 0 : hp === 1 ? 1 : 3);
    const h = team(r.home.full), a = team(r.away.full);
    h.p++; a.p++; h.gf += r.homeScore; h.ga += r.awayScore; a.gf += r.awayScore; a.ga += r.homeScore;
    if (r.homeScore > r.awayScore) { h.w++; h.pts += 3; a.l++; }
    else if (r.homeScore < r.awayScore) { a.w++; a.pts += 3; h.l++; }
    else { h.d++; a.d++; h.pts++; a.pts++; }
  }
  const list = Object.values(t);
  if (!list.length) return null;
  if (bonus) for (const x of list) x.pts += bonus[x.name] || 0;
  const h2hPts = (a, b) => (h2h[a] && h2h[a][b]) || 0;
  list.sort((x, y) => y.pts - x.pts || y.w - x.w || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf
    || h2hPts(y.name, x.name) - h2hPts(x.name, y.name) || x.name.localeCompare(y.name));
  const cell = v => (numeric || typeof v !== 'number' ? v : String(v));
  return {
    columns: COLUMNS,
    rows: list.map((x, i) => [i + 1, x.name, x.p, x.w, x.l, x.d, x.gf, x.ga, x.pts].map(cell)),
    totalPlayed: list.reduce((s, x) => s + x.p, 0),
    withdrawn: [...withdrawn],
  };
}

module.exports = { computeTable, COLUMNS };
