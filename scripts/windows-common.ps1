# Shared by the Windows scripts: this PC's settings, secrets, and logging.
# Dot-sourced:  . "$PSScriptRoot\windows-common.ps1"

$Root = Split-Path -Parent $PSScriptRoot
$Data = if ($env:CONTROL_ROOM_DATA) { $env:CONTROL_ROOM_DATA } else { Join-Path $HOME '.control-room' }
$Logs = Join-Path $Data 'logs'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

# This PC's own settings, as ~/.control-room/env on a Mac: KEY=value lines
# ("export" and quotes allowed, ~ is the home folder). Everything started inherits them.
function Import-ControlRoomEnv {
  $file = Join-Path $Data 'env'
  if (-not (Test-Path $file)) { return }
  foreach ($line in Get-Content -LiteralPath $file) {
    if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      $value = $Matches[2].Trim().Trim('"').Trim("'")
      if ($value.StartsWith('~')) { $value = $HOME + $value.Substring(1) }
      [Environment]::SetEnvironmentVariable($Matches[1], $value, 'Process')
    }
  }
}

# A secret saved by the control room (DPAPI, only this user on this PC can read it), or $null.
function Read-ControlRoomSecret([string]$Service) {
  $file = Join-Path $Data ("secrets\" + ($Service -replace '[^\w.-]', '_') + '.dpapi')
  if (-not (Test-Path $file)) { return $null }
  $secure = Get-Content -LiteralPath $file | ConvertTo-SecureString
  [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

function Save-ControlRoomSecret([string]$Service, [string]$Value) {
  $dir = Join-Path $Data 'secrets'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $file = Join-Path $dir (($Service -replace '[^\w.-]', '_') + '.dpapi')
  ConvertTo-SecureString $Value -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath $file
}

# A command with its output appended to a log as plain UTF-8 (cmd's redirection,
# since PowerShell 5.1 writes UTF-16 and wraps stderr in error records).
function Invoke-Logged([string]$Log, [string]$CommandLine) {
  & cmd.exe /d /c "$CommandLine >> `"$Log`" 2>&1"
  return $LASTEXITCODE
}

function Write-Log([string]$Log, [string]$Text) {
  Add-Content -LiteralPath $Log -Value "$(Get-Date -Format s) $Text" -Encoding UTF8
}
