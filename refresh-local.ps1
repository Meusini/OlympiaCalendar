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

    if (-not (git status --porcelain -- index.html)) {
        Write-Host "No data changes this run."
    }
    else {
        git add index.html
        git commit --quiet -m "chore: refresh schedule data (auto)"
        if ($LASTEXITCODE -ne 0) { throw "git commit failed (exit $LASTEXITCODE)" }
        git push --quiet origin main
        if ($LASTEXITCODE -ne 0) { throw "git push failed (exit $LASTEXITCODE)" }
        Write-Host "Pushed refreshed index.html."
    }
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
