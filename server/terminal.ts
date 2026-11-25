import * as cp from 'node:child_process';
import { dirname } from 'node:path';
import { IS_WINDOWS } from './proc.ts';
import { PS_READ, ensureSecretsDir, secretFile } from './secrets.ts';

/**
 * A window for what needs the owner at a keyboard: logging in, saving a token,
 * resuming a session. A job says what to run, and it runs in Terminal (zsh) on
 * macOS and in Windows Terminal or PowerShell on Windows.
 */
export interface TerminalJob {
  /** The first line printed: what this window is for, and as which account. */
  banner?: string;
  /** Variables set for every step; null clears one the shell may have. */
  env?: Record<string, string | null>;
  cwd?: string;
  /** Opened in the browser first, e.g. the page where a token is made. */
  url?: string;
  /** A secret typed at a hidden prompt and saved under this service name (keychain / DPAPI). */
  secret?: { service: string; prompt: string };
  /** Variables whose value is a saved secret (variable → service). Read where the command runs, never put on the command line. */
  secretEnv?: Record<string, string>;
  /** Commands as argument lists, run in order; a failing one stops the rest. */
  steps?: string[][];
}

export const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const psQuote = (s: string) => `'${s.replaceAll("'", "''")}'`;
const appleQuote = (s: string) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/** The job as one zsh command line. */
export function zshScript(job: TerminalJob): string {
  const parts: string[] = [];
  if (job.banner) parts.push(`printf '%s\\n\\n' ${shellQuote(job.banner)}`);
  if (job.cwd) parts.push(`cd ${shellQuote(job.cwd)}`);
  if (job.url) parts.push(`open ${shellQuote(job.url)}`);
  if (job.secret) parts.push(`echo ${shellQuote(job.secret.prompt)}`, `security add-generic-password -U -a control-room -s ${shellQuote(job.secret.service)} -w`);
  const env = Object.entries(job.env ?? {});
  const prefix = env.length
    ? `env ${env.map(([k]) => `-u ${k}`).join(' ')} ${env
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${shellQuote(v!)}`)
        .join(' ')} `
    : '';
  // A plain assignment before env: the value is in the command's environment, not its argument list (ps).
  const secrets = Object.entries(job.secretEnv ?? {})
    .map(([k, svc]) => `${k}="$(security find-generic-password -s ${shellQuote(svc)} -w)" `)
    .join('');
  for (const step of job.steps ?? []) parts.push(`${secrets}${secrets && !prefix ? 'env ' : ''}${prefix}${step.map(shellQuote).join(' ')}`);
  return parts.join(' && ');
}

/** The job as a PowerShell script (Windows PowerShell 5.1 and PowerShell 7 alike). */
export function powershellScript(job: TerminalJob): string {
  const lines: string[] = [];
  if (job.banner) lines.push(`Write-Host ${psQuote(job.banner)}`, 'Write-Host ""');
  if (job.cwd) lines.push(`Set-Location -LiteralPath ${psQuote(job.cwd)}`);
  for (const [k, v] of Object.entries(job.env ?? {})) lines.push(v ? `$env:${k} = ${psQuote(v)}` : `Remove-Item Env:${k} -ErrorAction SilentlyContinue`);
  for (const [k, svc] of Object.entries(job.secretEnv ?? {})) lines.push(`$env:${k} = (${PS_READ(secretFile(svc))})`);
  if (job.url) lines.push(`Start-Process ${psQuote(job.url)}`);
  if (job.secret) {
    const file = secretFile(job.secret.service);
    lines.push(
      `Write-Host ${psQuote(job.secret.prompt)}`,
      '$secret = Read-Host -AsSecureString',
      `New-Item -ItemType Directory -Force -Path ${psQuote(dirname(file))} | Out-Null`,
      `$secret | ConvertFrom-SecureString | Set-Content -LiteralPath ${psQuote(file)}`,
      'Write-Host "Sparat."',
    );
  }
  // Native commands do not stop on their own: check each exit code.
  for (const step of job.steps ?? []) lines.push(`& ${step.map(psQuote).join(' ')}`, 'if ($LASTEXITCODE -ne 0) { Write-Host "Avslutades med kod $LASTEXITCODE."; return }');
  return lines.join('\n');
}

let hasWt: boolean | null = null;
function windowsTerminal(): boolean {
  if (hasWt === null) {
    try {
      cp.execFileSync('where.exe', ['wt.exe'], { stdio: 'ignore' });
      hasWt = true;
    } catch {
      hasWt = false;
    }
  }
  return hasWt;
}

/** Opens a new window with the job, in front. */
export function openTerminal(job: TerminalJob) {
  if (IS_WINDOWS) {
    if (job.secret) ensureSecretsDir();
    // Encoded, so no quoting of the script survives cmd or wt.
    const encoded = Buffer.from(powershellScript(job), 'utf16le').toString('base64');
    const ps = ['powershell.exe', '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
    const child = windowsTerminal()
      ? cp.spawn('wt.exe', ['-w', 'new', ...ps], { detached: true, stdio: 'ignore' })
      : cp.spawn('cmd.exe', ['/d', '/c', 'start', '""', ...ps], { detached: true, stdio: 'ignore', windowsVerbatimArguments: false });
    child.unref();
    return;
  }
  cp.execFile('osascript', [
    '-e', `tell application "Terminal" to do script ${appleQuote(zshScript(job))}`,
    '-e', 'tell application "Terminal" to activate',
  ]);
}

/** Opens a file, folder or URL with the system's default app. */
export function openWithSystem(target: string) {
  if (IS_WINDOWS) cp.spawn('cmd.exe', ['/d', '/c', 'start', '""', target], { detached: true, stdio: 'ignore' }).unref();
  else cp.execFile('open', [target]);
}
