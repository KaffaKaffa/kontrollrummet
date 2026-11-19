import { execFile, spawn, type ChildProcessWithoutNullStreams } from './proc.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { APP_ROOT, CLAUDE_BIN } from './config.ts';
import { identityEnv, type Identity } from './accounts.ts';

const run = promisify(execFile);

/**
 * Logging in to an MCP server (OAuth) from a button. `claude mcp login`
 * prints the authorization URL and waits for the browser to come back to a
 * localhost port it listens on; it only refuses to run without a terminal,
 * so it gets a pseudo-terminal (scripts/pty-run.py). The page opens the URL;
 * if the browser cannot reach back, the address it ended on can be pasted.
 *
 * `claude mcp login` only knows configured servers. One the control room
 * hands its agents through --mcp-config is added to the project's local
 * scope for the login and removed again after; the tokens are kept by the
 * server's name and address, which is what the agents use.
 */

interface Session {
  id: string;
  server: string;
  status: 'waiting' | 'done' | 'failed';
  message: string;
  url: string | null;
  child: ChildProcessWithoutNullStreams;
  output: string;
  /** Added to the local scope for the login, to be removed after. */
  added: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timer: NodeJS.Timeout;
}

const sessions = new Map<string, Session>();

const clean = (s: string) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r/g, '');

async function configured(name: string, cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const out = await run(CLAUDE_BIN, ['mcp', 'get', name], { cwd, env }).then(
    (r) => r.stdout + r.stderr,
    (e: { stdout?: string; stderr?: string }) => `${e.stdout ?? ''}${e.stderr ?? ''}`,
  );
  return !/No MCP server named/.test(out);
}

async function removeAdded(s: Session) {
  if (!s.added) return;
  s.added = false;
  await run(CLAUDE_BIN, ['mcp', 'remove', '--scope', 'local', s.server], { cwd: s.cwd, env: s.env }).catch(() => undefined);
}

export async function startMcpLogin(who: Identity, cwd: string, server: string, config: Record<string, unknown>): Promise<{ session: string; url: string }> {
  if (config.type !== 'http' && config.type !== 'sse') throw new Error(`${server} loggas inte in med OAuth`);
  const env = identityEnv(who);
  // One login per server at a time; a new click starts over.
  for (const s of sessions.values()) if (s.server === server && s.status === 'waiting') cancelMcpLogin(s.id);
  let added = false;
  if (!(await configured(server, cwd, env))) {
    await run(CLAUDE_BIN, ['mcp', 'add-json', '--scope', 'local', server, JSON.stringify(config)], { cwd, env });
    added = true;
  }
  const child = spawn('python3', ['-I', join(APP_ROOT, 'scripts/pty-run.py'), CLAUDE_BIN, 'mcp', 'login', '--no-browser', server], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const s: Session = {
    id: randomUUID(),
    server,
    status: 'waiting',
    message: 'Väntar på inloggningen i webbläsaren.',
    url: null,
    child,
    output: '',
    added,
    cwd,
    env,
    // Nobody finished in ten minutes: given up, and the local entry cleaned away.
    timer: setTimeout(() => cancelMcpLogin(s.id), 10 * 60_000),
  };
  sessions.set(s.id, s);
  console.log(`[mcp-login] ${server} som ${typeof who === 'string' ? who : who.account} i ${cwd}`);

  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      s.output = (s.output + clean(chunk.toString())).slice(-8000);
      const url = /https:\/\/[^\s\x07\x1b\]]+/.exec(s.output)?.[0];
      if (url && !s.url) {
        s.url = url;
        resolve({ session: s.id, url });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      clearTimeout(s.timer);
      const tail = s.output.trim().split('\n').filter(Boolean).slice(-2).join(' ');
      if (s.status === 'waiting') {
        s.status = code === 0 ? 'done' : 'failed';
        s.message = code === 0 ? `Inloggad på ${server}.` : tail || `Inloggningen avbröts (${code}).`;
      }
      console.log(`[mcp-login] ${server}: ${s.status}`);
      void removeAdded(s);
      if (!s.url) reject(new Error(s.message));
    });
    setTimeout(() => {
      if (!s.url) {
        cancelMcpLogin(s.id);
        reject(new Error('fick ingen inloggningsadress från claude'));
      }
    }, 30_000);
  });
}

export function mcpLoginStatus(id: string) {
  const s = sessions.get(id);
  if (!s) throw new Error('inloggningen finns inte längre');
  return { status: s.status, message: s.message, server: s.server };
}

/** The address the browser ended on, when it could not reach back by itself. */
export function pasteMcpRedirect(id: string, url: string) {
  const s = sessions.get(id);
  if (!s || s.status !== 'waiting') throw new Error('inloggningen väntar inte längre');
  if (!/^https?:\/\//.test(url.trim())) throw new Error('klistra in hela adressen från webbläsaren');
  s.child.stdin.write(`${url.trim()}\r`);
}

export function cancelMcpLogin(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.status === 'waiting') {
    s.status = 'failed';
    s.message = 'Avbruten.';
    s.child.kill('SIGTERM');
  }
  void removeAdded(s);
}
