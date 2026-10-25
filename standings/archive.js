// archive.js -- keep the latest standing of every Belgian league pool, per season.
//
// Usage:
//   node standings/archive.js            (scheduled run: only the pools due today)
//   node standings/archive.js --all      (every eligible pool, e.g. the first fill)
//   node standings/archive.js --gap=3000,8000   (random pause between calls, ms)
//
// Rule (Bart, 2026-10-25): a pool's saved standing is replaced only when the total of
// "Played" went up. Otherwise the saved one stays -- youth leagues stop in November and
// their final table must survive whatever hockey.be shows afterwards.
//
// Spreading the load: each pool belongs to one weekday slot (Mon..Thu, poolId % 4), so a
// full sweep of ~400 outdoor pools is ~100 calls a day, after the weekend's games. A pool
// whose standing has not moved for 3 checks is only re-checked every other week. A pool
// that missed its slot (machine off) is picked up on the next run.
//
// Output: standings/<season>.json, e.g. standings/2026-27.json. build_page.js turns the
// season files into klassementen.html.

const fs = require('fs');
const path = require('path');

const UA = 'OlympiaCalendar/1.0 (+https://github.com/Meusini/OlympiaCalendar)';
const API = 'https://hockey.be/wp-json/sportlink-api';
const KALENDER = 'https://hockey.be/nl/competitie/kalender-resultaten-en-rangschikkingen/';
const DIR = __dirname;

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const gapArg = (args.find(a => a.startsWith('--gap=')) || '').slice(6);
const [GAP_MIN, GAP_MAX] = gapArg ? gapArg.split(',').map(Number) : [3000, 8000];

const DAY = 24 * 3600 * 1000;
const now = new Date();
const todayIso = now.toISOString().slice(0, 10);

// Season runs Aug -> Jul. Pool ids are new every season, so each season gets its own file.
function seasonOf(d) {
  const y = d.getFullYear();
  const start = d.getMonth() >= 6 ? y : y - 1;   // July counts as the new season
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
const SEASON = seasonOf(now);
const STORE = path.join(DIR, `${SEASON}.json`);

// ----- label parsing -----
// "U19 Boys Outdoor Week - Reg. 2 - A"
// "Open League Men Outdoor Week - Reg. 2 - OL - HV - A"
// "Men Indoor Week - Nat. 1 - B"
const SEASON_MARKER = /\s*\b(Outdoor|Indoor|Trimmers|Recreatief)\s+Week\b/;
function parseLabel(label) {
  const m = label.match(SEASON_MARKER);
  const kind = m ? m[1].toLowerCase() : '';
  const [head, ...rest] = label.split(' - ');
  const comp = head.replace(SEASON_MARKER, '').trim();
  const age = (comp.match(/^U(\d+)/) || [])[1];
  let gender = '';
  if (/\b(Boys|Men|Gentlemen|Gentleman|Heren)\b/i.test(comp)) gender = 'M';
  else if (/\b(Girls|Women|Ladies|Dames)\b/i.test(comp)) gender = 'F';
  return {
    kind,                       // outdoor | indoor | trimmers | recreatief
    comp,                       // "U19 Boys", "Open League Men", ...
    age: age ? Number(age) : null,
    gender,
    division: rest[0] || '',    // "Nat. 1", "Reg. 2", ...
    group: rest.slice(1).join(' - '),
  };
}

// U7-U9 keep no standings (federation rule since 2020-21: "plus aucun classement
// jusqu'en U9"). Cups are knock-out rounds, not tables.
function eligible(p) {
  if (p.age && p.age <= 9) return false;
  if (/Cup|Test-competitie/i.test(p.label)) return false;
  return true;
}
// Indoor runs Dec-Feb; outdoor everything except the summer break.
function inWindow(p) {
  const mo = now.getMonth() + 1;
  if (p.kind === 'indoor') return mo === 12 || mo <= 2;
  return !(mo === 7 || (mo === 8 && now.getDate() < 15));
}

// ----- http -----
const sleep = ms => new Promise(r => setTimeout(r, ms));
const gap = () => sleep(GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN));
let consecutive403 = 0;
async function get(url, asText) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
      if (res.status === 403) consecutive403++;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      consecutive403 = 0;
      return asText ? await res.text() : await res.json();
    } catch (e) {
      if (attempt === 3) throw new Error(`GET ${url} failed after 3 attempts: ${e.message}`);
      console.log(`  retry ${attempt}/3 (${e.message}) ${url}`);
      await sleep(15000 * attempt);
    }
  }
}
const strip = v => typeof v === 'string' ? v.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim() : v;

