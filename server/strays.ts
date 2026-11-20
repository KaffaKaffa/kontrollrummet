import { execFile, IS_WINDOWS } from './proc.ts';
import { promisify } from 'node:util';
import { join, sep } from 'node:path';
import { addEvent, listSubtasks, type Subtask } from './db.ts';

/**
 * Processes a card leaves behind: a dev server, a backend on the port the
 * next card needs. Claude Code's own permission check will not let one agent
 * stop another's process, so the control room does it: when a card is done
 * or failed, whatever still runs from inside its worktree is stopped, and an
 * agent that finds a port taken by an old card frees it with free_port.
 * Only processes whose working folder is a card's worktree are touched;
 * anything else (the owner's own servers) is reported, not stopped.
 */

const run = promisify(execFile);

export interface Proc {
  pid: number;
  ppid: number;
  cwd: string;
  command: string;
}

/** Every process's working folder, from one lsof. */
export async function allProcesses(): Promise<Proc[]> {
  if (IS_WINDOWS) return [];
  const { stdout } = await run('lsof', ['-w', '-n', '-d', 'cwd', '-F', 'pRcn'], { maxBuffer: 32 * 1024 * 1024 }).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? '' }));
  const out: Proc[] = [];
  let cur: Partial<Proc> = {};
  for (const line of stdout.split('\n')) {
    const tag = line[0];
    const v = line.slice(1);
    if (tag === 'p') cur = { pid: Number(v) };
    else if (tag === 'R') cur.ppid = Number(v);
    else if (tag === 'c') cur.command = v;
    else if (tag === 'n' && cur.pid) out.push({ pid: cur.pid, ppid: cur.ppid ?? 0, cwd: v, command: cur.command ?? '' });
  }
  return out.filter((p) => p.pid !== process.pid);
}

/** A shell or editor someone opened there: never stopped (the agent's own servers are its children). */
const SPARED = /^-?(zsh|bash|sh|fish|login|tmux|screen|vim|nvim|claude|Code|Cursor)$/i;

/** Folders a local app runs from (devapps.ts): what runs there is the control room's own, never a leftover. */
let protectedRoots: () => string[] = () => [];
export function protectRoots(list: () => string[]) {
  protectedRoots = list;
}
// A checkout's own card worktrees live under it (.claude/worktrees) and are not its.
const isProtected = (cwd: string) => protectedRoots().some((r) => inside(cwd, r) && !inside(cwd, join(r, '.claude', 'worktrees')));

export const inside = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** SIGTERM, then SIGKILL for whatever is still there after a few seconds. */
export async function stop(pids: number[]) {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  await new Promise((r) => setTimeout(r, 3000));
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
}

const describe = (list: Proc[]) => list.map((p) => `${p.pid} ${p.command}`).join(', ');

/** Stops what still runs in these cards' worktrees, and says so on each card. */
async function sweep(cards: Subtask[]) {
  const withTree = cards.filter((c) => c.worktree && !isProtected(c.worktree));
  if (!withTree.length) return;
  const procs = await allProcesses();
  for (const card of withTree) {
    const left = procs.filter((p) => inside(p.cwd, card.worktree!) && !SPARED.test(p.command));
    if (!left.length) continue;
    await stop(left.map((p) => p.pid));
    addEvent(card.id, 'system', `Kortet är ${card.status === 'done' ? 'klart' : 'avslutat'}: stoppade det som fortfarande körde i dess worktree (${describe(left)}).`);
  }
}

const finished = (s: Subtask) => s.status === 'done' || s.status === 'failed';

/** A card that just finished; its processes go a minute later, after any last check of the owner's. */
export function cardFinished(card: Subtask) {
  if (!finished(card) || !card.worktree) return;
  setTimeout(() => {
    void sweep(listSubtasks().filter((s) => s.id === card.id && finished(s))).catch(() => undefined);
  }, 60_000).unref();
}

/** Every few minutes: anything left by a finished card. Also catches what was left before a restart. */
export function startStraySweep() {
  const go = () => void sweep(listSubtasks().filter(finished)).catch((err: Error) => console.error('strays:', err.message));
  setTimeout(go, 30_000).unref();
  setInterval(go, 5 * 60_000).unref();
}

/**
 * free_port: what listens on a port, and if it is an old card's leftover,
 * stop it. The asking card's own processes count as old too.
 */
/** Who listens on a port, by pid. */
export async function listenersOn(port: number): Promise<number[]> {
  if (IS_WINDOWS) return [];
  const { stdout } = await run('lsof', ['-w', '-n', '-P', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'p']).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? '' }));
  return [...new Set(stdout.split('\n').filter((l) => l.startsWith('p')).map((l) => Number(l.slice(1))))];
}

export async function freePort(port: number, asker: Subtask): Promise<string> {
  if (IS_WINDOWS) return 'free_port finns inte på Windows än.';
  const pids = new Set(await listenersOn(port));
  if (!pids.size) return `Port ${port} är redan ledig.`;
  const procs = await allProcesses();
  const listeners = procs.filter((p) => pids.has(p.pid));
  const cards = listSubtasks().filter((s) => s.worktree);
  const owner = (p: Proc) => cards.find((c) => inside(p.cwd, c.worktree!));
  const blocked: string[] = [];
  const trees = new Set<string>();
  for (const p of listeners) {
    const card = owner(p);
    if (isProtected(p.cwd)) blocked.push(`${p.pid} ${p.command} är en av projektets appar som kontrollrummet kör. Använd den med use_app i stället för att starta en egen.`);
    else if (!card) blocked.push(`${p.pid} ${p.command} i ${p.cwd}: hör inte till något kort, så den stoppas inte. Be ägaren stänga den, eller använd en annan port.`);
    else if (card.status === 'running' && card.id !== asker.id) blocked.push(`${p.pid} ${p.command} hör till kort #${card.id}, som arbetar just nu. Vänta på det, eller använd lock.`);
    else trees.add(card.worktree!);
  }
  if (blocked.length) return `Port ${port} kan inte frigöras:\n${blocked.join('\n')}`;
  // An old card's leftover goes whole, not only the listener (`dotnet run` would start the app
  // again). In the asking card's own worktree only the listener and the launcher above it.
  const own = asker.worktree;
  const victims = procs.filter((p) => {
    if (SPARED.test(p.command)) return false;
    if (own && inside(p.cwd, own)) return pids.has(p.pid) || listeners.some((l) => l.ppid === p.pid && !/sh$/.test(p.command));
    return [...trees].some((t) => inside(p.cwd, t));
  });
  await stop(victims.map((p) => p.pid));
  for (const t of trees) {
    const card = cards.find((c) => c.worktree === t);
    if (card && card.id !== asker.id) addEvent(card.id, 'system', `Kort #${asker.id} behövde port ${port}: stoppade det som körde kvar i worktreen (${describe(victims.filter((p) => inside(p.cwd, t)))}).`);
  }
  return `Port ${port} frigjord: stoppade ${describe(victims)}.`;
}
