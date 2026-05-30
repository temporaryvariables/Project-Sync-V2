# Project Sync end to end test runner.
# Starts Postgres backed backends locally with AUTH_BYPASS=true, runs the smoke
# test, then stops the services it started. Requires Node and a running Postgres.
#
# Usage (from the repo root):
#   pwsh ./scripts/run-e2e.ps1
#   pwsh ./scripts/run-e2e.ps1 -DatabaseUrl "postgresql://user:pass@localhost:5432/projectsync"

param(
  [string]$DatabaseUrl = "postgresql://postgres:password@localhost:5432/projectsync"
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$procs = @()

function Start-Service($dir, $port, $extraEnv) {
  $env:AUTH_BYPASS = "true"
  $env:PORT = "$port"
  foreach ($kv in $extraEnv.GetEnumerator()) { Set-Item "env:$($kv.Key)" $kv.Value }
  $p = Start-Process -FilePath "node" -ArgumentList "$root\$dir\server.js" -PassThru -WindowStyle Hidden
  Write-Host "started $dir (pid $($p.Id)) on port $port"
  return $p
}

# Starts a standalone script (not a service folder), used for the reference relay.
function Start-Script($scriptPath, $port, $extraEnv) {
  $env:AUTH_BYPASS = "true"
  $env:PORT = "$port"
  foreach ($kv in $extraEnv.GetEnumerator()) { Set-Item "env:$($kv.Key)" $kv.Value }
  $p = Start-Process -FilePath "node" -ArgumentList "$root\$scriptPath" -PassThru -WindowStyle Hidden
  Write-Host "started $scriptPath (pid $($p.Id)) on port $port"
  return $p
}

try {
  Write-Host "=== Starting services ===" -ForegroundColor Cyan
  $procs += Start-Service "ground-station-api"  3001 @{ DATABASE_URL = $DatabaseUrl }
  $procs += Start-Service "flight-director-api" 3002 @{ DATABASE_URL = $DatabaseUrl }
  $procs += Start-Service "deep-space-network"  3003 @{ GROUND_STATION_URL = "http://localhost:3001" }
  # The student starter is an empty scaffold, so the harness uses a complete
  # reference relay to exercise the full replication pipeline.
  $procs += Start-Script "scripts\reference-relay.mjs" 4000 @{ GROUND_STATION_URL = "http://localhost:3001" }

  Write-Host "waiting for services to come up..." -ForegroundColor Yellow
  Start-Sleep -Seconds 3

  Write-Host "=== Running end to end test ===" -ForegroundColor Cyan
  node "$root\scripts\e2e-test.mjs"
  $code = $LASTEXITCODE
}
finally {
  Write-Host "`n=== Stopping services ===" -ForegroundColor Cyan
  foreach ($p in $procs) {
    if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }
}

if ($code -eq 0) { Write-Host "`nE2E PASSED" -ForegroundColor Green }
else { Write-Host "`nE2E FAILED (exit $code)" -ForegroundColor Red }
exit $code