// ----- store -----
function load() {
  if (!fs.existsSync(STORE)) return { season: SEASON, updated: null, pools: {} };
  return JSON.parse(fs.readFileSync(STORE, 'utf8'));
}
function save(store) {
  store.updated = new Date().toISOString();
  const tmp = STORE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1) + '\n');
  fs.renameSync(tmp, STORE);
}

async function poolList() {
  try {
    const html = await get(KALENDER, true);
    const sel = (html.match(/<select name="poolid"[^>]*>([\s\S]*?)<\/select>/) || [])[1] || '';
    return [...sel.matchAll(/<option value="(\d+)"[^>]*>([^<]+)<\/option>/g)]
      .map(m => ({ id: m[1], label: m[2].replace(/&amp;/g, '&').trim() }));
  } catch (e) {
    console.log(`  WARN: pool list fetch failed: ${e.message}`);
    return [];
  }
}

function due(p, slot) {
  if (ALL) return true;
  const since = p.lastChecked ? (now - new Date(p.lastChecked)) / DAY : Infinity;
  const interval = (p.unchanged || 0) >= 3 ? 13 : 6;
  if (since === Infinity) return slot;                 // new pool: wait for its own day
  if (slot && since >= interval) return true;
  return since >= interval + 3;                        // missed its day: catch up
}

async function main() {
  const store = load();
  console.log(`=== standings archive ${now.toISOString()} season ${SEASON}${ALL ? ' (--all)' : ''} ===`);

  const listed = await poolList();
  console.log(`  pool list: ${listed.length} pools`);
  if (!listed.length) console.log('  pool list empty -- working from the pools already in the store');
  for (const { id, label } of listed) {
    const p = store.pools[id] || (store.pools[id] = { firstSeen: todayIso });
    Object.assign(p, { label, ...parseLabel(label), lastListed: todayIso });
  }

  const weekday = now.getDay();                        // Mon=1 .. Thu=4
  const todo = Object.entries(store.pools).filter(([id, p]) =>
    eligible({ ...p, label: p.label }) && inWindow(p) && due(p, weekday >= 1 && weekday <= 4 && (Number(id) % 4) + 1 === weekday));
  console.log(`  due today: ${todo.length} pools (gap ${GAP_MIN}-${GAP_MAX} ms)`);

  let changed = 0, kept = 0, empty = 0, failed = 0, n = 0;
  for (const [id, p] of todo) {
    if (consecutive403 >= 4) { console.log('  ABORT: repeated 403s -- Cloudflare is challenging this connection'); break; }
    await gap();
    n++;
    let resp;
    try { resp = await get(`${API}/standing?poolid=${id}`); }
    catch (e) { console.log(`  WARN ${id}: ${e.message}`); failed++; continue; }
    p.lastChecked = new Date().toISOString();

    const columns = (resp.columns || []).map(c => c.title);
    const rows = (resp.data || []).map(r => r.map(strip));
    const iPlayed = columns.indexOf('Played');
    if (!rows.length || iPlayed < 0) { p.unchanged = (p.unchanged || 0) + 1; empty++; continue; }
    const total = rows.reduce((s, r) => s + (Number(r[iPlayed]) || 0), 0);

    const snap = p.snapshot;
    if (!snap || total > snap.totalPlayed) {
      p.snapshot = { fetchedAt: p.lastChecked, totalPlayed: total, columns, rows };
      p.unchanged = 0;
      changed++;
    } else {
      if (total < snap.totalPlayed) console.log(`  NOTE ${id} ${p.label}: played went down ${snap.totalPlayed} -> ${total}, keeping saved table`);
      p.unchanged = (p.unchanged || 0) + 1;
      kept++;
    }
    if (n % 25 === 0) { save(store); console.log(`  ... ${n}/${todo.length}`); }
  }
  save(store);
  console.log(`  done: ${n} calls -- ${changed} updated, ${kept} kept, ${empty} empty, ${failed} failed`);
  if (failed > todo.length / 2 && todo.length > 4) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
