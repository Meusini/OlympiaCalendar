// build_page.js -- embed every standings/<season>.json into klassementen.html.
//
// Rewrites only the <script id="standings-data"> block, the same way update.ps1 treats
// index.html, so the page renders from file:// and from Pages without a network call.
//
// Usage: node standings/build_page.js

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const PAGE = path.join(DIR, '..', 'klassementen.html');

const seasons = fs.readdirSync(DIR)
  .filter(f => /^\d{4}-\d{2}\.json$/.test(f))
  .map(f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))
  .map(s => ({
    season: s.season,
    updated: s.updated,
    // Only pools with a saved table; drop the scheduling fields the page does not use.
    pools: Object.entries(s.pools)
      .filter(([, p]) => p.snapshot && p.snapshot.rows.length)
      .map(([id, p]) => ({
        id, label: p.label, kind: p.kind, comp: p.comp, age: p.age, gender: p.gender,
        division: p.division, group: p.group,
        fetchedAt: p.snapshot.fetchedAt, lastChecked: p.lastChecked,
        cols: p.snapshot.columns, rows: p.snapshot.rows,
      })),
  }));

const json = JSON.stringify({ seasons }).replace(/</g, '\\u003c');
const html = fs.readFileSync(PAGE, 'utf8');
const re = /(<script id="standings-data" type="application\/json">)[\s\S]*?(<\/script>)/;
if (!re.test(html)) throw new Error('standings-data block not found in klassementen.html');
fs.writeFileSync(PAGE, html.replace(re, (_, open, close) => `${open}\n${json}\n${close}`));

const n = seasons.reduce((s, x) => s + x.pools.length, 0);
console.log(`klassementen.html: ${seasons.length} season(s), ${n} pools, ${(json.length / 1024).toFixed(0)} KB`);
