# update.ps1 — Refresh embedded data in index.html
#
# Pulls from the hockey.be Sportlink connector:
#   1. Field games (upcoming, Olympia home games WITH field/subpath info — for the field views)
#   2. Team games (upcoming, ALL Olympia games — home + away — for the team page)
#   3. Results   (past, ALL Olympia games with scores)
#   4. Pool mapping (kalender page form) so we can fetch standings per pool
#   5. Standings (one call per unique Olympia pool)
#
# Output is embedded directly into the <script id="games-data"> block of index.html.
# The HTML does no network calls at load time.
#
# Usage:
#   pwsh -File update.ps1                       (default: 90 days forward, 90 days back)
#   pwsh -File update.ps1 -DaysForward 120 -DaysBack 120

param(
    [int]$DaysForward = 90,
    [int]$DaysBack    = 180,  # results endpoint caps each call ~30d; we paginate in 25d windows
    [string]$ClubId   = "CC6VJ83",
    # Gap between hockey.be calls. 200ms is fine from a home connection. From a cloud IP
    # Cloudflare starts returning 403 challenges after the second request, so the runner
    # passes something much larger -- see the note on $CallDelayMs below.
    [int]$CallDelayMs = 200
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$htmlPath = Join-Path $here "index.html"

# Throttle: 200ms between hockey.be calls keeps us under 5 req/s so we never trip the
# server's rate limiter (it has none documented for the public connector, but bursts of
# ~120 calls in 60s could plausibly attract attention). Adds ~25s to a full run.
# hockey.be sits behind Cloudflare. From a residential IP all ~150 calls of a full run
# go through untouched. From a GitHub-hosted runner (Azure address space) the first one
# or two succeed and everything after that gets a 403 challenge page, so the pace below
# is what the workflow overrides. If even a slow pace gets challenged, the honest read is
# that Cloudflare does not want datacenter traffic on this endpoint and the job belongs
# on a machine with a normal connection -- do not try to look like a browser to get past
# it.
# Identify ourselves instead of sending the default PowerShell agent string, and retry
# twice before giving up so a single 5xx or timeout does not red the whole cron run.
# When we do give up, the message carries the URL and status code -- the old code threw
# a bare WebException that said nothing about which endpoint died.
$UserAgent   = "OlympiaCalendar/1.0 (+https://github.com/Meusini/OlympiaCalendar)"
$MaxAttempts = 3
function ApiCall([scriptblock]$call, [string]$url) {
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        Start-Sleep -Milliseconds $CallDelayMs
        try { return & $call }
        catch {
            $status = ""
            if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
            if ($attempt -eq $MaxAttempts) {
                throw "GET $url failed after $MaxAttempts attempts (HTTP $status): $($_.Exception.Message)"
            }
            Write-Host ("  retry {0}/{1} (HTTP {2}) {3}" -f $attempt, $MaxAttempts, $status, $url)
            # Back off hard: a 403 here means a rate threshold was tripped, and retrying
            # quickly just digs the hole deeper.
            Start-Sleep -Seconds (15 * $attempt)
        }
    }
}
function ApiGet([string]$url) {
    return ApiCall { Invoke-RestMethod -Uri $url -UseBasicParsing -UserAgent $UserAgent -TimeoutSec 60 } $url
}
function ApiGetWeb([string]$url) {
    return ApiCall { Invoke-WebRequest -Uri $url -UseBasicParsing -UserAgent $UserAgent -TimeoutSec 60 } $url
}

if (-not (Test-Path $htmlPath)) { throw "index.html not found in $here" }

$today = Get-Date
$from  = $today.ToString("yyyy-MM-dd")
$to    = $today.AddDays($DaysForward).ToString("yyyy-MM-dd")
$backFrom = $today.AddDays(-$DaysBack).ToString("yyyy-MM-dd")
$backTo   = $from

