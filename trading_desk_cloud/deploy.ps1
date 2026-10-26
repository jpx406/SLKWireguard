# Trading Desk -> Cloudflare (desk.nesrapp.com). Run in PowerShell from this folder:  .\deploy.ps1
# Safe to re-run: each step is skipped when it is already done.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
$toml = Join-Path $PSScriptRoot "wrangler.toml"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Get-TomlValue($name) {
    $m = Select-String -Path $toml -Pattern "^$name = `"([^`"]*)`"" | Select-Object -First 1
    if ($m) { return $m.Matches[0].Groups[1].Value } else { return "" }
}
function Set-TomlValue($name, $value) {
    $text = Get-Content $toml -Raw
    $text = [regex]::Replace($text, "(?m)^$name = `"[^`"]*`"", "$name = `"$value`"")
    [IO.File]::WriteAllText($toml, $text)
}

Step "Checking Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js 20+ is required. Install it with:  winget install OpenJS.NodeJS.LTS  (then reopen PowerShell)" }
$major = [int]((node --version).TrimStart("v").Split(".")[0])
if ($major -lt 20) { throw "Node.js 20+ is required (found $(node --version))." }

Step "Installing dependencies"
npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

Step "Cloudflare login"
npx wrangler whoami *> $null
if ($LASTEXITCODE -ne 0) { npx wrangler login; if ($LASTEXITCODE -ne 0) { throw "wrangler login failed" } }

Step "D1 database"
if ((Get-TomlValue "database_id") -eq "REPLACE_WITH_D1_DATABASE_ID") {
    $list = npx wrangler d1 list --json | ConvertFrom-Json
    $db = $list | Where-Object { $_.name -eq "trading-desk" } | Select-Object -First 1
    if (-not $db) {
        npx wrangler d1 create trading-desk | Out-Host
        $db = (npx wrangler d1 list --json | ConvertFrom-Json) | Where-Object { $_.name -eq "trading-desk" } | Select-Object -First 1
    }
    if (-not $db) { throw "Could not create or find the D1 database 'trading-desk'." }
    Set-TomlValue "database_id" $db.uuid
    Write-Host "Using D1 database $($db.uuid)"
} else { Write-Host "Already set." }

function Get-ApiKey {
    if (-not $env:ANTHROPIC_API_KEY) {
        $sec = Read-Host "Anthropic API key (sk-ant-..., input hidden)" -AsSecureString
        $env:ANTHROPIC_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    }
    return $env:ANTHROPIC_API_KEY
}

Step "Claude agent (uploads your trader-* skills)"
if (-not (Get-TomlValue "AGENT_ID") -or -not (Get-TomlValue "ENVIRONMENT_ID")) {
    Get-ApiKey | Out-Null
    node setup/setup-agent.mjs
    if ($LASTEXITCODE -ne 0) { throw "Agent setup failed" }
} else { Write-Host "Already set (re-run 'node setup/setup-agent.mjs' after changing a skill)." }

Step "Cloudflare Access (login protection)"
if (-not (Get-TomlValue "ACCESS_TEAM_DOMAIN")) {
    $team = Read-Host "Your Zero Trust team domain (e.g. nesr.cloudflareaccess.com)"
    Set-TomlValue "ACCESS_TEAM_DOMAIN" ($team.Trim() -replace "^https?://", "" -replace "/$", "")
}
if (-not (Get-TomlValue "ACCESS_AUD")) {
    $aud = Read-Host "Application Audience (AUD) Tag of the desk.nesrapp.com Access application"
    Set-TomlValue "ACCESS_AUD" $aud.Trim()
}

Step "Deploying the Worker"
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { throw "Deploy failed" }

Step "Anthropic API key (stored as an encrypted Worker secret)"
$secrets = npx wrangler secret list 2>$null | Out-String
if ($secrets -notmatch "ANTHROPIC_API_KEY") {
    Get-ApiKey | npx wrangler secret put ANTHROPIC_API_KEY
    if ($LASTEXITCODE -ne 0) { throw "Setting the secret failed" }
} else { Write-Host "Already set. To change it: npx wrangler secret put ANTHROPIC_API_KEY" }

Write-Host "`nDone. Open https://desk.nesrapp.com (log in with the email you allowed in Access)." -ForegroundColor Green
Write-Host "First time: click Settings (gear) and paste your trader\config.json, then upload GUIDE.md in the Guide tab."
