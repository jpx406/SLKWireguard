# Creates (or repairs) the Cloudflare Access login for the Trading Desk hostname via the Cloudflare API,
# then writes ACCESS_TEAM_DOMAIN / ACCESS_AUD into wrangler.toml and redeploys.
#
# Needs a Cloudflare API token (dash.cloudflare.com -> My Profile -> API Tokens -> Create Token -> Custom token)
# with these ACCOUNT permissions:
#   - Access: Apps and Policies -> Edit
#   - Access: Organizations, Identity Providers, and Groups -> Edit
#
# Run from the trading_desk_cloud folder:
#   powershell -ExecutionPolicy Bypass -File .\setup\setup-access.ps1
param(
    [string]$Hostname = "",
    [string]$Email = "juanp97g@gmail.com"
)
$ErrorActionPreference = "Continue"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent $PSScriptRoot
$toml = Join-Path $root "wrangler.toml"
$wr = Join-Path $root "node_modules\.bin\wrangler.cmd"

function Fail($msg) { Write-Host "`nERROR: $msg" -ForegroundColor Red; exit 1 }
function Set-TomlValue($name, $value) {
    $text = Get-Content $toml -Raw
    $text = [regex]::Replace($text, "(?m)^$name = `"[^`"]*`"", "$name = `"$value`"")
    [IO.File]::WriteAllText($toml, $text)
}

if (-not $Hostname) {
    $m = Select-String -Path $toml -Pattern 'pattern = "([^"]+)"' | Select-Object -First 1
    if ($m) { $Hostname = $m.Matches[0].Groups[1].Value } else { Fail "Could not read the hostname from wrangler.toml; pass -Hostname" }
}
Write-Host "Hostname to protect: $Hostname   Allowed email: $Email" -ForegroundColor Cyan

# Account id: from wrangler (already logged in by deploy.ps1), else ask.
$who = (& $wr whoami 2>&1) | Out-String
$ids = [regex]::Matches($who, "\b[0-9a-f]{32}\b") | ForEach-Object { $_.Value } | Select-Object -Unique
if (@($ids).Count -eq 1) { $account = $ids[0]; Write-Host "Cloudflare account: $account" }
else {
    Write-Host $who
    $account = (Read-Host "Account ID that owns nesrapp.com (32 characters; dashboard -> nesrapp.com -> Overview, right side)").Trim()
}

$sec = Read-Host "Cloudflare API token (input hidden)" -AsSecureString
$token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
$H = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }
$base = "https://api.cloudflare.com/client/v4/accounts/$account/access"

function CF($method, $path, $body = $null) {
    try {
        $req = @{ Method = $method; Uri = "$base$path"; Headers = $H }
        if ($body) { $req.Body = ($body | ConvertTo-Json -Depth 10) }
        return (Invoke-RestMethod @req).result
    } catch {
        $detail = $_.ErrorDetails.Message
        Fail "Cloudflare API $method $path failed: $detail`nCheck the token's permissions (see the top of this script) and the account id."
    }
}

# 1. Zero Trust organization (team domain)
$org = $null
try { $org = (Invoke-RestMethod -Method GET -Uri "$base/organizations" -Headers $H).result } catch { }
if (-not $org -or -not $org.auth_domain) {
    Fail "Zero Trust is not set up on this account yet. Open https://one.dash.cloudflare.com once, pick a team name and the Free plan, then re-run this script."
}
$team = $org.auth_domain
Write-Host "Team domain: $team"

# 2. One-time PIN login method
$idps = CF GET "/identity_providers"
if (-not ($idps | Where-Object { $_.type -eq "onetimepin" })) {
    CF POST "/identity_providers" @{ name = "One-time PIN"; type = "onetimepin"; config = @{} } | Out-Null
    Write-Host "Enabled One-time PIN login."
}

# 3. Reusable Allow policy for your email
$policies = CF GET "/policies"
$policy = $policies | Where-Object { $_.name -eq "Trading Desk owner" } | Select-Object -First 1
$policyBody = @{ name = "Trading Desk owner"; decision = "allow"; include = @(@{ email = @{ email = $Email } }) }
if ($policy) { $policy = CF PUT "/policies/$($policy.id)" $policyBody } else { $policy = CF POST "/policies" $policyBody }
Write-Host "Policy: allow $Email"

# 4. Self-hosted application on the hostname
$apps = CF GET "/apps"
$app = $apps | Where-Object { $_.domain -eq $Hostname -or ($_.self_hosted_domains -contains $Hostname) } | Select-Object -First 1
$appBody = @{
    name = "Trading Desk"; type = "self_hosted"; domain = $Hostname; session_duration = "24h"
    app_launcher_visible = $true
    policies = @(@{ id = $policy.id; precedence = 1 })
}
if ($app) { $app = CF PUT "/apps/$($app.id)" $appBody; Write-Host "Updated existing Access application." }
else { $app = CF POST "/apps" $appBody; Write-Host "Created Access application." }
$aud = $app.aud
if (-not $aud) { Fail "Cloudflare did not return the application's AUD tag." }
Write-Host "AUD tag: $aud"

# 5. Write config and redeploy
Set-TomlValue "ACCESS_TEAM_DOMAIN" $team
Set-TomlValue "ACCESS_AUD" $aud
Write-Host "wrangler.toml updated. Deploying..." -ForegroundColor Cyan
Push-Location $root
& $wr deploy
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Fail "Deploy failed (see above)." }

Write-Host "`nDone. In ~1 minute this should show 302 and a cloudflareaccess.com location:" -ForegroundColor Green
Write-Host "  curl.exe -sI https://$Hostname/ | Select-String `"HTTP|location`""
Write-Host "Then open https://$Hostname in a private window: log in with $Email and the emailed code."