# ----- Helpers -----
function StripHtml([string]$s) {
    if ([string]::IsNullOrEmpty($s)) { return "" }
    ($s -replace '<br\s*/?>', "`n" -replace '<[^>]+>', '' -replace '&nbsp;', ' ').Trim()
}
function ParseField([string]$raw) {
    if ($raw -match '^COEX\s+(\d+)(?:\s+(.+))?$') {
        $code = $matches[1]
        $rest = if ($matches.Count -gt 2) { $matches[2] } else { "" }
        $parts = @()
        if ($rest) {
            foreach ($m in [regex]::Matches($rest, '[A-Za-z]|\d+')) { $parts += $m.Value }
        }
        return [pscustomobject]@{ fieldCode = $code; subpath = $parts }
    }
    return $null
}
function SplitTeam([string]$full) {
    # "Olympia D-2 Outdoor Week" -> club="Olympia", team="D-2", season="outdoor"
    $clean = ($full -replace '\s+', ' ').Trim()
    $parts = $clean -split ' ', 3
    [pscustomobject]@{
        club   = $parts[0]
        team   = $(if ($parts.Count -gt 1) { $parts[1] } else { "" })
        season = SeasonOf $clean
    }
}
function ParseIsoDate([string]$ddmmyyyy) {
    $d = $ddmmyyyy -split '/'
    if ($d.Count -ne 3) { return $null }
    "{0}-{1}-{2}" -f $d[2], $d[1], $d[0]
}
# Match a poolid <option> label to the division string on a game row. The two spell the
# same pool differently, and the 2026-27 season moved the separators again:
#   Pool option : "Open League Women Outdoor Week - Reg. 2 - OL - HV - A"
#   Game row div: "Open League Women - Reg. 2 - OL HV - A"
# Chasing those separator rules is what broke -- the old last-segment rule silently
# stopped matching the seven adult pools (D-2..D-5, G-1..G-3, H-3), so they lost their
# standings. Squash both sides to a key instead: drop the season marker, then drop every
# non-alphanumeric character. Both become "openleaguewomenreg2olhva", and across all 427
# published pools that key is still unique.
# SeasonOf stays separate so an Indoor and an Outdoor pool sharing a name can be told
# apart while both are listed (the Jan-Feb overlap).
$SeasonMarker = '\b(Outdoor|Indoor|Trimmers|Recreatief)\s+Week\b'
function PoolKey([string]$s) {
    if ([string]::IsNullOrWhiteSpace($s)) { return "" }
    $core = $s -replace $SeasonMarker, ''
    return ($core -replace '[^A-Za-z0-9]', '').ToLowerInvariant()
}
function SeasonOf([string]$s) {
    if ($s -match $SeasonMarker) { return $matches[1].ToLowerInvariant() }
    return ""
}

# ----- 1. Fetch the upcoming program (home + away) -----
# The connector returns an EMPTY array once a single query would exceed ~500 rows. It
# does not truncate and it does not error -- an over-wide window looks exactly like an
# empty week. One 90-day club-wide call blows past that as soon as a season is running
# (Olympia produces ~270 raw rows per fortnight), so page forward in 14-day windows and
# merge. Duplicates are dropped by the $seenTeam / $seenField keys below.
$progUrl  = "https://hockey.be/wp-json/sportlink-api/program?clubid=$ClubId&from=$from&to=$to"
$progWin  = 14
$progRows = New-Object System.Collections.Generic.List[object]
$pCursor  = $today
$fwdDone  = 0
while ($fwdDone -lt $DaysForward) {
    $chunkDays = [Math]::Min($progWin, $DaysForward - $fwdDone)
    $wFrom = $pCursor.ToString("yyyy-MM-dd")
    $wTo   = $pCursor.AddDays($chunkDays).ToString("yyyy-MM-dd")
    $u = "https://hockey.be/wp-json/sportlink-api/program?clubid=$ClubId&from=$wFrom&to=$wTo"
    Write-Host "Fetching program: $u"
    $p = ApiGet $u
    foreach ($row in $p.data) { $progRows.Add($row) }
    Write-Host ("  +{0} rows" -f $p.data.Count)
    if ($p.data.Count -ge 450) {
        Write-Host "  WARN: close to the connector row cap -- shorten the progWin setting."
    }
    $pCursor = $pCursor.AddDays($chunkDays)
    $fwdDone += $chunkDays
}
$progResp = [pscustomobject]@{ data = $progRows }
Write-Host ("Program total: {0} rows (raw, includes API duplicates)" -f $progResp.data.Count)

