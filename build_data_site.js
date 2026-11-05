// build_data_site.js -- derive OlympiaData/statistiek.html from this repo's index.html.
//
// The Statistiek view moved to the OlympiaData site (Meusini/OlympiaData). Its code and data
// stay in index.html so there is one source: this script copies the page, flips
// data-site="calendar" to "data" (index.html then shows only Statistiek), and writes it next
// to the OlympiaData clone. refresh-local.ps1 runs it after update.ps1 and pushes both repos.
//
// Usage: node build_data_site.js [path-to-OlympiaData]   (default: ..\OlympiaData)
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, 'index.html');
const outDir = process.argv[2] || path.join(__dirname, '..', 'OlympiaData');
const out = path.join(outDir, 'statistiek.html');

const html = fs.readFileSync(src, 'utf8');
const marker = '<html lang="nl" data-site="calendar">';
if (!html.includes(marker)) { console.error('FAIL: site marker not found in index.html'); process.exit(1); }
if (!fs.existsSync(outDir)) { console.error('FAIL: ' + outDir + ' does not exist'); process.exit(1); }

const page = html.replace(marker, '<html lang="nl" data-site="data">')
  .replace('<title>HC Olympia — Velden vandaag</title>', '<title>HC Olympia — Statistiek</title>')
  .replace('<head>', '<head>\n<meta name="robots" content="noindex" />');

const tmp = out + '.tmp';
fs.writeFileSync(tmp, page);
fs.renameSync(tmp, out);
console.log('OK -- wrote ' + out + ' (' + Math.round(page.length / 1024) + ' KB)');
