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