# ----- 2. Fetch past results (home + away). The results endpoint silently caps at
# roughly 30 days worth of rows, so we paginate in 25-day windows and merge.
$winSize = 25
$resRows = New-Object System.Collections.Generic.List[object]
$cursor  = $today
$totalBack = 0
while ($totalBack -lt $DaysBack) {
    $chunkDays = [Math]::Min($winSize, $DaysBack - $totalBack)
    $wFrom = $cursor.AddDays(-$chunkDays).ToString("yyyy-MM-dd")
    $wTo   = $cursor.ToString("yyyy-MM-dd")
    $u = "https://hockey.be/wp-json/sportlink-api/results?clubid=$ClubId&from=$wFrom&to=$wTo"
    Write-Host "Fetching results: $u"
    $r = ApiGet $u
    foreach ($row in $r.data) { $resRows.Add($row) }
    Write-Host ("  +{0} rows" -f $r.data.Count)
    $cursor = $cursor.AddDays(-$chunkDays)
    $totalBack += $chunkDays
}
$resResp = [pscustomobject]@{ data = $resRows }
Write-Host ("Results total: {0} rows (raw, includes API duplicates)" -f $resResp.data.Count)

# ----- 3. Process program rows -----
$fieldGames  = New-Object System.Collections.Generic.List[object]
$teamGames   = New-Object System.Collections.Generic.List[object]
$seenField   = @{}
$seenTeam    = @{}
$teamSeason  = @{}   # team code -> "outdoor" / "indoor", used to disambiguate pool lookup
$dupField = 0; $dupTeam = 0

foreach ($row in $progResp.data) {
    $c0 = StripHtml $row[0]
    $lines = $c0 -split "`n"
    $dateStr  = $lines[0].Trim()
    $fieldRaw = if ($lines.Count -gt 1) { ($lines[1..($lines.Count-1)] -join ' ').Trim() } else { "" }
    $time = if ($row[1]) { $row[1].Substring(0, [Math]::Min(5, $row[1].Length)) } else { "" }
    $div  = StripHtml $row[2]
    $h = SplitTeam (StripHtml $row[3])
    $a = SplitTeam (StripHtml $row[6])
    $iso = ParseIsoDate $dateStr
    if (-not $iso) { continue }

    # Is this a game with an Olympia team?
    $isHome = $h.club -eq 'Olympia'
    $isAway = $a.club -eq 'Olympia'
    if (-not ($isHome -or $isAway)) { continue }

    $ourTeam   = if ($isHome) { $h.team } else { $a.team }
    $oppClub   = if ($isHome) { $a.club } else { $h.club }
    $oppTeam   = if ($isHome) { $a.team } else { $h.team }
    $ourSeason = if ($isHome) { $h.season } else { $a.season }
    if ($ourSeason) { $teamSeason[$ourTeam] = $ourSeason }

    # Parse field for home games (used by both fieldGames + teamGames so the Teams view
    # can show a "Veld X" badge that links into Veldindeling).
    $fieldForTeam = $null
    if ($isHome) {
        $fieldForTeam = ParseField $fieldRaw
    }

    # teamGames: every Olympia game (home + away); home rows carry field info too
    $tKey = "$iso|$time|$div|$ourTeam|$oppClub|$oppTeam|$isHome"
    if (-not $seenTeam.ContainsKey($tKey)) {
        $seenTeam[$tKey] = $true
        $teamGames.Add([pscustomobject]@{
            date         = $iso
            time         = $time
            isHome       = $isHome
            division     = $div
            olympiaTeam  = $ourTeam
            opponentClub = $oppClub
            opponentTeam = $oppTeam
            fieldCode    = $(if ($fieldForTeam) { $fieldForTeam.fieldCode } else { $null })
            subpath      = $(if ($fieldForTeam) { @($fieldForTeam.subpath) } else { @() })
        })
    } else { $dupTeam++ }

    # fieldGames: only Olympia home games, with field/subpath
    if ($isHome) {
        $field = $fieldForTeam
        if ($null -ne $field) {
            $fKey = "$iso|$time|$($field.fieldCode)|$($field.subpath -join '')|$ourTeam|$oppClub|$oppTeam"
            if (-not $seenField.ContainsKey($fKey)) {
                $seenField[$fKey] = $true
                $fieldGames.Add([pscustomobject]@{
                    date      = $iso
                    time      = $time
                    fieldCode = $field.fieldCode
                    subpath   = @($field.subpath)
                    division  = $div
                    homeTeam  = $h.team
                    awayClub  = $a.club
                    awayTeam  = $a.team
                })
            } else { $dupField++ }
        }
    }
}
Write-Host ("  field games: {0} (dropped {1} dupes)" -f $fieldGames.Count, $dupField)
Write-Host ("  team games:  {0} (dropped {1} dupes)" -f $teamGames.Count, $dupTeam)

