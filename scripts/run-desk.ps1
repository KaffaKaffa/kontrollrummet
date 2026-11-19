# Started by Kontrollrummet.exe --supervise (services.json), which starts it again when it stops: a
# Remote Control server in desks\<role>, so the session shows up in the Claude
# app. With an account (from ~/.control-room/accounts.json), the desk runs on
# that Claude profile; Gudfadern has one desk per account.
param([Parameter(Mandatory)][string]$Role, [string]$Account = '')
. "$PSScriptRoot\windows-common.ps1"
Import-ControlRoomEnv
$log = Join-Path $Logs ("desk-$Role" + $(if ($Account) { "-$Account" } else { '' }) + '.log')
$accountName = ''
if ($Account) {
  # The account's profile, as the server would set it: the standard one runs without CLAUDE_CONFIG_DIR.
  Push-Location $Root
  $json = node --disable-warning=ExperimentalWarning --input-type=module -e "const a = await import('./server/accounts.ts'); const e = a.accountEnv(process.argv[1], {}); console.log(JSON.stringify({ CLAUDE_CONFIG_DIR: e.CLAUDE_CONFIG_DIR ?? null, GH_CONFIG_DIR: e.GH_CONFIG_DIR ?? null, name: a.getAccount(process.argv[1]).name }))" $Account
  Pop-Location
  $profile = $json | ConvertFrom-Json
  foreach ($k in 'CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR') {
    if ($profile.$k) { Set-Item "Env:$k" $profile.$k } else { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
  }
  $accountName = $profile.name
}
# The server writes the token on its first start.
$tokenFile = Join-Path $Data 'desk-token'
for ($i = 0; $i -lt 60 -and -not (Test-Path $tokenFile); $i++) { Start-Sleep -Seconds 2 }
$env:CONTROL_ROOM_DESK_TOKEN = (Get-Content -Raw -LiteralPath $tokenFile).Trim()
# plan_feature waits for the architect; the tool call must outlive that.
$env:MCP_TOOL_TIMEOUT = '1800000'
$name = switch ($Role) {
  'teamleader' { 'Kontrollrummet · Teamleader' }
  'architect' { 'Kontrollrummet · Arkitekt' }
  'gudfadern' { 'Kontrollrummet · Gudfadern' + $(if ($accountName) { " ($accountName)" } else { '' }) }
  default { "Kontrollrummet · $Role" }
}
Set-Location (Join-Path $Root "desks\$Role")
exit (Invoke-Logged $log "claude remote-control --name `"$name`" --permission-mode auto")
