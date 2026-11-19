import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { IS_WINDOWS, execFile, execFileSync } from './proc.ts';

/**
 * Secrets (API tokens, keys) by service name, never in a file in the repo.
 * macOS: the login keychain (security). Windows: a file per service in
 * ~/.control-room/secrets, encrypted with DPAPI for the signed-in user
 * (ConvertFrom-SecureString), so only that user on that machine reads it.
 */

const SECRETS_DIR = join(DATA_DIR, 'secrets');
const safe = (service: string) => service.replace(/[^\w.-]/g, '_');
export const secretFile = (service: string) => join(SECRETS_DIR, `${safe(service)}.dpapi`);

const PS_READ = (file: string) =>
  `$s = Get-Content -LiteralPath '${file.replaceAll("'", "''")}' | ConvertTo-SecureString; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`;

/** The secret, or null when there is none. */
export function readSecret(service: string | undefined | null): string | null {
  if (!service) return null;
  try {
    if (IS_WINDOWS) {
      const file = secretFile(service);
      if (!existsSync(file)) return null;
      return String(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_READ(file)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null;
    }
    return String(execFileSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null;
  } catch {
    return null;
  }
}

/** readSecret without blocking the server, for what runs often. */
export function readSecretAsync(service: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (IS_WINDOWS) {
      const file = secretFile(service);
      if (!existsSync(file)) return resolve(null);
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_READ(file)], (err, out) => resolve(err ? null : String(out).trim() || null));
      return;
    }
    execFile('security', ['find-generic-password', '-s', service, '-w'], (err, out) => resolve(err ? null : String(out).trim() || null));
  });
}

/** Where a secret typed in Terminal is saved: the folder must exist first on Windows. */
export function ensureSecretsDir() {
  if (IS_WINDOWS) mkdirSync(SECRETS_DIR, { recursive: true });
}
