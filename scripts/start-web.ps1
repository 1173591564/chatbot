$ErrorActionPreference = 'SilentlyContinue'
$up = Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object -First 1
if (-not $up) {
  $root = Split-Path $PSScriptRoot -Parent
  Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $root
  Start-Sleep -Milliseconds 800
}
Start-Process 'http://localhost:3000'
