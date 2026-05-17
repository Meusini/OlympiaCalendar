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

Deployed via GitHub Pages from this repo's `main` branch. A GitHub Actions workflow
(`.github/workflows/refresh.yml`) runs `update.ps1` every Monday at 06:00 UTC, commits
the refreshed `index.html`, and pushes. Pages then serves the new version.