# ----- 4. Process results rows -----
$results = New-Object System.Collections.Generic.List[object]
$seenRes = @{}; $dupRes = 0
foreach ($row in $resResp.data) {
    $dateStr = StripHtml $row[0]
    $time = if ($row[1]) { $row[1].Substring(0, [Math]::Min(5, $row[1].Length)) } else { "" }
    $div  = StripHtml $row[2]
    $h = SplitTeam (StripHtml $row[3])
    $scoreRaw = StripHtml $row[5]   # e.g. "1 - 3"
    $a = SplitTeam (StripHtml $row[7])
    $iso = ParseIsoDate $dateStr
    if (-not $iso) { continue }
    $isHome = $h.club -eq 'Olympia'
    $isAway = $a.club -eq 'Olympia'
    if (-not ($isHome -or $isAway)) { continue }

    $ourTeam = if ($isHome) { $h.team } else { $a.team }
    $oppClub = if ($isHome) { $a.club } else { $h.club }
    $oppTeam = if ($isHome) { $a.team } else { $h.team }

    $hScore = $null; $aScore = $null
    if ($scoreRaw -match '^\s*(\d+)\s*-\s*(\d+)\s*$') {
        $hScore = [int]$matches[1]
        $aScore = [int]$matches[2]
    }
    $ourScore = if ($isHome) { $hScore } else { $aScore }
    $oppScore = if ($isHome) { $aScore } else { $hScore }

    $key = "$iso|$time|$div|$ourTeam|$oppClub|$oppTeam|$isHome"
    if ($seenRes.ContainsKey($key)) { $dupRes++; continue }
    $seenRes[$key] = $true

    $results.Add([pscustomobject]@{
        date         = $iso
        time         = $time
        isHome       = $isHome
        division     = $div
        olympiaTeam  = $ourTeam
        opponentClub = $oppClub
        opponentTeam = $oppTeam
        score        = $scoreRaw
        olympiaScore = $ourScore
        opponentScore= $oppScore
    })
}
Write-Host ("  results: {0} (dropped {1} dupes)" -f $results.Count, $dupRes)

# ----- 5. Build Olympia team list (unique team codes + their division) -----
# Teams often play in multiple competitions across a season (heenronde + terugronde,
# cup, playoffs, indoor vs outdoor). For standings we want the CURRENTLY ACTIVE pool —
# best signal is what they're playing this week / next week. Fall back to past games
# only if the season has ended for that team.
$teamDivUpcoming = @{}
$teamDivPast     = @{}
function AddDiv([hashtable]$dict, [string]$team, [string]$div) {
    if (-not $dict.ContainsKey($team)) { $dict[$team] = @{} }
    $bucket = $dict[$team]
    if (-not $bucket.ContainsKey($div)) { $bucket[$div] = 0 }
    $bucket[$div]++
}
foreach ($g in $teamGames) { AddDiv $teamDivUpcoming $g.olympiaTeam $g.division }
foreach ($g in $results)   { AddDiv $teamDivPast     $g.olympiaTeam $g.division }
$allTeamCodes = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($k in $teamDivUpcoming.Keys) { [void]$allTeamCodes.Add($k) }
foreach ($k in $teamDivPast.Keys)     { [void]$allTeamCodes.Add($k) }

# ----- 6. Map division string -> poolid by scraping kalender form -----
Write-Host "Fetching pool-id mapping from kalender page..."
$kalPage = ApiGetWeb "https://hockey.be/nl/competitie/kalender-resultaten-en-rangschikkingen/"
$selMatch = [regex]::Match($kalPage.Content, '<select name="poolid"[^>]*>(.*?)</select>')
$poolMap = @{}    # normalized label -> poolid
if ($selMatch.Success) {
    $items = [regex]::Matches($selMatch.Groups[1].Value, '<option value="([^"]+)"[^>]*>([^<]+)</option>')
    foreach ($it in $items) {
        $id = $it.Groups[1].Value
        $label = $it.Groups[2].Value
        $k   = PoolKey $label
        $mrk = SeasonOf $label
        if ($k) {
            # Store both the bare key and a season-qualified one; the lookup prefers the
            # qualified match and falls back to bare.
            if (-not $poolMap.ContainsKey($k))       { $poolMap[$k] = $id }
            if (-not $poolMap.ContainsKey("$k|$mrk")) { $poolMap["$k|$mrk"] = $id }
        }
    }
    Write-Host ("  {0} pools mapped" -f $poolMap.Count)
}

# ----- 7. Resolve each Olympia team to a poolid, fetch standing + pool-wide games -----
$teams = New-Object System.Collections.Generic.List[object]
$standingCache = @{}
$poolGames = @{}   # poolId -> array of game pscustomobjects (all teams in the pool, past + upcoming)

