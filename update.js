// update.js -- refresh the embedded data in index.html from the new hockey.be site.
// Replaces update.ps1, whose WordPress JSON feed disappeared with the relaunch of 25 Nov 2026.
//
// Calls per run (all to www.hockey.be, random 15-40 s apart, see hockeybe.js):
//   2  club program, outdoor + indoor: every Olympia match, home and away, 180 days back to
//      90 days ahead, with scores. Also tells us which pools our teams play in.
//   ~2 (Mondays ~4) the match store sync (matchstore.js): every Belgian match of the last
//      days and the next two weeks, shared with the standings archive. The other matches in
//      our pools and the league tables (the new site publishes none, tables.js computes
//      them) come from that store, so no pool is fetched twice.
//   0-2 pool lists (id + full label), only when a pool label is unknown, at most daily.
//
// Output keeps the shape update.ps1 wrote into <script id="games-data">:
//   fieldGames, teamGames, results, teams[{code,season,division,poolId,standing}], poolGames.
// Lost with the relaunch: the pitch per home match (fieldCode/subpath). Known pitches of
// future home matches are kept from the last data that had them; past ones are carried as before.
//
// Usage: node update.js [--out <file>]
// Test hooks: HB_TODAY=YYYY-MM-DD, HB_GAP_MS=min-max, HB_NO_SYNC=1 (use the store as it is).

const fs = require('fs');
const path = require('path');
const HB = require('./hockeybe');
const MS = require('./matchstore');
const { computeTable } = require('./tables');

const CLUB = 'Olympia';
const DAYS_BACK = 180, DAYS_FWD = 90;
const POOL_WINDOW = 14;            // poolGames: days back and ahead
const HOME_ADDRESS = /Vogelzanglaan 6\b/;   // our outdoor pitches; no venue text needed there
const NO_SCORES = /^U[789][BG]-/;  // the federation keeps no scores or tables for U7-U9

const here = __dirname;
const args = process.argv.slice(2);
const outPath = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : path.join(here, 'index.html');
const htmlPath = path.join(here, 'index.html');
const log = (...a) => console.log(...a);

const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const today = process.env.HB_TODAY || localToday();
const [gapMin, gapMax] = (process.env.HB_GAP_MS || '15000-40000').split('-').map(Number);
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 1) + '\n'); };
const scoreText = r => (r.homeScore != null ? `${r.homeScore} - ${r.awayScore}` : '');

const fetcher = HB.makeFetcher({ minGapMs: gapMin, maxGapMs: gapMax, log });
const getPage = url => fetcher.get(url);

