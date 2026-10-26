# Trading Desk -> Cloudflare (trading-desk.nesrapp.com). Run in PowerShell from this folder:
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1
# Safe to re-run: each step is skipped when it is already done.

# Windows PowerShell 5.1 turns any stderr line from npm/wrangler (even a harmless notice) into an
# error, so don't stop on those; every step checks $LASTEXITCODE and throws on real failures.
$ErrorActionPreference = "Continue"
Set-Location -Path $PSScriptRoot
$toml = Join-Path $PSScriptRoot "wrangler.toml"
$wr = Join-Path $PSScriptRoot "node_modules\.bin\wrangler.cmd"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "`nERROR: $msg" -ForegroundColor Red; exit 1 }
function Get-TomlValue($name) {
    $m = Select-String -Path $toml -Pattern "^$name = `"([^`"]*)`"" | Select-Object -First 1
    if ($m) { return $m.Matches[0].Groups[1].Value } else { return "" }
}
function Set-TomlValue($name, $value) {
    $text = Get-Content $toml -Raw
    $text = [regex]::Replace($text, "(?m)^$name = `"[^`"]*`"", "$name = `"$value`"")
    [IO.File]::WriteAllText($toml, $text)
}
function Get-D1 {
    # wrangler may print a banner around the JSON; keep only the JSON array.
    $out = (& $wr d1 list --json 2>$null) | Out-String
    $start = $out.IndexOf("["); $end = $out.LastIndexOf("]")
    if ($start -lt 0 -or $end -lt $start) { return $null }
    return ($out.Substring($start, $end - $start + 1) | ConvertFrom-Json) | Where-Object { $_.name -eq "trading-desk" } | Select-Object -First 1
}
function Get-ApiKey {
    if (-not $env:ANTHROPIC_API_KEY) {
        $sec = Read-Host "Anthropic API key (sk-ant-..., input hidden)" -AsSecureString
        $env:ANTHROPIC_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    }
    return $env:ANTHROPIC_API_KEY
}

Step "Checking Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js 20+ is required. Install it with:  winget install OpenJS.NodeJS.LTS  (then reopen PowerShell)" }
$major = [int]((node --version).TrimStart("v").Split(".")[0])
if ($major -lt 20) { Fail "Node.js 20+ is required (found $(node --version))." }

Step "Installing dependencies"
npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { Fail "npm install failed" }
# Newer npm blocks package install scripts unless approved; wrangler needs these two.
npm install-scripts approve esbuild workerd 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { npm rebuild esbuild workerd 2>$null | Out-Null }
& $wr --version
if ($LASTEXITCODE -ne 0) { Fail "wrangler does not run. Try: npm install-scripts approve esbuild workerd ; npm rebuild" }

Step "Cloudflare login"
$who = (& $wr whoami 2>&1) | Out-String
if ($LASTEXITCODE -ne 0 -or $who -match "not authenticated|not logged in") {
    & $wr login
    if ($LASTEXITCODE -ne 0) { Fail "wrangler login failed" }
} else { Write-Host "Already logged in." }

Step "D1 database"
if ((Get-TomlValue "database_id") -eq "REPLACE_WITH_D1_DATABASE_ID") {
    $db = Get-D1
    if (-not $db) {
        # Piped input keeps wrangler non-interactive (it won't try to edit wrangler.toml itself).
        "n" | & $wr d1 create trading-desk | Out-Host
        $db = Get-D1
    }
    if (-not $db) { Fail "Could not create or find the D1 database 'trading-desk'." }
    Set-TomlValue "database_id" $db.uuid
    Write-Host "Using D1 database $($db.uuid)"
} else { Write-Host "Already set." }

Step "Claude agent (uploads your trader-* skills)"
if (-not (Get-TomlValue "AGENT_ID") -or -not (Get-TomlValue "ENVIRONMENT_ID")) {
    Get-ApiKey | Out-Null
    node setup/setup-agent.mjs
    if ($LASTEXITCODE -ne 0) { Fail "Agent setup failed" }
} else { Write-Host "Already set (re-run 'node setup/setup-agent.mjs' after changing a skill)." }

Step "Cloudflare Access (login protection)"
if (-not (Get-TomlValue "ACCESS_TEAM_DOMAIN")) {
    $team = Read-Host "Your Zero Trust team domain (e.g. nesr.cloudflareaccess.com)"
    Set-TomlValue "ACCESS_TEAM_DOMAIN" ($team.Trim() -replace "^https?://", "" -replace "/$", "")
}
if (-not (Get-TomlValue "ACCESS_AUD")) {
    $aud = Read-Host "Application Audience (AUD) Tag of the trading-desk.nesrapp.com Access application"
    Set-TomlValue "ACCESS_AUD" $aud.Trim()
}

Step "Deploying the Worker"
& $wr deploy
if ($LASTEXITCODE -ne 0) { Fail "Deploy failed (see the message above)." }

Step "Anthropic API key (stored as an encrypted Worker secret)"
$secrets = (& $wr secret list 2>$null) | Out-String
if ($secrets -notmatch "ANTHROPIC_API_KEY") {
    Get-ApiKey | & $wr secret put ANTHROPIC_API_KEY
    if ($LASTEXITCODE -ne 0) { Fail "Setting the secret failed" }
} else { Write-Host "Already set. To change it: .\node_modules\.bin\wrangler.cmd secret put ANTHROPIC_API_KEY" }

Write-Host "`nDone. Open https://trading-desk.nesrapp.com (log in with the email you allowed in Access)." -ForegroundColor Green
Write-Host "First time: click Settings (gear) and paste your trader\config.json, then upload GUIDE.md in the Guide tab."
