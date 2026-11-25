// hockeybe.js -- read match data from the hockey.be website (relaunched 25 Nov 2026).
//
// The old WordPress JSON feed (/wp-json/sportlink-api/*) is gone. The new site (Craft CMS)
// has one usable source: the HTML table behind the "Download overzicht" button,
//   /nl/competition/download-program-data?programType=<type>&period=<unixFrom> - <unixTo>
// with optional &search=<text> (we use the club name) or &pool[]=<poolId>. It returns every
// row for the period in one response: no paging, no cookie. Past rows carry the score.
// programType 3015 = outdoor, 3019 = indoor. Pool ids are the same numbers as the old feed.
// The pool list (id + full label) is only on the program pages, as filter checkboxes.
// What the new site does NOT publish: pitch per match, league tables, Trimmers matches.

const BASE = 'https://www.hockey.be/nl';
const PROGRAM_TYPE = { outdoor: 3015, indoor: 3019 };
const PROGRAM_PAGE = { outdoor: 'program-outdoor', indoor: 'program-indoor' };
// Name tag sent with every call: a new one each day, no link to the GitHub project (since 25 Nov
// 2026). Never a browser name: we do not pose as a person browsing.
const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const userAgent = () => `ResultsTracker/${localDate()}`;

const MONTHS = { jan: 1, feb: 2, mrt: 3, maa: 3, apr: 4, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12 };
const decode = s => s.replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const text = html => decode(html.replace(/<picture[\s\S]*?<\/picture>/g, '').replace(/<br\s*\/?>/g, ' ')
  .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
// Pool labels use an en dash between category and pool ("U10 Girls – Reg. 3 D"); the old feed
// and the stored data use a hyphen ("U10 Girls - Reg. 3 D").
const normLabel = s => s.replace(/\s+–\s+/g, ' - ');

function isoDate(s) { // "03 okt 2026" -> "2026-10-03"
  const m = s.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})$/i);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  return mo ? `${m[3]}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

// Team cell: <div class="font-semibold ...">Blue Sox</div> <span>Blue Sox U14G-1</span> + logo
// file named after the Sportlink club id. Splitting on the club div keeps two-word clubs whole
// (the old feed's "first word = club" rule turned "Blue Sox U14G-1" into club Blue, team Sox).
function team(cell) {
  const club = text((cell.match(/<div class="font-semibold[^"]*">([\s\S]*?)<\/div>/) || [, ''])[1]);
  const full = text((cell.match(/<span>([\s\S]*?)<\/span>/) || [, ''])[1]);
  const clubId = (cell.match(/\/(C[A-Z0-9]{6})\.(?:png|webp|avif)/) || [, null])[1];
  const code = club && full.startsWith(club + ' ') ? full.slice(club.length + 1) : full;
  return { club, team: code, full, clubId };
}

// Rows of a download-program-data table. Score "3-2" -> homeScore/awayScore; "" when not played.
function parseRows(html) {
  const out = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const tds = tr.match(/<td[\s\S]*?<\/td>/g) || [];
    if (tds.length < 7) continue;
    const date = isoDate(text(tds[0]));
    if (!date) continue;
    const scoreTxt = text(tds[4]);
    const sm = scoreTxt.match(/^(\d+)\s*-\s*(\d+)$/);
    out.push({
      date, time: text(tds[1]).slice(0, 5), pool: text(tds[2]),
      home: team(tds[3]), away: team(tds[5]), location: text(tds[6]),
      homeScore: sm ? +sm[1] : null, awayScore: sm ? +sm[2] : null,
    });
  }
  return out;
}

function parsePoolList(html) { // filter checkboxes -> { poolId: "Category – Pool" }
  const out = {};
  for (const m of html.matchAll(/<input[^>]*name="pool\[\]"[^>]*>/g)) {
    const id = (m[0].match(/value="(\d+)"/) || [])[1];
    const label = (m[0].match(/data-chip-input-label="([^"]*)"/) || [])[1];
    if (id && label) out[id] = decode(label);
  }
  return out;
}

// Which pool categories a club team code can play in. Short pool labels ("Reg. 2 G") repeat
// across categories, so the team code decides: U12B-2 -> "U12 Boys", D-x -> women, etc.
function categoryOk(code, cat) {
  let m;
  if ((m = code.match(/^U(\d+)([BG])-/))) return cat === `U${m[1]} ${m[2] === 'B' ? 'Boys' : 'Girls'}`;
  if (/^D-/.test(code)) return /Women|Ladies/.test(cat) && !/Junior Ladies/.test(cat);
  if (/^H-/.test(code)) return /\bMen\b|Men's/.test(cat);
  if (/^G-/.test(code)) return /Gentlemen/.test(cat);
  if (/^JL-/.test(code)) return /Junior Ladies/.test(cat);
  if (/^T-/.test(code)) return /Trimmers/.test(cat);
  if (/^L-/.test(code)) return /Ladies/.test(cat);
  return false;
}

// Short label on a match row -> { id, label } using the pool list. Cups carry their full name.
function resolvePool(code, short, poolList) {
  const cands = Object.entries(poolList).filter(([, l]) => l === short || l.split(' – ').slice(1).join(' – ') === short);
  const exact = cands.filter(([, l]) => l === short);
  if (exact.length === 1) return { id: exact[0][0], label: normLabel(exact[0][1]) };
  const ok = cands.filter(([, l]) => categoryOk(code, l.split(' – ')[0]));
  if (ok.length === 1) return { id: ok[0][0], label: normLabel(ok[0][1]) };
  return null;
}

const unix = iso => Math.floor(new Date(iso + 'T00:00:00+01:00').getTime() / 1000);
const programUrl = (season, from, to, extra) =>
  `${BASE}/competition/download-program-data?programType=${PROGRAM_TYPE[season]}&period=${unix(from)}%20-%20${unix(to)}${extra}`;
const clubUrl = (season, from, to, search) => programUrl(season, from, to, `&search=${encodeURIComponent(search)}`);
const poolUrl = (season, from, to, poolId) => programUrl(season, from, to, `&pool%5B%5D=${poolId}`);
const poolListUrl = (season, from, to) => `${BASE}/competition-overview/${PROGRAM_PAGE[season]}/?period=${unix(from)}%20-%20${unix(to)}`;

// Season windows. Outdoor: Aug-Jun, indoor: Oct-Mar (indoor pools start late Nov).
function seasonWindow(season, todayIso) {
  const [y, m] = todayIso.split('-').map(Number);
  const start = m >= 7 ? y : y - 1;
  return season === 'outdoor'
    ? { from: `${start}-08-01`, to: `${start + 1}-06-30` }
    : { from: `${start}-10-01`, to: `${start + 1}-03-31` };
}

class Challenged extends Error {}

// Polite fetcher: identifies itself, waits a random gap before every call after the first,
// retries network errors and 5xx twice with long backoff, and stops the whole run on a
// 403/429 or a Cloudflare challenge page instead of pushing through it.
function makeFetcher({ minGapMs, maxGapMs, log }) {
  let calls = 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function get(url) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (calls > 0) await sleep(minGapMs + Math.random() * (maxGapMs - minGapMs));
      calls++;
      let res, body;
      try {
        res = await fetch(url, { headers: { 'User-Agent': userAgent() }, redirect: 'manual', signal: AbortSignal.timeout(90000) });
        body = await res.text();
      } catch (e) {
        if (attempt === 3) throw new Error(`GET ${url} failed after 3 attempts: ${e.message}`);
        log(`  retry ${attempt}/3 (${e.message}) ${url}`);
        await sleep(60000 * attempt);
        continue;
      }
      if (res.status === 403 || res.status === 429 || /<title>Just a moment/i.test(body)) {
        throw new Challenged(`hockey.be refused the request (HTTP ${res.status}${res.status === 200 ? ', challenge page' : ''}): ${url}`);
      }
      if (res.status >= 500 && attempt < 3) { log(`  retry ${attempt}/3 (HTTP ${res.status}) ${url}`); await sleep(60000 * attempt); continue; }
      if (res.status !== 200) throw new Error(`GET ${url} returned HTTP ${res.status}`);
      return body;
    }
  }
  return { get, count: () => calls };
}

module.exports = {
  parseRows, parsePoolList, resolvePool, categoryOk, normLabel, isoDate, seasonWindow,
  clubUrl, poolUrl, poolListUrl, makeFetcher, Challenged, PROGRAM_TYPE, userAgent,
};