function FetchPoolGames([string]$poolId) {
    # Pull past 14 days of results + next 14 days of program for this pool.
    # Returns array of {date,time,division,isPast,homeClub,homeTeam,awayClub,awayTeam,score?,homeScore?,awayScore?}.
    $arr = New-Object System.Collections.Generic.List[object]
    $today = Get-Date
    $resFrom = $today.AddDays(-14).ToString("yyyy-MM-dd")
    $resTo   = $today.ToString("yyyy-MM-dd")
    $progFrom= $today.ToString("yyyy-MM-dd")
    $progTo  = $today.AddDays(14).ToString("yyyy-MM-dd")

    # --- past results ---
    try {
        $rr = ApiGet "https://hockey.be/wp-json/sportlink-api/results?poolid=$poolId&from=$resFrom&to=$resTo"
        foreach ($row in $rr.data) {
            $dateStr = StripHtml $row[0]   # results endpoint: pure date, no field
            $time = if ($row[1]) { $row[1].Substring(0,[Math]::Min(5,$row[1].Length)) } else { "" }
            $div  = StripHtml $row[2]
            $h    = SplitTeam (StripHtml $row[3])
            $scoreRaw = StripHtml $row[5]
            $a    = SplitTeam (StripHtml $row[7])
            $iso  = ParseIsoDate $dateStr
            if (-not $iso) { continue }
            $hS = $null; $aS = $null
            if ($scoreRaw -match '^\s*(\d+)\s*-\s*(\d+)\s*$') { $hS=[int]$matches[1]; $aS=[int]$matches[2] }
            $arr.Add([pscustomobject]@{
                date=$iso; time=$time; division=$div; isPast=$true
                homeClub=$h.club; homeTeam=$h.team
                awayClub=$a.club; awayTeam=$a.team
                score=$scoreRaw; homeScore=$hS; awayScore=$aS
            })
        }
    } catch { Write-Host "  WARN: pool results fetch failed for poolid=${poolId}: $_" }

    # --- upcoming program ---
    try {
        $pr = ApiGet "https://hockey.be/wp-json/sportlink-api/program?poolid=$poolId&from=$progFrom&to=$progTo"
        foreach ($row in $pr.data) {
            # row[0] is HTML with date + field; for pool views we just want the date
            $c0 = StripHtml $row[0]
            $dateStr = ($c0 -split "`n")[0].Trim()
            $time = if ($row[1]) { $row[1].Substring(0,[Math]::Min(5,$row[1].Length)) } else { "" }
            $div  = StripHtml $row[2]
            $h    = SplitTeam (StripHtml $row[3])
            $a    = SplitTeam (StripHtml $row[6])
            $iso  = ParseIsoDate $dateStr
            if (-not $iso) { continue }
            $arr.Add([pscustomobject]@{
                date=$iso; time=$time; division=$div; isPast=$false
                homeClub=$h.club; homeTeam=$h.team
                awayClub=$a.club; awayTeam=$a.team
                score=$null; homeScore=$null; awayScore=$null
            })
        }
    } catch { Write-Host "  WARN: pool program fetch failed for poolid=${poolId}: $_" }

    return ,$arr.ToArray()
}

