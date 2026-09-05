$workspace = Split-Path -Parent $PSScriptRoot
$port = 8767
$tokenFile = Join-Path $workspace 'data\earlybird\hermes-relay.token'
$targetFile = Join-Path $workspace 'data\earlybird\hermes-target.txt'
$hermesCommand = 'C:\Users\Administrator\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe'

if (!(Test-Path -LiteralPath $tokenFile) -or !(Test-Path -LiteralPath $targetFile) -or !(Test-Path -LiteralPath $hermesCommand)) {
  throw 'EarlyBird Hermes relay is missing its token, target, or Hermes executable.'
}
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { return }

$env:EARLYBIRD_HERMES_RELAY_TOKEN_FILE = $tokenFile
$env:EARLYBIRD_HERMES_TARGET = (Get-Content -LiteralPath $targetFile -Raw).Trim()
$env:HERMES_COMMAND = $hermesCommand
& (Get-Command node -ErrorAction Stop).Source (Join-Path $workspace 'scripts\earlybird-hermes-relay.mjs')
