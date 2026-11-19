# Started by Kontrollrummet.exe --supervise (services.json), which starts it
# again when it stops and keeps the PC awake. Builds the web app when it is
# stale, then runs the server; its exit code is the server's.
. "$PSScriptRoot\windows-common.ps1"
Set-Location $Root
$log = Join-Path $Logs 'server.log'
Import-ControlRoomEnv
$key = Read-ControlRoomSecret 'control-room-openai'
if ($key) { $env:OPENAI_API_KEY = $key }

# Build the web app when it is missing or anything in web/ is newer, so a restart shows the source.
$index = Join-Path $Root 'web\dist\index.html'
$stale = -not (Test-Path $index)
if (-not $stale) {
  $built = (Get-Item $index).LastWriteTime
  $stale = [bool](Get-ChildItem (Join-Path $Root 'web') -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\web\\dist\\|\\node_modules\\' -and $_.LastWriteTime -gt $built } |
    Select-Object -First 1)
}
if ($stale) { Invoke-Logged $log 'npm run build' | Out-Null }
exit (Invoke-Logged $log 'node --disable-warning=ExperimentalWarning server/main.ts')
