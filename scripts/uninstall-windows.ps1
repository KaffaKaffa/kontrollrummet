# Stops and removes what install-windows.ps1 set up. State in ~/.control-room stays.
#   npm run uninstall:windows
. "$PSScriptRoot\windows-common.ps1"
$appDir = Join-Path $env:LOCALAPPDATA 'Kontrollrummet'
$exe = Join-Path $appDir 'Kontrollrummet.exe'
if (Test-Path $exe) { & $exe --stop; Start-Sleep -Seconds 2 }
foreach ($folder in 'Startup', 'Programs', 'Desktop') {
  Remove-Item (Join-Path ([Environment]::GetFolderPath($folder)) 'Kontrollrummet.lnk') -ErrorAction SilentlyContinue
}
Remove-Item (Join-Path $Data 'services.json') -ErrorAction SilentlyContinue
Remove-Item $appDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'Borttaget. Data och loggar finns kvar i ~/.control-room.'
