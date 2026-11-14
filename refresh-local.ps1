# refresh-local.ps1 — daily data refresh, run from a normal internet connection.
#
# Why this exists instead of a GitHub Actions cron:
# hockey.be sits behind Cloudflare. From a GitHub-hosted runner (Azure address space)
# the first request of a process is served and every request after it comes back 403
# with Cloudflare's "Just a moment..." JavaScript challenge — a slower pace and long
# backoffs make no difference, because it is not a rate limit. From a home connection
# the same ~150 calls pass untouched. So the refresh runs here and pushes the result;
# GitHub Pages picks it up from the commit.
#
# Registered as the "OlympiaCalendar Refresh" scheduled task.
# Log: refresh-local.log (rotated at 1 MB, previous kept as .1)

$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$log  = Join-Path $repo 'refresh-local.log'

# Rotate before opening the transcript, otherwise this grows forever.
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) {
    Move-Item -Path $log -Destination "$log.1" -Force
}

# Nothing can answer an interactive credential prompt inside a scheduled task, and a
# hung git would still be holding the repo when tomorrow's run starts.
$env:GIT_TERMINAL_PROMPT = '0'

Start-Transcript -Path $log -Append | Out-Null
$exit = 0
try {
    Write-Host ("=== refresh {0} ===" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    Set-Location $repo

    # Note: no 2>&1 on any git call. Redirecting a native command's stderr in Windows
    # PowerShell wraps each line in an ErrorRecord and trips $ErrorActionPreference even
    # when the exit code is 0. Exit codes are the reliable signal here.
    git pull --ff-only --quiet
    if ($LASTEXITCODE -ne 0) { throw "git pull failed (exit $LASTEXITCODE)" }

    & (Join-Path $repo 'update.ps1')

    if (-not (git status --porcelain -- index.html pool_map.json)) {
        Write-Host "No data changes this run."
    }
    else {
        git add index.html pool_map.json
        git commit --quiet -m "chore: refresh schedule data (auto)"
        if ($LASTEXITCODE -ne 0) { throw "git commit failed (exit $LASTEXITCODE)" }
        git push --quiet origin main
        if ($LASTEXITCODE -ne 0) { throw "git push failed (exit $LASTEXITCODE)" }
        Write-Host "Pushed refreshed index.html."
    }

    # OlympiaData (Meusini/OlympiaData): statistiek.html is derived from index.html, data encrypted.
    # stats_key.json changes when build_page.js re-wraps the key (new census password).
    $data = Join-Path (Split-Path -Parent $repo) 'OlympiaData'
    if (-not (Test-Path (Join-Path $data '.git'))) { throw "OlympiaData clone missing at $data" }
    Push-Location $data
    try {
        git pull --ff-only --quiet
        if ($LASTEXITCODE -ne 0) { throw "OlympiaData git pull failed (exit $LASTEXITCODE)" }
        node (Join-Path $repo 'build_data_site.js') $data
        if ($LASTEXITCODE -eq 2) { Write-Host "OlympiaData: statistiek not set up yet (run node stats_key.js in HockeyCensus)." }
        elseif ($LASTEXITCODE -ne 0) { throw "build_data_site.js failed (exit $LASTEXITCODE)" }
        # Census Team Strength / Club Strength tabs (2026-11-14): rebuilt from the standings archive and
        # encrypted with the Statistiek data key into strength.json, so no census password is needed.
        # A failure here does not block Statistiek; it fails the run after the push.
        $census = Join-Path (Split-Path -Parent $repo) 'HockeyCensus'
        $strengthErr = $null
        Push-Location $census
        try {
            node rounds.js | Out-Null
            if ($LASTEXITCODE -ne 0) { $strengthErr = "rounds.js failed (exit $LASTEXITCODE)" }
            else {
                $env:STRENGTH_OUT = Join-Path $data 'strength.json'
                node strength_box.js
                if ($LASTEXITCODE -ne 0) { $strengthErr = "strength_box.js failed (exit $LASTEXITCODE)" }
                Remove-Item Env:STRENGTH_OUT
            }
        }
        finally { Pop-Location }
        if (-not (git status --porcelain -- statistiek.html stats_key.json strength.json)) {
            Write-Host "OlympiaData: no changes."
        }
        else {
            git add statistiek.html stats_key.json strength.json
            git commit --quiet -m "chore: refresh statistiek and strength (auto)"
            if ($LASTEXITCODE -ne 0) { throw "OlympiaData commit failed (exit $LASTEXITCODE)" }
            git push --quiet origin main
            if ($LASTEXITCODE -ne 0) { throw "OlympiaData push failed (exit $LASTEXITCODE)" }
            Write-Host "Pushed refreshed statistiek/strength to OlympiaData."
        }
        if ($strengthErr) { throw $strengthErr }
    }
    finally { Pop-Location }
    Write-Host "=== ok ==="
}
catch {
    Write-Host ("=== FAILED: {0} ===" -f $_.Exception.Message)
    $exit = 1
}
finally {
    Stop-Transcript | Out-Null
}
exit $exit
