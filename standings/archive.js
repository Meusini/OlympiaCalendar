// archive.js -- keep the latest table of every Belgian league pool, per season.
//
// Since the hockey.be relaunch (25 Nov 2026) the site publishes no tables, only matches.
// This script makes no calls of its own: it computes every pool's table (../tables.js) from
// the shared match store (../matchstore.js), which the daily 06:30 refresh keeps current.
// Before the relaunch it fetched ~100 official tables a day; those stay in the file until a
// pool has played more matches than they show.
//
// Usage: node standings/archive.js
//
// Rule (2026-10-25): a pool's saved table is replaced only when the total of "Played" went
// up. Otherwise the saved one stays -- youth leagues stop in November and their final table
// must survive whatever hockey.be shows afterwards.
//
// Output: standings/<season>.json, e.g. standings/2026-27.json. build_page.js turns the
// season files into klassementen.html; HockeyCensus/rounds.js reads them too, so the fields
// (label, kind, comp, age, gender, division, group, snapshot{fetchedAt,totalPlayed,columns,rows})
// keep the shape of the old feed.

const fs = require('fs');
const path = require('path');
const MS = require('../matchstore');
const { computeTable } = require('../tables');

const DIR = __dirname;
const now = new Date();
const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const SEASON = MS.seasonName(todayIso);
const STORE = path.join(DIR, `${SEASON}.json`);

// ----- labels -----
// Old feed: "U19 Boys Outdoor - Reg. 2 - A". New site: "U19 Boys – Reg. 2 A" (category, en dash,
// pool). Pools first seen on the new site get a label in the old shape so readers parse both.
const SEASON_MARKER = /\s+(Outdoor|Indoor|Trimmers|Recreatief)(?:\s+Week)?\s*$/;
function parseLabel(label) {
  const [head, ...rest] = label.split(' - ');
  const m = head.match(SEASON_MARKER);
  const kind = m ? m[1].toLowerCase() : '';
  const comp = head.replace(SEASON_MARKER, '').trim();
  const age = (comp.match(/^U(\d+)/) || [])[1];
  let gender = '';
  if (/\b(Boys|Men|Gentlemen|Gentleman|Heren)\b/i.test(comp)) gender = 'M';
  else if (/\b(Girls|Women|Ladies|Dames)\b/i.test(comp)) gender = 'F';
  return { kind, comp, age: age ? Number(age) : null, gender, division: rest[0] || '', group: rest.slice(1).join(' - ') };
}
function oldStyleLabel(newLabel, type) {
  const [cat, ...restParts] = newLabel.split(' – ');
  const rest = restParts.join(' – ');
  const kind = /Trimmers/.test(cat) ? 'Trimmers' : type === 'indoor' ? 'Indoor' : 'Outdoor';
  const m = rest.match(/^((?:Nat|Reg)\.\s*\S+)\s*(?:-\s*)?(.*)$/);
  const division = m ? m[1] : rest, group = m ? m[2] : '';
  return `${cat.replace(/\s+Trimmers$/, '')} ${kind} - ${division}${group ? ' - ' + group : ''}`;
}

// U7-U9 keep no standings (federation rule since 2020-21). Cups are knock-out rounds.
function eligible(p) {
  if (p.age && p.age <= 9) return false;
  if (/Cup|Test-competitie/i.test(p.label)) return false;
  return true;
}

function load() {
  if (!fs.existsSync(STORE)) return { season: SEASON, updated: null, pools: {} };
  return JSON.parse(fs.readFileSync(STORE, 'utf8'));
}
function save(store) {
  store.updated = new Date().toISOString();
  fs.writeFileSync(STORE + '.tmp', JSON.stringify(store, null, 1) + '\n');
  fs.renameSync(STORE + '.tmp', STORE);
}

function main() {
  const store = load();
  console.log(`=== standings archive ${now.toISOString()} season ${SEASON} (from the match store) ===`);
  const poolList = MS.loadPoolList();
  const matches = MS.poolMatches(todayIso);
  const stamp = now.toISOString();

  // Pools on the site's pool list or with matches in the store; new ones get their metadata.
  let added = 0;
  for (const type of MS.TYPES) for (const [id, raw] of Object.entries(poolList[type] || {})) {
    if (!store.pools[id]) {
      const label = oldStyleLabel(raw, type);
      store.pools[id] = { firstSeen: todayIso, label, ...parseLabel(label) };
      added++;
    }
    store.pools[id].lastListed = poolList.fetched || todayIso;
  }

  let changed = 0, kept = 0, noMatches = 0, considered = 0;
  for (const [id, p] of Object.entries(store.pools)) {
    if (!eligible(p)) continue;
    const m = matches[id];
    if (!m) { noMatches++; continue; }
    considered++;
    // Shoot-out bonus points (national youth): the new site shows only the drawn score, so keep
    // each team's bonus from the last official table before it is first replaced.
    if (p.snapshot && !p.snapshot.source && !p.bonus) {
      const c = p.snapshot.columns, iW = c.indexOf('Won'), iD = c.indexOf('Draw'), iP = c.indexOf('Points');
      const b = {};
      for (const r of p.snapshot.rows) { const extra = Number(r[iP]) - 3 * Number(r[iW]) - Number(r[iD]); if (extra > 0) b[r[1]] = extra; }
      if (Object.keys(b).length) { p.bonus = b; console.log(`  ${id} ${p.label}: shoot-out bonus kept for ${Object.keys(b).length} teams`); }
    }
    const table = computeTable(m.rows, todayIso, { numeric: true, bonus: p.bonus || null });
    if (!table) { noMatches++; continue; }
    p.lastChecked = stamp;
    const snap = p.snapshot;
    if (!snap || table.totalPlayed > snap.totalPlayed) {
      p.snapshot = { fetchedAt: stamp, totalPlayed: table.totalPlayed, columns: table.columns, rows: table.rows, source: 'computed from hockey.be matches' };
      p.unchanged = 0;
      changed++;
    } else {
      if (table.totalPlayed < snap.totalPlayed) console.log(`  NOTE ${id} ${p.label}: played ${table.totalPlayed} against ${snap.totalPlayed} saved, keeping saved table`);
      p.unchanged = (p.unchanged || 0) + 1;
      kept++;
    }
  }
  save(store);
  console.log(`  ${considered} pools with matches: ${changed} updated, ${kept} kept; ${noMatches} without matches in the store; ${added} new pools`);
}

main();
