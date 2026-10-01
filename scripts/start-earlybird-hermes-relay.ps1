$workspace = Split-Path -Parent $PSScriptRoot
$port = if ($env:EARLYBIRD_HERMES_RELAY_PORT) { [int]$env:EARLYBIRD_HERMES_RELAY_PORT } else { 8767 }
$tokenFile = if ($env:EARLYBIRD_HERMES_RELAY_TOKEN_FILE) { $env:EARLYBIRD_HERMES_RELAY_TOKEN_FILE } else { Join-Path $workspace 'data\earlybird\hermes-relay.token' }
$targetFile = Join-Path $workspace 'data\earlybird\hermes-target.txt'
$hermesCommand = if ($env:HERMES_COMMAND) { $env:HERMES_COMMAND } elseif (Test-Path -LiteralPath 'C:\Users\Administrator\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe') { 'C:\Users\Administrator\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe' } else { (Get-Command hermes -ErrorAction SilentlyContinue)?.Source }

$target = if ($env:EARLYBIRD_HERMES_TARGET) { $env:EARLYBIRD_HERMES_TARGET } elseif (Test-Path -LiteralPath $targetFile) { (Get-Content -LiteralPath $targetFile -Raw).Trim() } else { $null }

if (!(Test-Path -LiteralPath $tokenFile) -or [string]::IsNullOrWhiteSpace($target) -or [string]::IsNullOrWhiteSpace($hermesCommand) -or !(Test-Path -LiteralPath $hermesCommand)) {
  throw 'EarlyBird Hermes relay is missing its token, target, or Hermes executable.'
}
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { return }

$env:EARLYBIRD_HERMES_RELAY_PORT = $port
$env:EARLYBIRD_HERMES_RELAY_TOKEN_FILE = $tokenFile
$env:EARLYBIRD_HERMES_TARGET = $target
$env:HERMES_COMMAND = $hermesCommand
& (Get-Command node -ErrorAction Stop).Source (Join-Path $workspace 'scripts\earlybird-hermes-relay.mjs')

