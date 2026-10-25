# archive-local.ps1 -- weekly standings archive, run from a normal internet connection.
#
# Same reason as refresh-local.ps1: hockey.be's Cloudflare challenge blocks GitHub-hosted
# runners, so this runs here and pushes the result for Pages to serve.
#
# Registered as the "OlympiaCalendar Standings" scheduled task, Mon-Thu at 12:15. Each day
# standings/archive.js checks about a quarter of the pools (see the note at its top), then
# build_page.js re-embeds them into klassementen.html.
# Log: archive-local.log (rotated at 1 MB, previous kept as .1)

$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$log  = Join-Path $repo 'archive-local.log'

if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) {
    Move-Item -Path $log -Destination "$log.1" -Force
}

$env:GIT_TERMINAL_PROMPT = '0'

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }

Start-Transcript -Path $log -Append | Out-Null
$exit = 0
try {
    Write-Host ("=== archive {0} ===" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    if (-not $node) { throw "node.exe not found" }
    Set-Location $repo

    # No 2>&1 on native calls -- see refresh-local.ps1.
    git pull --ff-only --quiet
    if ($LASTEXITCODE -ne 0) { throw "git pull failed (exit $LASTEXITCODE)" }

    & $node (Join-Path $repo 'standings\archive.js')
    if ($LASTEXITCODE -ne 0) { throw "archive.js failed (exit $LASTEXITCODE)" }
    & $node (Join-Path $repo 'standings\build_page.js')
    if ($LASTEXITCODE -ne 0) { throw "build_page.js failed (exit $LASTEXITCODE)" }

    if (-not (git status --porcelain -- standings klassementen.html)) {
        Write-Host "No standings changes this run."
    }
    else {
        git add standings klassementen.html
        git commit --quiet -m "chore: archive standings (auto)"
        if ($LASTEXITCODE -ne 0) { throw "git commit failed (exit $LASTEXITCODE)" }
        git push --quiet origin main
        if ($LASTEXITCODE -ne 0) { throw "git push failed (exit $LASTEXITCODE)" }
        Write-Host "Pushed archived standings."
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
