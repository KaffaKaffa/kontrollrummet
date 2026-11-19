import * as cp from 'node:child_process';
import { promisify } from 'node:util';
import crossSpawn from 'cross-spawn';

/**
 * node:child_process, for macOS and Windows alike. On Windows most CLIs the
 * control room runs are .cmd shims (claude, firebase, eas, az, gcloud), which
 * Node will not start without a shell, and a shell needs every argument quoted
 * for cmd.exe. cross-spawn resolves the command on PATH and quotes; elsewhere
 * this is node:child_process untouched. Import from here, not node:child_process.
 */

export const IS_WINDOWS = process.platform === 'win32';

type Parsed = { command: string; args: string[]; options: Record<string, unknown> };

/** The command as Windows can start it: resolved, and through cmd.exe for a .cmd. */
function parse(file: string, args: readonly string[] = [], options: object = {}): Parsed {
  if (!IS_WINDOWS) return { command: file, args: [...args], options: { ...options } };
  const p = (crossSpawn as unknown as { _parse: (c: string, a: string[], o: object) => Parsed })._parse(file, [...args], { ...options });
  return { command: p.command, args: p.args, options: p.options };
}

export type { ChildProcess, ChildProcessWithoutNullStreams, ExecFileOptions, SpawnOptions } from 'node:child_process';

function spawnAny(command: string, args: readonly string[] = [], options: cp.SpawnOptions = {}): cp.ChildProcessWithoutNullStreams {
  if (!IS_WINDOWS) return cp.spawn(command, args, options) as cp.ChildProcessWithoutNullStreams;
  return crossSpawn(command, [...args], options) as unknown as cp.ChildProcessWithoutNullStreams;
}

function execFileSyncAny(file: string, args: readonly string[] = [], options: cp.ExecFileSyncOptions = {}): string | Buffer {
  const p = parse(file, args, options);
  return cp.execFileSync(p.command, p.args, p.options as cp.ExecFileSyncOptions);
}

/** execFile with a callback, and promisify(execFile) giving { stdout, stderr } as Node's does. */
function execFileAny(file: string, ...rest: unknown[]): cp.ChildProcess {
  const args = Array.isArray(rest[0]) ? (rest.shift() as string[]) : [];
  const options = rest[0] && typeof rest[0] === 'object' ? (rest.shift() as object) : {};
  const callback = typeof rest[0] === 'function' ? (rest[0] as (...a: unknown[]) => void) : undefined;
  const p = parse(file, args, options);
  return cp.execFile(p.command, p.args, p.options, callback as never);
}

(execFileAny as unknown as Record<symbol, unknown>)[promisify.custom] = (file: string, args: readonly string[] = [], options: object = {}) => {
  const p = parse(file, args, options);
  return promisify(cp.execFile)(p.command, p.args, p.options as cp.ExecFileOptions);
};

// Node's own types, so promisify(execFile) and the overloads read as before.
export const spawn = spawnAny as unknown as typeof cp.spawn;
export const execFile = execFileAny as unknown as typeof cp.execFile;
export const execFileSync = execFileSyncAny as unknown as typeof cp.execFileSync;
