# HC Olympia — Velden & Teams

Single-page web app showing daily field assignments, team standings, and weekly results
for HC Olympia Antwerpen. Reads live from the hockey.be Sportlink API on a weekly schedule
and serves a fully static `index.html`.

## Local use

Double-click `index.html` or open it in any browser. The page renders from the data
embedded inside the file — no network call at load time.

## Refreshing the schedule data

```powershell
pwsh -File update.ps1
```

This script pulls upcoming games, past results, pool standings, and pool-wide weekly games
from `hockey.be/wp-json/sportlink-api/*`, then rewrites the `<script id="games-data">`
block inside `index.html`.

## Training schedule

The weekly outdoor training schedule (Sportieve Cel sheet, versie 25/6/26) is embedded as a
static block in `index.html` — the `TRAINING_SCHEDULE` constant near the top of the script.
Trainings render inside Veldbezetting next to the matches (hatched, dashed blocks; quarters
A–D as on the sheet). Conditietraining is left out because it uses no pitch. The schedule only
applies inside the outdoor windows in `TRAINING_SEASONS` (late Aug → end Nov, Mar → Jun);
edit both constants by hand when the club publishes a new version. `update.ps1` never touches
them — it only rewrites the `<script id="games-data">` block. A training that collides with a
home match on the same pitch area is flagged ⚠ rather than hidden.

## Standings archive (klassementen.html)

`klassementen.html` shows the standing of every Belgian league pool, not just Olympia's,
and keeps them after the season ends. `standings/archive.js` fetches them into
`standings/<season>.json`; `standings/build_page.js` embeds those files into the page.

- A pool's saved table is replaced only when its total of games played went up, so the
  youth tables that end in November stay as they were on the last match day.
- U7-U9 are skipped: the federation keeps no rankings there. Cups are skipped too.
- The load is spread: each pool has one weekday slot (Mon-Thu, `poolId % 4`), so a full
  sweep is ~100 calls a day, 3-8 s apart, after the weekend's games. Pools that have not
  moved for 3 checks drop to every other week. Indoor pools are only checked Dec-Feb.
- Runs from the **OlympiaCalendar Standings** scheduled task (`archive-local.ps1`,
  Mon-Thu 12:15), which commits and pushes like the daily refresh. Log: `archive-local.log`.
- Fill or re-check everything at once: `node standings/archive.js --all --gap=1500,3000`.

## Published online

Deployed via GitHub Pages from this repo's `main` branch.

The daily refresh runs on Bart's machine, not in CI. The **OlympiaCalendar Refresh**
scheduled task runs `refresh-local.ps1` at 07:30 — it pulls, runs `update.ps1`, and
commits and pushes `index.html` if the data changed. Pages then serves the new version.

It lives there because hockey.be sits behind Cloudflare, which serves its JavaScript
challenge to GitHub-hosted runners: the first request of a process succeeds and every
one after it returns 403, whatever the pacing. From a home connection all ~150 calls of
a full run pass untouched. `.github/workflows/refresh.yml` is kept on manual trigger
only, for the day a self-hosted runner on a normal connection makes CI viable again.

Check on it with `Get-ScheduledTask OlympiaCalendar*`, or read `refresh-local.log`.
