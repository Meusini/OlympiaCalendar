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
  const plain = m[2];
  JSON.parse(plain);   // refuse to encrypt garbage

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
    .replace('<head>', '<head>\n<meta name="robots" content="noindex" />')
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
