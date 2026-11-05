// build_data_site.js -- derive OlympiaData/statistiek.html from this repo's index.html.
//
// The Statistiek view moved to the OlympiaData site (Meusini/OlympiaData), behind the census
// password. Its code and data stay in index.html so there is one source. This script:
//   1. copies index.html and flips data-site="calendar" to "data" (only Statistiek shows);
//   2. encrypts the games-data JSON with the Statistiek data key (AES-256-GCM) and empties the
//      clear-text block, so the public repo holds ciphertext only;
//   3. embeds OlympiaData/stats_key.json, the data key wrapped under the census password.
// The data key lives on the box only (HockeyCensus/secrets/stats_dek.key); set it up with
// `node stats_key.js` in HockeyCensus. Unchanged data keeps the old ciphertext, so a quiet day
// makes no commit.
//
// Usage: node build_data_site.js [path-to-OlympiaData]   (default: ..\OlympiaData)
// Exit 2 = not set up yet (no data key or no stats_key.json); nothing written.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, 'index.html');
const outDir = process.argv[2] || path.join(__dirname, '..', 'OlympiaData');
const out = path.join(outDir, 'statistiek.html');
const dekFile = process.env.STATS_DEK_FILE || path.join(__dirname, '..', 'HockeyCensus', 'secrets', 'stats_dek.key');
const keyFile = path.join(outDir, 'stats_key.json');
const b64 = u => Buffer.from(u).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
const DATA_RE = /(<script id="games-data" type="application\/json">)([\s\S]*?)(<\/script>)/;
const BOX_RE = /<script id="stats-box" type="application\/json">([\s\S]*?)<\/script>/;

// Statistiek > Clubs: W/G/V per club over every outdoor league pool in Belgium, from the standings
// archive (standings/<season>.json, kept by archive.js). U7-U9 and cups have no standings.
// Joint teams of two clubs ("Ping/Well M-1") are left out: they belong to neither club alone.
// Row: [club, seg, sex, played, won, draw, lost, teams, kind]; seg adult|upper|mid, sex B|G|X (mixed), kind outdoor|indoor.
const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
function clubOf(team) {
  return String(team || '').replace(/\s+(U\d+[BG]?|D|H|G|JL|JM|M|L|T)\s?-?\s?\d+.*$/i, '').trim();
}
function allClubs() {
  const dir = path.join(__dirname, 'standings');
  const file = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).sort().pop();
  if (!file) return null;
  const pools = Object.values(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).pools || {});
  const agg = new Map();
  let used = 0, joint = 0, last = '';
  const byKind = { outdoor: 0, indoor: 0 };
  for (const p of pools) {
    const st = p.snapshot;
    if (!st || (p.kind !== 'outdoor' && p.kind !== 'indoor') || /cup|test/i.test(p.comp || '')) continue;
    const c = st.columns || [], ix = n => c.indexOf(n);
    const iT = ix('Team'), iP = ix('Played'), iW = ix('Won'), iD = ix('Draw'), iL = ix('Lost');
    if ([iT, iP, iW, iD, iL].some(i => i < 0)) continue;
    const age = p.age == null ? null : +p.age;
    if (age !== null && age < 10) continue;
    const seg = age === null ? 'adult' : age >= 14 ? 'upper' : 'mid';
    const sex = p.gender === 'M' ? 'B' : p.gender === 'F' ? 'G' : 'X';
    used++; byKind[p.kind]++;
    if ((p.lastChecked || '') > last) last = p.lastChecked;
    for (const r of st.rows) {
      if (/\//.test(r[iT])) { joint++; continue; }
      const club = clubOf(r[iT]);
      if (!club || !(+r[iP] > 0)) continue;
      const k = club + '|' + seg + '|' + sex + '|' + p.kind;
      const o = agg.get(k) || [club, seg, sex, 0, 0, 0, 0, 0, p.kind];
      o[3] += +r[iP] || 0; o[4] += +r[iW] || 0; o[5] += +r[iD] || 0; o[6] += +r[iL] || 0; o[7]++;
      agg.set(k, o);
    }
  }
  const d = last ? new Date(last) : null;
  return { pools: used, poolsByKind: byKind, joint, asOf: d ? d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() : '',
    rows: [...agg.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2])) };
}

async function main() {
  if (!fs.existsSync(outDir)) { console.error('FAIL: ' + outDir + ' does not exist'); process.exit(1); }
  if (!fs.existsSync(dekFile) || !fs.existsSync(keyFile)) {
    console.error('NOT SET UP: run `node stats_key.js` in HockeyCensus (needs the census password). statistiek.html not built.');
    process.exit(2);
  }
  const html = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
  const marker = '<html lang="nl" data-site="calendar">';
  if (!html.includes(marker)) { console.error('FAIL: site marker not found in index.html'); process.exit(1); }
  const m = html.match(DATA_RE);
  if (!m) { console.error('FAIL: games-data block not found'); process.exit(1); }
  const games = JSON.parse(m[2]);   // refuse to encrypt garbage
  games.allClubs = allClubs();
  const plain = JSON.stringify(games);

  const key = await crypto.subtle.importKey('raw', unb64(fs.readFileSync(dekFile, 'utf8').trim()), 'AES-GCM', false, ['encrypt', 'decrypt']);

  // Reuse yesterday's ciphertext when the data did not change.
  let box = null;
  if (fs.existsSync(out)) {
    const old = (fs.readFileSync(out, 'utf8').match(BOX_RE) || [])[1];
    if (old) {
      try {
        const o = JSON.parse(old);
        const dec = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, key, unb64(o.ct)));
        if (dec === plain) box = o;
      } catch (e) { /* new key or corrupt: encrypt afresh */ }
    }
  }
  if (!box) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
    box = { v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  }
  const wrapped = JSON.stringify(JSON.parse(fs.readFileSync(keyFile, 'utf8')));

  const page = html.replace(marker, '<html lang="nl" data-site="data">')
    .replace('<title>HC Olympia — Velden vandaag</title>', '<title>HC Olympia — Statistiek</title>')
    .replace('<head>', '<head>\n<meta name="robots" content="noindex" />\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />')
    .replace(DATA_RE, (_, open, __, close) => open + '{}' + close +
      '\n<script id="stats-key" type="application/json">' + wrapped + '</script>' +
      '\n<script id="stats-box" type="application/json">' + JSON.stringify(box) + '</script>');

  if (page.includes(plain.slice(0, 200))) { console.error('FAIL: clear-text data still in the page'); process.exit(1); }
  const tmp = out + '.tmp';
  fs.writeFileSync(tmp, page);
  fs.renameSync(tmp, out);
  console.log('OK -- wrote ' + out + ' (' + Math.round(page.length / 1024) + ' KB, data encrypted)');
}

main().catch(e => { console.error('FAIL: ' + e.message); process.exit(1); });
