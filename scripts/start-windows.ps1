param(
  [string]$BindAddress = '127.0.0.1',
  [int]$Port = 3478
)

$ErrorActionPreference = 'Stop'
$Repository = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $Repository
try {
  if (-not (Test-Path -LiteralPath 'dist/server/index.js')) {
    throw 'Run npm install and npm run build before starting wmux.'
  }
  & node dist/server/index.js --host $BindAddress --port $Port
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