foreach ($teamCode in ($allTeamCodes | Sort-Object)) {
    if ([string]::IsNullOrEmpty($teamCode)) { continue }
    # Prefer the most common UPCOMING-game division (currently active pool).
    # Only fall back to past-game frequency if the team has no scheduled games.
    $primaryDiv = $null
    if ($teamDivUpcoming.ContainsKey($teamCode) -and $teamDivUpcoming[$teamCode].Count -gt 0) {
        $divs = $teamDivUpcoming[$teamCode].GetEnumerator() | Sort-Object Value -Descending
        $primaryDiv = $divs[0].Key
    } elseif ($teamDivPast.ContainsKey($teamCode) -and $teamDivPast[$teamCode].Count -gt 0) {
        $divs = $teamDivPast[$teamCode].GetEnumerator() | Sort-Object Value -Descending
        $primaryDiv = $divs[0].Key
    }
    if ([string]::IsNullOrEmpty($primaryDiv)) { continue }
    # Prefer the season-qualified key so an indoor team never picks up an outdoor pool.
    $divKey = PoolKey $primaryDiv
    $poolId = $null
    if ($teamSeason.ContainsKey($teamCode)) { $poolId = $poolMap["$divKey|$($teamSeason[$teamCode])"] }
    if (-not $poolId) { $poolId = $poolMap[$divKey] }
    if (-not $poolId) { Write-Host ("  WARN: no poolid for {0} -- division '{1}'" -f $teamCode, $primaryDiv) }

    $standing = $null
    if ($poolId) {
        if ($standingCache.ContainsKey($poolId)) {
            $standing = $standingCache[$poolId]
        } else {
            try {
                $stResp = ApiGet "https://hockey.be/wp-json/sportlink-api/standing?poolid=$poolId"
                if ($stResp.data -and $stResp.data.Count -gt 0) {
                    $cleanRows = @()
                    foreach ($row in $stResp.data) {
                        $cleanRow = @()
                        foreach ($cell in $row) { $cleanRow += (StripHtml $cell) }
                        $cleanRows += ,$cleanRow
                    }
                    $standing = [pscustomobject]@{
                        columns = @($stResp.columns | ForEach-Object { $_.title })
                        rows    = $cleanRows
                    }
                    $standingCache[$poolId] = $standing
                }
            } catch {
                Write-Host "  WARN: standing fetch failed for poolid=$poolId ($teamCode): $_"
            }
            # Fetch pool-wide games (past + upcoming) once per pool
            if (-not $poolGames.ContainsKey($poolId)) {
                $poolGames[$poolId] = FetchPoolGames $poolId
            }
        }
    }

    $teams.Add([pscustomobject]@{
        code     = $teamCode
        division = $primaryDiv
        poolId   = $poolId
        standing = $standing
    })
}
Write-Host ("  {0} Olympia teams; {1} unique pools with standings; {2} pools with games" -f `
    $teams.Count, $standingCache.Count, $poolGames.Count)

# ----- 8. Sort team games & results, build payload -----
# Sort then materialize as plain arrays (Sort-Object returns a scalar when given 1 item).
$fieldGamesArr = @($fieldGames | Sort-Object date, time)
$teamGamesArr  = @($teamGames  | Sort-Object date, time)
$resultsArr    = @($results    | Sort-Object @{Expression='date';Descending=$true}, @{Expression='time';Descending=$true})
# Use List.ToArray() — @($list) trips on mixed-shape pscustomobjects.
$teamsArr      = $teams.ToArray()

# Between seasons every endpoint legitimately returns [], and so does a connector that
# has gone dark. Writing that out replaces a working page with a blank one — which is
# exactly what left the site showing nothing from June 2026 onward while the cron kept
# reporting green. Keep whatever is already embedded and exit clean instead.
if ($fieldGamesArr.Count -eq 0 -and $teamGamesArr.Count -eq 0 -and $resultsArr.Count -eq 0) {
    Write-Host "No games returned for this window (off-season, or the connector is down)."
    Write-Host "Leaving the existing embedded data in index.html untouched."
    exit 0
}

# Use ordered hashtable (NOT [pscustomobject]@{}) — that cast trips on List<object> values
# with mixed-type entries ("Argument types do not match").
$payload = [ordered]@{
    updated    = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    source     = $progUrl
    fieldGames = $fieldGamesArr
    teamGames  = $teamGamesArr
    results    = $resultsArr
    teams      = $teamsArr
    poolGames  = $poolGames    # poolId -> [{date,time,division,isPast,homeClub,homeTeam,awayClub,awayTeam,score,homeScore,awayScore}]
}

$json = $payload | ConvertTo-Json -Depth 6 -Compress

# ----- 9. Write into index.html -----
$html = Get-Content -Path $htmlPath -Raw -Encoding UTF8
$pattern     = '(?s)(<script id="games-data" type="application/json">)(.*?)(</script>)'
$replacement = '$1' + "`n" + $json + "`n" + '$3'
$updated = [regex]::Replace($html, $pattern, $replacement)
if ($updated -eq $html) {
    throw "Embedded data block not found in index.html"
}
$tmp = "$htmlPath.tmp"
Set-Content -Path $tmp -Value $updated -Encoding UTF8 -NoNewline
Move-Item -Path $tmp -Destination $htmlPath -Force

$jsonKb = [Math]::Round($json.Length / 1024, 1)
Write-Host ("OK -- wrote {0} field games, {1} team games, {2} results, {3} teams ({4} KB JSON) to {5}" -f `
    $fieldGames.Count, $teamGames.Count, $results.Count, $teams.Count, $jsonKb, $htmlPath)
