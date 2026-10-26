# Trading Desk launcher (Windows PowerShell). First run creates a virtual env and installs deps.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Write-Host "Creating virtual environment..."
    if (Get-Command py -ErrorAction SilentlyContinue) { py -3 -m venv .venv } else { python -m venv .venv }
    & .venv\Scripts\python.exe -m pip install --upgrade pip
    & .venv\Scripts\python.exe -m pip install -r requirements.txt
}

Write-Host "Starting Trading Desk on http://127.0.0.1:8765  (Ctrl+C to stop)"
& .venv\Scripts\python.exe app.py