async function main() {
  log(`=== update.js ${today} ===`);
  if (!fs.existsSync(htmlPath)) throw new Error('index.html not found');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const blockRe = /(<script id="games-data" type="application\/json">)([\s\S]*?)(<\/script>)/;
  const oldBlock = html.match(blockRe);
  if (!oldBlock) throw new Error('Embedded data block not found in index.html');
  const old = JSON.parse(oldBlock[2]);

  // ----- 1. Club program: every Olympia match, both seasons -----
  const from = addDays(today, -DAYS_BACK), to = addDays(today, DAYS_FWD);
  const club = {};
  for (const season of ['outdoor', 'indoor']) {
    const url = HB.clubUrl(season, from, to, CLUB);
    log(`Fetching club program (${season}): ${url}`);
    const rows = HB.parseRows(await getPage(url))
      .filter(r => (r.home.club === CLUB || r.away.club === CLUB) && r.date >= from && r.date <= to);
    log(`  ${rows.length} ${CLUB} matches`);
    club[season] = rows;
  }

  // ----- 2. Pool list, to turn a row's short label into pool id + full label -----
  let poolList = MS.loadPoolList();
  const resolveAll = () => {
    const missing = [];
    for (const season of ['outdoor', 'indoor']) for (const r of club[season]) {
      const code = r.home.club === CLUB ? r.home.team : r.away.team;
      r.season = season; r.code = code; r.isHome = r.home.club === CLUB;
      r.poolRef = HB.resolvePool(code, r.pool, poolList[season]);
      if (!r.poolRef) missing.push(`${code} ${season} "${r.pool}"`);
    }
    return missing;
  };
  let missing = resolveAll();
  if (missing.length && poolList.fetched !== today) {
    poolList = await MS.refreshPoolList(today, getPage, log);
    missing = resolveAll();
  }
  // Unresolved rows keep their short label as division and get no pool (cup rounds that
  // close, a new category). Not fatal: the match still shows, only without a table.
  for (const m of [...new Set(missing)]) log(`  WARN: no pool for ${m}`);

  // ----- 3. Teams and their current pool (most common upcoming division, else past) -----
  const all = [...club.outdoor, ...club.indoor];
  const divOf = r => (r.poolRef ? r.poolRef.label : r.pool);
  const tally = {};
  for (const r of all) {
    const k = `${r.code}|${r.season}`, upcoming = r.date >= today;
    if (!upcoming && NO_SCORES.test(r.code)) continue;   // parity with the old feed: past U7-U9 not listed
    const t = (tally[k] = tally[k] || { up: {}, past: {}, ref: {} });
    const bucket = upcoming ? t.up : t.past;
    bucket[divOf(r)] = (bucket[divOf(r)] || 0) + 1;
    if (r.poolRef) t.ref[divOf(r)] = r.poolRef;
  }
  const pick = b => Object.entries(b).sort((a, c) => c[1] - a[1])[0];
  const teamPools = [];
  for (const [k, t] of Object.entries(tally).sort()) {
    const [code, season] = k.split('|');
    const top = pick(t.up) || pick(t.past);
    if (!top) continue;
    const ref = t.ref[top[0]] || null;
    teamPools.push({ code, season, division: top[0], poolId: ref ? ref.id : null });
  }

  // ----- 4. Our pools: league tables + pool-wide games, from the shared match store -----
  if (process.env.HB_NO_SYNC) log('Match store: not synced (HB_NO_SYNC)');
  else {
    try { await MS.sync({ today, getPage, log }); }
    catch (e) {
      if (e instanceof HB.Challenged) throw e;
      log(`  WARN: match store sync failed, using what it holds: ${e.message}`);
    }
  }
  const store = MS.poolMatches(today);
  const wanted = new Map();
  for (const t of teamPools) if (t.poolId && !NO_SCORES.test(t.code)) wanted.set(t.poolId, t.season);
  const pools = {};
  for (const id of wanted.keys()) {
    if (store[id]) pools[id] = store[id];
    else log(`  WARN: pool ${id} has no matches in the store`);
  }
  log(`Pools: ${wanted.size} needed, ${Object.keys(pools).length} in the match store`);
  const standing = rows => {
    const t = computeTable(rows, today);
    return t ? { columns: t.columns, rows: t.rows, computed: true } : null;
  };

  const teams = teamPools.map(t => ({
    code: t.code, season: t.season, division: t.division, poolId: t.poolId,
    standing: t.poolId && pools[t.poolId] && !NO_SCORES.test(t.code) ? standing(pools[t.poolId].rows) : null,
  }));
  const poolGames = {};
  for (const id of wanted.keys()) {
    const p = pools[id];
    if (!p) continue;
    const label = p.label || HB.normLabel((teamPools.find(t => t.poolId === id) || {}).division || '');
    poolGames[id] = p.rows
      .filter(r => r.date >= addDays(today, -POOL_WINDOW) && r.date <= addDays(today, POOL_WINDOW))
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
      .map(r => ({
        date: r.date, time: r.time, division: label, isPast: r.date < today || r.homeScore != null,
        homeClub: r.home.club, homeTeam: r.home.team, awayClub: r.away.club, awayTeam: r.away.team,
        score: scoreText(r), homeScore: r.homeScore, awayScore: r.awayScore,
      }));
  }

  // ----- 5. Matches and results -----
  // Pitches: the new site has none. Keep the pitch of a future home match from the last data
  // that had it, as long as the same match (date, time, our team) is still on the program.
  const oldPitch = {};
  for (const g of old.fieldGames || []) if (g.date >= today) oldPitch[`${g.date}|${g.time}|${g.homeTeam}`] = g;

  const teamGames = [], results = [];
  for (const r of all.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))) {
    const opp = r.isHome ? r.away : r.home;
    const base = { date: r.date, time: r.time, isHome: r.isHome, division: divOf(r), olympiaTeam: r.code, season: r.season };
    if (r.date >= today) {
      const pitch = r.isHome ? oldPitch[`${r.date}|${r.time}|${r.code}`] : null;
      teamGames.push({
        ...base,
        venue: r.isHome && HOME_ADDRESS.test(r.location) ? '' : r.location,
        opponentClub: opp.club, opponentTeam: opp.team,
        fieldCode: pitch ? pitch.fieldCode : null, subpath: pitch ? pitch.subpath : [],
      });
    } else if (!NO_SCORES.test(r.code)) {
      const os = r.isHome ? r.homeScore : r.awayScore, ts = r.isHome ? r.awayScore : r.homeScore;
      results.push({ ...base, opponentClub: opp.club, opponentTeam: opp.team, score: scoreText(r), olympiaScore: os, opponentScore: ts });
    }
  }
  results.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));

  // A season whose club call came back empty keeps what is embedded now, so one bad answer
  // cannot wipe it. Between seasons that is also what we want.
  for (const season of ['outdoor', 'indoor']) {
    if (club[season].length) continue;
    const keepT = (old.teamGames || []).filter(g => g.season === season && g.date >= today);
    const keepR = (old.results || []).filter(g => (g.season || 'outdoor') === season && g.date >= from);
    if (keepT.length || keepR.length) log(`  ${season}: no answer, keeping ${keepT.length} matches and ${keepR.length} results already embedded`);
    teamGames.push(...keepT); results.push(...keepR);
  }
  if (!teamGames.length && !results.length) {
    log('No matches for either season (off-season, or the site is not answering). index.html left untouched.');
    return { calls: fetcher.count(), written: false };
  }

  // Field occupancy: past days carried as before (300 days); future home matches with a known pitch.
  const keepFrom = addDays(today, -300);
  const fieldGames = (old.fieldGames || []).filter(g => g.date < today && g.date >= keepFrom);
  const carried = fieldGames.length;
  for (const g of teamGames) if (g.isHome && g.fieldCode) {
    fieldGames.push({ date: g.date, time: g.time, fieldCode: g.fieldCode, subpath: g.subpath, division: g.division, homeTeam: g.olympiaTeam, awayClub: g.opponentClub, awayTeam: g.opponentTeam });
  }
  fieldGames.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const futureHome = teamGames.filter(g => g.isHome && g.venue === '').length;

  const payload = {
    updated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    source: HB.clubUrl('outdoor', from, to, CLUB),
    fieldGames, teamGames, results, teams, poolGames,
  };
  const json = JSON.stringify(payload);
  const outHtml = (outPath === htmlPath ? html : fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : html)
    .replace(blockRe, (m, a, b, c) => `${a}\n${json}\n${c}`);
  fs.writeFileSync(outPath + '.tmp', outHtml);
  fs.renameSync(outPath + '.tmp', outPath);

  // Team -> pool map, kept for the other scripts that read it.
  if (outPath === htmlPath) {
    const tm = {};
    for (const t of teams) if (t.poolId) tm[t.season === 'indoor' ? `${t.code}|indoor` : t.code] = { poolId: t.poolId, division: t.division };
    writeJson(path.join(here, 'pool_map.json'), { note: 'team code -> poolId of the pool the team plays in now. Written by update.js.', updated: today, teams: tm });
  }

  log(`  field games: ${carried} past carried, ${fieldGames.length - carried} future with a known pitch, ${futureHome} future home matches in total`);
  log(`OK -- wrote ${teamGames.length} matches, ${results.length} results, ${teams.length} teams (${teams.filter(t => t.standing).length} with a table), ${Object.keys(poolGames).length} pools, ${(json.length / 1024).toFixed(1)} KB, ${fetcher.count()} calls to hockey.be`);
  return { calls: fetcher.count(), written: true };
}

// Everything goes to stdout: refresh-local.ps1 copies it into its log and quotes the FAILED line.
main().catch(e => { console.log(`FAILED: ${e.message}`); process.exitCode = 1; });
