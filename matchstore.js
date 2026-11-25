// matchstore.js -- local copy of every Belgian league match this season, shared by update.js
// (Olympia calendar, daily 06:30) and standings/archive.js (all-Belgium tables, Mon-Thu 12:15),
// so no match is fetched twice. Kept in .cache/matches/ (not committed).
//
// Filled from the site's download table without a pool or club filter: one call returns every
// match in Belgium for a date range (a league weekend: ~1,000 matches, ~5 MB). A date range is
// always read in full and replaces what the store held for those dates, so moved or deleted
// matches disappear. Each row is tied to its pool by short label + team code (hockeybe.js).
//
// What a sync fetches, per season type (outdoor, indoor), only inside the type's window:
//   history  dates never read, one call per Mon-Sun week (first fill of 2026-27: ~13 calls);
//   recent   the last 3 days, every run: scores are often entered a day or two late;
//   final    one last read of each date once it is 7+ days old, for score corrections; done on
//            Mondays for the whole week, or any day if a date older than 13 days was missed;
//   ahead    the next 14 days, when next week's dates were last read more than 6 days ago.
// Adjacent ranges are merged into one call. A typical day: 1 call per type; Mondays 2.
//
// CLI: node matchstore.js --sync [--max-history=N]   (gap between calls from HB_GAP_MS)
//      node matchstore.js --status

const fs = require('fs');
const path = require('path');
const HB = require('./hockeybe');

const DIR = path.join(__dirname, '.cache', 'matches');
const LIST = path.join(__dirname, '.cache', 'pool_list.json');
const TYPES = ['outdoor', 'indoor'];

const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayOfWeek = iso => new Date(iso + 'T12:00:00Z').getUTCDay();   // 0 = Sunday
const dates = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
const readJson = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } };
const writeJson = (p, v, pretty) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p + '.tmp', JSON.stringify(v, null, pretty ? 1 : 0) + '\n'); fs.renameSync(p + '.tmp', p); };

function seasonYear(today) { const [y, m] = today.split('-').map(Number); return m >= 7 ? y : y - 1; }
function seasonName(today) { const y = seasonYear(today); return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; }
// Store windows. The first outdoor league weekend is the last weekend of August; indoor
// leagues run from late November to February.
function window(type, today) {
  const y = seasonYear(today);
  return type === 'outdoor' ? { from: `${y}-08-24`, to: `${y + 1}-06-30` } : { from: `${y}-11-15`, to: `${y + 1}-03-31` };
}

const file = (today, type) => path.join(DIR, `${seasonName(today)}-${type}.json`);
function load(today, type) { return readJson(file(today, type), { season: seasonName(today), type, readOn: {}, matches: [] }); }
function save(today, type, store) { store.updated = new Date().toISOString(); writeJson(file(today, type), store); }

// ----- pool list (id + full label), needed to tie rows to pools -----
function loadPoolList() { return readJson(LIST, { fetched: null, outdoor: {}, indoor: {} }); }
async function refreshPoolList(today, getPage, log) {
  const list = loadPoolList();
  for (const type of TYPES) {
    const w = HB.seasonWindow(type, today);
    const url = HB.poolListUrl(type, w.from, w.to);
    log(`Fetching pool list (${type}): ${url}`);
    list[type] = HB.parsePoolList(await getPage(url));
    log(`  ${Object.keys(list[type]).length} pools`);
  }
  list.fetched = today;
  writeJson(LIST, list, true);
  return list;
}

function tieToPool(r, poolList) {
  const a = HB.resolvePool(r.home.team, r.pool, poolList), b = HB.resolvePool(r.away.team, r.pool, poolList);
  const ref = a && b && a.id !== b.id ? null : a || b;
  r.poolId = ref ? ref.id : null;
  r.label = ref ? ref.label : null;
  return r;
}

// ----- what to fetch -----
function plan(store, type, today, maxHistory) {
  const w = window(type, today);
  if (today <= w.from) return [];
  const read = store.readOn;
  const ranges = [];
  // history: never read, up to 4 days ago; one call per Mon-Sun week
  const weeks = new Map();
  for (const d of dates(w.from, addDays(today, -4))) {
    if (d > w.to || read[d]) continue;
    const monday = addDays(d, -((dayOfWeek(d) + 6) % 7));
    const r = weeks.get(monday) || { from: d, to: d, why: 'history' };
    r.to = d; weeks.set(monday, r);
  }
  ranges.push(...[...weeks.values()].slice(0, maxHistory));
  // recent: last 3 days (once per day)
  const rFrom = addDays(today, -3) < w.from ? w.from : addDays(today, -3), rTo = addDays(today, -1) > w.to ? w.to : addDays(today, -1);
  if (rFrom <= rTo && dates(rFrom, rTo).some(d => read[d] !== today)) ranges.push({ from: rFrom, to: rTo, why: 'recent' });
  // final: dates 7+ days old whose last read was less than 7 days after them
  const notFinal = dates(w.from, addDays(today, -7)).filter(d => d <= w.to && read[d] && read[d] < addDays(d, 7));
  if (notFinal.length && (dayOfWeek(today) === 1 || notFinal[0] < addDays(today, -13))) {
    let cur = null;
    for (const d of notFinal) {
      if (cur && addDays(cur.to, 1) === d) cur.to = d;
      else { cur = { from: d, to: d, why: 'final' }; ranges.push(cur); }
    }
  }
  // ahead: next 14 days, when next week's dates are stale
  const aTo = addDays(today, 13) > w.to ? w.to : addDays(today, 13);
  if (today <= aTo && dates(today, addDays(today, 6)).some(d => d <= w.to && (!read[d] || read[d] < addDays(today, -6)))) {
    ranges.push({ from: today < w.from ? w.from : today, to: aTo, why: 'ahead' });
  }
  // merge overlapping or adjacent ranges, except history weeks: those stay one call per week
  ranges.sort((a, b) => a.from.localeCompare(b.from));
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    const canMerge = last && last.why !== 'history' && r.why !== 'history';
    if (canMerge && addDays(last.to, 1) >= r.from) { if (r.to > last.to) last.to = r.to; if (!last.why.includes(r.why)) last.why += '+' + r.why; }
    else merged.push({ ...r });
  }
  return merged;
}

