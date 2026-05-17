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
    [int]$DaysBack    = 60,  # results endpoint silently returns 0 rows beyond ~60 days
    [string]$ClubId   = "CC6VJ83"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$htmlPath = Join-Path $here "index.html"

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
    # "Olympia D-2 Outdoor Week" -> club="Olympia", team="D-2"
    $clean = ($full -replace '\s+', ' ').Trim()
    $parts = $clean -split ' ', 3
    [pscustomobject]@{
        club = $parts[0]
        team = $(if ($parts.Count -gt 1) { $parts[1] } else { "" })
    }
}
function ParseIsoDate([string]$ddmmyyyy) {
    $d = $ddmmyyyy -split '/'
    if ($d.Count -ne 3) { return $null }
    "{0}-{1}-{2}" -f $d[2], $d[1], $d[0]
}
# Normalize a poolid <option> label so it matches the division string in game rows.
# Pool: "Open League Women Outdoor Week - HV 2 - OL - A"
# Div : "Open League Women - HV 2 - OL A"
function NormalizePoolLabel([string]$label) {
    $s = $label
    $s = $s -replace ' Outdoor Week', ''
    $s = $s -replace ' Indoor Week',  ''
    $s = $s -replace ' Trimmers Week', ''
    $s = $s -replace ' Recreatief Week', ''
    $s = $s -replace ' - ([A-Za-z0-9]+)\s*$', ' $1'
    return $s.Trim()
}

# ----- 1. Fetch the upcoming program (home + away) -----
$progUrl = "https://hockey.be/wp-json/sportlink-api/program?clubid=$ClubId&from=$from&to=$to"
Write-Host "Fetching program: $progUrl"
$progResp = Invoke-RestMethod -Uri $progUrl -UseBasicParsing
Write-Host ("  {0} rows (raw, includes API duplicates)" -f $progResp.data.Count)

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
    $r = Invoke-RestMethod -Uri $u -UseBasicParsing
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
# Use the first encountered division per team (teams may show up in multiple competitions
# rarely — e.g. cup + league — but for standings we pick the most common one).
$teamDivCounts = @{}
function AddTeamDiv($team, $div) {
    if (-not $teamDivCounts.ContainsKey($team)) { $teamDivCounts[$team] = @{} }
    $bucket = $teamDivCounts[$team]
    if (-not $bucket.ContainsKey($div)) { $bucket[$div] = 0 }
    $bucket[$div]++
}
foreach ($g in $teamGames) { AddTeamDiv $g.olympiaTeam $g.division }
foreach ($g in $results)   { AddTeamDiv $g.olympiaTeam $g.division }

# ----- 6. Map division string -> poolid by scraping kalender form -----
Write-Host "Fetching pool-id mapping from kalender page..."
$kalPage = Invoke-WebRequest -UseBasicParsing "https://hockey.be/nl/competitie/kalender-resultaten-en-rangschikkingen/"
$selMatch = [regex]::Match($kalPage.Content, '<select name="poolid"[^>]*>(.*?)</select>')
$poolMap = @{}    # normalized label -> poolid
if ($selMatch.Success) {
    $items = [regex]::Matches($selMatch.Groups[1].Value, '<option value="([^"]+)"[^>]*>([^<]+)</option>')
    foreach ($it in $items) {
        $id = $it.Groups[1].Value
        $label = $it.Groups[2].Value
        $norm = NormalizePoolLabel $label
        if (-not $poolMap.ContainsKey($norm)) { $poolMap[$norm] = $id }
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
        $rr = Invoke-RestMethod -Uri "https://hockey.be/wp-json/sportlink-api/results?poolid=$poolId&from=$resFrom&to=$resTo" -UseBasicParsing
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
        $pr = Invoke-RestMethod -Uri "https://hockey.be/wp-json/sportlink-api/program?poolid=$poolId&from=$progFrom&to=$progTo" -UseBasicParsing
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

foreach ($teamCode in ($teamDivCounts.Keys | Sort-Object)) {
    if ([string]::IsNullOrEmpty($teamCode)) { continue }
    # Pick the division this team plays in most often
    $divs = $teamDivCounts[$teamCode].GetEnumerator() | Sort-Object Value -Descending
    $primaryDiv = $divs[0].Key
    $poolId = $poolMap[$primaryDiv]

    $standing = $null
    if ($poolId) {
        if ($standingCache.ContainsKey($poolId)) {
            $standing = $standingCache[$poolId]
        } else {
            try {
                $stResp = Invoke-RestMethod -Uri "https://hockey.be/wp-json/sportlink-api/standing?poolid=$poolId" -UseBasicParsing
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
