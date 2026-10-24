# Installs six skill packages (16 skills) into Claude Code globally (~/.claude/skills) on Windows.
# Run from PowerShell:  powershell -ExecutionPolicy Bypass -File .\install-skills.ps1
# Requires Node.js 18+ (npx) and Claude Code already installed.

$ErrorActionPreference = "Stop"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# $ErrorActionPreference does not stop on a failing native command (npx, npm) in
# Windows PowerShell 5.1, so check the exit code after each one.
function Run {
  & $args[0] $args[1..($args.Count - 1)]
  if ($LASTEXITCODE -ne 0) { throw "Command failed (exit $LASTEXITCODE): $($args -join ' ')" }
}

# 1. UI Skills (ibelick/ui-skills) - router skill + CLI it depends on
Step "UI Skills (ibelick/ui-skills)"
Run npx -y skills add ibelick/ui-skills --skill ui-skills-root --agent claude-code -g -y
# The router calls `npx ui-skills ...` at runtime; warm the cache so first use is fast:
Run npx -y ui-skills categories | Out-Null

# 2. Impeccable (pbakaus/impeccable)
Step "Impeccable (pbakaus/impeccable)"
Run npx -y skills add pbakaus/impeccable --skill impeccable --agent claude-code -g -y

# 3. UI/UX Pro Max (nextlevelbuilder/ui-ux-pro-max-skill)
Step "UI/UX Pro Max (nextlevelbuilder/ui-ux-pro-max-skill)"
Run npx -y skills add nextlevelbuilder/ui-ux-pro-max-skill --skill ui-ux-pro-max --agent claude-code -g -y
# This skill shells out to python3 for its search script; check it is on PATH:
if (-not (Get-Command python3 -ErrorAction SilentlyContinue) -and -not (Get-Command python -ErrorAction SilentlyContinue)) {
  Write-Warning "Python not found on PATH - ui-ux-pro-max's search.py needs it. Install Python 3 from python.org or the Microsoft Store."
}

# 4. Playwright CLI (microsoft/playwright-cli) - the CLI itself plus its skill
Step "Playwright CLI (microsoft/playwright-cli)"
Run npm install -g "@playwright/cli@latest"
Run playwright-cli install --skills        # drops the playwright-cli skill into Claude Code's skills dir

# 5. Apple Design (dickwu/apple-design-skill) - Apple HIG design reviewer, cross-platform
Step "Apple Design (dickwu/apple-design-skill)"
Run npx -y skills add dickwu/apple-design-skill --agent claude-code -g -y

# 6. Replica (Jakeschincariol/replica-skill) - eleven chained skills; not on the skills CLI, so clone + copy
Step "Replica (Jakeschincariol/replica-skill)"
$tmp = Join-Path $env:TEMP "replica-skill"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Run git clone --depth 1 https://github.com/Jakeschincariol/replica-skill.git $tmp
New-Item -ItemType Directory -Force "$HOME\.claude\skills" | Out-Null
Get-ChildItem $tmp -Directory -Filter "replica-*" | ForEach-Object {
  $dest = "$HOME\.claude\skills\$($_.Name)"
  # Copy-Item into an existing folder nests it (replica-x\replica-x), so replace it on re-runs.
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Copy-Item $_.FullName $dest -Recurse -Force
}
Remove-Item $tmp -Recurse -Force
# Its helper tools are stdlib-only Python 3.8+; the same python check above applies.

# Summary
Step "Installed skills in ~/.claude/skills:"
Get-ChildItem "$HOME\.claude\skills" -Directory | Select-Object -ExpandProperty Name
Write-Host "`nRestart Claude Code (or open a new session) so it picks the new skills up." -ForegroundColor Green