// ----- sync -----
async function sync({ today, getPage, log = console.log, maxHistory = Infinity }) {
  let poolList = loadPoolList();
  let calls = 0;
  const stores = {};
  for (const type of TYPES) {
    const store = (stores[type] = load(today, type));
    const todo = plan(store, type, today, maxHistory).sort(() => Math.random() - 0.5);   // no fixed crawl order
    log(`Match store (${type}): ${store.matches.length} matches; ${todo.length ? todo.map(r => `${r.from}..${r.to} (${r.why})`).join(', ') : 'nothing to fetch'}`);
    for (const r of todo) {
      const html = await getPage(HB.allUrl(type, r.from, r.to));
      calls++;
      const rows = HB.parseRows(html).filter(x => x.date >= r.from && x.date <= r.to).map(x => tieToPool(x, poolList[type]));
      const before = store.matches.filter(m => m.date >= r.from && m.date <= r.to);
      // An empty or much shorter answer for dates that had matches is more likely a hiccup
      // than a mass cancellation: keep what we have and try again next run.
      if (before.length >= 20 && rows.length < before.length / 2) {
        log(`  WARN ${r.from}..${r.to}: ${rows.length} matches now against ${before.length} before -- kept the old ones`);
        continue;
      }
      store.matches = store.matches.filter(m => m.date < r.from || m.date > r.to).concat(rows);
      for (const d of dates(r.from, r.to)) store.readOn[d] = today;
      log(`  ${r.from}..${r.to}: ${rows.length} matches (${(html.length / 1048576).toFixed(1)} MB)`);
      save(today, type, store);
    }
  }
  // Rows whose pool is unknown: the pool list may be missing a new pool. Refresh it at most daily.
  const unknown = TYPES.reduce((s, t) => s + stores[t].matches.filter(m => !m.poolId).length, 0);
  if (unknown && poolList.fetched !== today) {
    log(`  ${unknown} matches without a pool -- refreshing the pool list`);
    poolList = await refreshPoolList(today, getPage, log);
    calls += 2;
    for (const type of TYPES) { for (const m of stores[type].matches) if (!m.poolId) tieToPool(m, poolList[type]); save(today, type, stores[type]); }
  }
  for (const type of TYPES) {
    const left = stores[type].matches.filter(m => !m.poolId);
    if (left.length) log(`  ${type}: ${left.length} of ${stores[type].matches.length} matches without a pool, e.g. ${[...new Set(left.map(m => `"${m.pool}" ${m.home.team}`))].slice(0, 4).join('; ')}`);
  }
  return { calls };
}

// All matches of the season per pool id: { poolId: { type, label, rows } }.
function poolMatches(today) {
  const out = {};
  for (const type of TYPES) for (const m of load(today, type).matches) {
    if (!m.poolId) continue;
    const p = (out[m.poolId] = out[m.poolId] || { type, label: m.label, rows: [] });
    p.rows.push(m);
  }
  return out;
}

// Re-tie every stored match to its pool after a change to the matching rules (no calls).
function retie(today) {
  const list = loadPoolList();
  for (const type of TYPES) { const s = load(today, type); for (const m of s.matches) tieToPool(m, list[type]); save(today, type, s); }
}

module.exports = { sync, plan, poolMatches, load, loadPoolList, refreshPoolList, retie, window, seasonName, TYPES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const d = new Date();
  const today = process.env.HB_TODAY || `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (args.includes('--retie')) { retie(today); console.log('re-tied'); }
  if (args.includes('--status')) {
    for (const t of TYPES) {
      const s = load(today, t);
      const read = Object.keys(s.readOn).sort();
      console.log(`${t}: ${s.matches.length} matches, ${s.matches.filter(m => !m.poolId).length} without pool, dates read ${read[0] || '-'}..${read[read.length - 1] || '-'} (${read.length}); next: ${plan(s, t, today, Infinity).map(r => `${r.from}..${r.to} ${r.why}`).join(', ') || 'nothing'}`);
    }
  } else if (args.includes('--sync')) {
    const maxArg = args.find(a => a.startsWith('--max-history='));
    const [gMin, gMax] = (process.env.HB_GAP_MS || '15000-40000').split('-').map(Number);
    const f = HB.makeFetcher({ minGapMs: gMin, maxGapMs: gMax, log: console.log });
    sync({ today, getPage: f.get, maxHistory: maxArg ? Number(maxArg.split('=')[1]) : Infinity })
      .then(r => console.log(`OK -- ${r.calls} calls`))
      .catch(e => { console.log(`FAILED: ${e.message}`); process.exitCode = 1; });
  }
}
