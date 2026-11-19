# One-time setup on Windows, as install-mac.sh on a Mac: Kontrollrummet.exe
# (with the icon), the background part started at login from the Startup
# folder, and Kontrollrummet in the Start menu and on the desktop. Run again
# after pulling changes; it is safe to repeat.
#   npm run install:windows
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\windows-common.ps1"
Set-Location $Root

function Need([string]$Command, [string]$Winget) {
  if (Get-Command $Command -ErrorAction SilentlyContinue) { return }
  throw "$Command saknas. Installera med: winget install --id $Winget --exact"
}
Need node 'OpenJS.NodeJS.LTS'
Need git 'Git.Git'
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  throw 'claude saknas. Installera Claude Code: irm https://claude.ai/install.ps1 | iex'
}

# Native modules (Rollup, esbuild) need the Visual C++ runtime, which a fresh Windows (on ARM above all) lacks.
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
if (-not (Test-Path "$env:SystemRoot\System32\vcruntime140.dll")) {
  Write-Host "› Visual C++ Redistributable ($arch)"
  & winget install --id "Microsoft.VCRedist.2015+.$arch" --exact --silent --accept-source-agreements --accept-package-agreements --disable-interactivity | Out-Null
}

# PowerShell does not stop when a program fails: each step's exit code is checked.
function Step([string]$What, [scriptblock]$Run) {
  & $Run
  if ($LASTEXITCODE -ne 0) { throw "$What misslyckades (kod $LASTEXITCODE)." }
}
Write-Host '› npm install och bygge av webben'
Step 'npm install' { npm install --no-audit --no-fund | Out-Null }
Step 'Bygget av webben' { npm run build | Out-Null }

# The OpenAI key once, from the shell that has it, encrypted for this user (DPAPI).
if (-not (Read-ControlRoomSecret 'control-room-openai')) {
  if ($env:OPENAI_API_KEY) {
    Save-ControlRoomSecret 'control-room-openai' $env:OPENAI_API_KEY
    Write-Host '› OpenAI-nyckeln sparad (control-room-openai)'
  } else {
    Write-Host '› Ingen OPENAI_API_KEY i miljön: bildgenerering är av tills nyckeln är sparad.'
  }
}

# The background part stops before its program is replaced.
$appDir = Join-Path $env:LOCALAPPDATA 'Kontrollrummet'
$exe = Join-Path $appDir 'Kontrollrummet.exe'
if (Test-Path $exe) { & $exe --stop; Start-Sleep -Seconds 2 }

Write-Host '› Kontrollrummet.exe'
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
$ico = Join-Path $Root 'windows\Kontrollrummet.ico'
Copy-Item $ico (Join-Path $appDir 'Kontrollrummet.ico') -Force
$provider = New-Object Microsoft.CSharp.CSharpCodeProvider
$params = New-Object System.CodeDom.Compiler.CompilerParameters
$params.GenerateExecutable = $true
$params.OutputAssembly = $exe
$params.CompilerOptions = "/target:winexe /optimize /win32icon:`"$ico`""
[void]$params.ReferencedAssemblies.AddRange([string[]]@('System.dll', 'System.Core.dll', 'System.Web.Extensions.dll'))
$result = $provider.CompileAssemblyFromFile($params, (Join-Path $Root 'windows\Kontrollrummet.cs'))
if ($result.Errors.HasErrors) {
  $result.Errors | Where-Object { -not $_.IsWarning } | ForEach-Object { Write-Host "  $($_.Line): $($_.ErrorText)" }
  throw 'Kontrollrummet.exe gick inte att bygga.'
}

# What it runs: the server, the teamleader's and architect's desks, and Gudfadern's
# desk per Claude account (a Remote Control session belongs to one login).
$services = Join-Path $Data 'services.json'
$ps = (Get-Command powershell.exe).Source
& node --disable-warning=ExperimentalWarning --input-type=module -e @'
  const a = await import('./server/accounts.ts');
  const [root, logs, out, ps] = process.argv.slice(1);
  const script = (name) => [ps, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', root + '\\scripts\\' + name];
  const desk = (name, ...args) => ({ name, log: logs + '\\' + name + '.log', command: [...script('run-desk.ps1'), ...args] });
  const services = [
    { name: 'server', log: logs + '\\server.log', command: script('run-server.ps1') },
    desk('desk-teamleader', 'teamleader'),
    desk('desk-architect', 'architect'),
    ...a.listAccounts().map((x) => desk('desk-gudfadern-' + x.id, 'gudfadern', x.id)),
  ];
  (await import('node:fs')).writeFileSync(out, JSON.stringify(services, null, 2) + '\n');
'@ $Root $Logs $services $ps
Write-Host "› Tjänster: $services"

# Shortcuts: the Startup folder runs the background part at login (one
# "Kontrollrummet" in Startup apps); the Start menu and the desktop open the window.
$shell = New-Object -ComObject WScript.Shell
function Shortcut([string]$Path, [string]$Arguments, [string]$Description) {
  $s = $shell.CreateShortcut($Path)
  $s.TargetPath = $exe
  $s.Arguments = $Arguments
  $s.WorkingDirectory = $Root
  $s.IconLocation = "$exe,0"
  $s.Description = $Description
  $s.Save()
}
Shortcut (Join-Path ([Environment]::GetFolderPath('Startup')) 'Kontrollrummet.lnk') '--supervise' 'Kontrollrummet i bakgrunden: servern och skrivborden'
Shortcut (Join-Path ([Environment]::GetFolderPath('Programs')) 'Kontrollrummet.lnk') '' 'Kontrollrummet'
Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Kontrollrummet.lnk') '' 'Kontrollrummet'
Write-Host '› Genvägar: Autostart, Start-menyn och skrivbordet'

Start-Process $exe -ArgumentList '--supervise' -WindowStyle Hidden
Write-Host '› Igång'
Write-Host ''
Write-Host "Loggar: $Logs"
Write-Host "Skrivborden i Claude-appen kräver att mappen är betrodd: kör claude en gång i $Root\desks\teamleader och godkänn."
Write-Host "Öppna Kontrollrummet från Start-menyn. Notiser: klicka på klockan uppe till höger och tillåt dem."
