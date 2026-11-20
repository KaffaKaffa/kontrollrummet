import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { bus } from './bus.ts';
import { DATA_DIR, TEAMS_DIR } from './config.ts';
import { OWNER as OWNER_NAME } from './owner.ts';
import { addEvent, getSubtask, type Subtask } from './db.ts';
import { spawn } from './proc.ts';
import { getTeam, loadTeams, type DevApp, type Team } from './roles.ts';
import { allProcesses, freePort, inside, listenersOn, protectRoots, stop as stopPids } from './strays.ts';

/**
 * The project's local development environments, run by the control room:
 * one process per app, started from the owner's button or by the first agent
 * that needs it, and shared by everyone after. An agent never starts its own
 * copy (two backends on one port, a build per card); it asks for the app with
 * use_app and gets it running from its own worktree, or waits in line while
 * someone else uses it. While the owner looks at it, no agent stops it or
 * moves it to another checkout. When the last agent is done the owner chooses:
 * stop it, or leave it running.
 *
 * The process writes to a log file and lives in its own process group, so it
 * carries on through a restart of the server, which picks it up again.
 */

type Status = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

/** Where it runs from: the owner's checkout, or a card's worktree. */
export interface Source {
  root: string;
  card: number | null;
  label: string;
}

interface Use {
  card: number;
  what: string;
}

interface Live {
  status: Status;
  source: Source | null;
  /** The process group's leader. */
  pid: number | null;
  startedAt: string | null;
  /** Why it is not running, when it stopped on its own or would not start. */
  exit: string | null;
  /** Cards using it now. */
  users: Use[];
  /** Cards waiting to run it from their own worktree. */
  queue: Use[];
  /** The owner looks at it: agents may use it as it is, but not stop or move it. */
  held: boolean;
  /** A card finished with it and nobody else needs it: the owner says stop or keep. */
  ask: number | null;
  // Not saved:
  offset: number;
  decoder: StringDecoder;
  watch: NodeJS.Timeout | null;
}

export interface DevAppView extends DevApp {
  key: string;
  status: Status;
  source: Source | null;
  startedAt: string | null;
  exit: string | null;
  users: Use[];
  queue: Use[];
  held: boolean;
  ask: number | null;
  log: string;
}

const DIR = join(DATA_DIR, 'devapps');
const SAVED = join(DIR, 'state.json');
const lives = new Map<string, Live>();

const keyOf = (teamId: string, appId: string) => `${teamId}:${appId}`;
export const logPath = (key: string) => join(DIR, `${key.replace(':', '-')}.log`);

const sameUse = (a: string, b: string) => Boolean(a && b) && a.trim().toLowerCase() === b.trim().toLowerCase();
const finished = (id: number) => {
  const s = getSubtask(id);
  return !s || s.status === 'done' || s.status === 'failed';
};

function live(key: string): Live {
  let l = lives.get(key);
  if (!l) {
    l = { status: 'stopped', source: null, pid: null, startedAt: null, exit: null, users: [], queue: [], held: false, ask: null, offset: 0, decoder: new StringDecoder('utf8'), watch: null };
    lives.set(key, l);
  }
  return l;
}

function save() {
  mkdirSync(DIR, { recursive: true });
  const out: Record<string, unknown> = {};
  for (const [k, l] of lives) {
    if (l.status === 'stopped' && !l.queue.length && !l.ask) continue;
    out[k] = { source: l.source, pid: l.pid, startedAt: l.startedAt, users: l.users, queue: l.queue, held: l.held, ask: l.ask, exit: l.exit, status: l.status };
  }
  writeFileSync(SAVED, JSON.stringify(out, null, 1));
}

function view(team: Team, app: DevApp): DevAppView {
  const key = keyOf(team.id, app.id);
  const l = live(key);
  return { ...app, key, status: l.status, source: l.source, startedAt: l.startedAt, exit: l.exit, users: l.users, queue: l.queue, held: l.held, ask: l.ask, log: logPath(key) };
}

export const devAppsOf = (team: Team) => team.devApps.map((a) => view(team, a));

/** Every project's apps, for the board's state. */
export const allDevApps = () => Object.fromEntries(loadTeams().map((t) => [t.id, devAppsOf(t)]));

function changed(teamId: string) {
  save();
  const team = getTeam(teamId);
  if (team) bus.emit({ type: 'devapps', team: teamId, apps: devAppsOf(team) });
}

let tellCard: (id: number, text: string) => Promise<void> = async () => {};
/** How a card in line is woken when the app is its; set by mcp.ts, which owns the agents' messages. */
export function onTellCard(fn: (id: number, text: string) => Promise<void>) {
  tellCard = fn;
}

// ---------------------------------------------------------------- the process

const alive = (pid: number | null) => {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
};

function signal(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      // gone
    }
  }
}

/** Something answers on the port. */
const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(1500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => {
      // localhost may be ::1 only (Vite).
      const s6 = net.connect({ port, host: '::1' });
      s6.setTimeout(1500, () => (s6.destroy(), resolve(false)));
      s6.once('connect', () => (s6.destroy(), resolve(true)));
      s6.once('error', () => resolve(false));
    });
  });

/** The address gives any HTTP answer at all (a redirect to a login is up). Self-signed dev certificates are fine. */
const urlAnswers = (url: string) =>
  new Promise<boolean>((resolve) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get(u, { rejectUnauthorized: false, timeout: 4000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('timeout', () => (req.destroy(), resolve(false)));
      req.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });

async function isUp(app: DevApp): Promise<boolean> {
  const checks = [...app.ports.map(portOpen), ...(app.url ? [urlAnswers(app.url)] : [])];
  if (!checks.length) return true;
  return (await Promise.all(checks)).every(Boolean);
}

/** New lines in the log go to the board; the open window shows them as they come. */
function pump(key: string, l: Live) {
  const file = logPath(key);
  if (!existsSync(file)) return;
  const size = statSync(file).size;
  if (size < l.offset) l.offset = 0;
  if (size === l.offset) return;
  const fd = openSync(file, 'r');
  try {
    const len = Math.min(size - l.offset, 256 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len === l.offset ? l.offset : size - len);
    l.offset = size;
    const text = l.decoder.write(buf);
    if (text) bus.emit({ type: 'devapp-log', key, text });
  } finally {
    closeSync(fd);
  }
}

/** A line of the control room's own in the app's log. */
function note(key: string, text: string) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(logPath(key), `\n[kontrollrummet] ${text}\n`, { flag: 'a' });
}

/** Follows a started app: the log, whether it answers yet, and whether it is still there. */
function follow(teamId: string, app: DevApp, l: Live) {
  const key = keyOf(teamId, app.id);
  if (l.watch) clearInterval(l.watch);
  let checking = false;
  const since = Date.now();
  l.watch = setInterval(() => {
    pump(key, l);
    if (checking) return;
    if (!alive(l.pid)) {
      clearInterval(l.watch!);
      l.watch = null;
      pump(key, l);
      if (l.status === 'stopping' || l.status === 'stopped') return;
      l.status = 'failed';
      l.exit = l.exit ?? 'Processen avslutades av sig själv.';
      l.pid = null;
      note(key, l.exit);
      for (const u of l.users) addEvent(u.card, 'system', `${app.label} avslutades: ${l.exit}`);
      changed(teamId);
      return;
    }
    if (l.status !== 'starting') return;
    checking = true;
    void isUp(app)
      .then((up) => {
        if (l.status !== 'starting') return;
        if (up) {
          l.status = 'running';
          note(key, `Svarar på ${app.url || app.ports.join(', ')} efter ${Math.round((Date.now() - since) / 1000)} s.`);
          changed(teamId);
        } else if (Date.now() - since > 15 * 60_000 && !l.exit) {
          l.exit = 'Svarar inte efter 15 minuter.';
          changed(teamId);
        }
      })
      .finally(() => (checking = false));
  }, 1000);
  l.watch.unref();
}

async function kill(teamId: string, app: DevApp, why: string) {
  const key = keyOf(teamId, app.id);
  const l = live(key);
  const pid = l.pid;
  if (l.status !== 'stopped' && l.status !== 'failed') {
    l.status = 'stopping';
    changed(teamId);
  }
  note(key, why);
  if (pid) {
    signal(pid, 'SIGTERM');
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 500));
    if (alive(pid)) signal(pid, 'SIGKILL');
  }
  // Whatever it started that left the group and still holds a port (dotnet's app under dotnet watch).
  if (l.source) {
    const root = l.source.root;
    const procs = await allProcesses();
    const left: number[] = [];
    for (const port of app.ports) for (const p of await listenersOn(port)) if (procs.find((x) => x.pid === p && inside(x.cwd, root))) left.push(p);
    if (left.length) await stopPids(left);
  }
  if (l.watch) clearInterval(l.watch);
  l.watch = null;
  pump(key, l);
  l.status = 'stopped';
  l.pid = null;
  l.exit = null;
  changed(teamId);
}

/** What holds the app's ports, when something not started here does. */
async function portsTaken(app: DevApp): Promise<{ port: number; pid: number; what: string }[]> {
  const procs = await allProcesses();
  const out: { port: number; pid: number; what: string }[] = [];
  for (const port of app.ports) {
    for (const pid of await listenersOn(port)) {
      const p = procs.find((x) => x.pid === pid);
      out.push({ port, pid, what: p ? `${p.command} i ${p.cwd}` : 'okänd process' });
    }
  }
  return out;
}

/**
 * Starts the app from a checkout (stopping it first where it runs). Ports held
 * by something else: an old card's leftovers are cleared; anything else stops
 * the start, unless the owner said to take the ports.
 */
async function launch(team: Team, app: DevApp, source: Source, opts: { force?: boolean; asker?: Subtask } = {}) {
  const key = keyOf(team.id, app.id);
  const l = live(key);
  if (l.status !== 'stopped' && l.status !== 'failed') await kill(team.id, app, `Startar om från ${source.label}.`);
  let taken = await portsTaken(app);
  if (taken.length && opts.asker) {
    for (const t of taken) await freePort(t.port, opts.asker);
    taken = await portsTaken(app);
  }
  if (taken.length && opts.force) {
    await stopPids([...new Set(taken.map((t) => t.pid))]);
    taken = await portsTaken(app);
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(logPath(key), `[kontrollrummet] ${app.label} från ${source.label}\n$ ${app.command}\n\n`);
  l.offset = 0;
  l.decoder = new StringDecoder('utf8');
  l.source = source;
  l.startedAt = new Date().toISOString();
  l.ask = null;
  if (taken.length) {
    l.status = 'failed';
    l.exit = `Porten är upptagen: ${taken.map((t) => `${t.port} av PID ${t.pid} (${t.what})`).join('; ')}.`;
    note(key, l.exit);
    pump(key, l);
    changed(team.id);
    return;
  }
  const repo = team.repos.find((r) => r.id === app.repo) ?? team.repos[0];
  const cwd = join(source.root, app.dir);
  if (!existsSync(cwd)) {
    l.status = 'failed';
    l.exit = `Mappen ${cwd} finns inte.`;
    note(key, l.exit);
    pump(key, l);
    changed(team.id);
    return;
  }
  const fd = openSync(logPath(key), 'a');
  const child = spawn('/bin/zsh', ['-lc', app.command], {
    cwd,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, CR_ROOT: source.root, CR_REPO: repo.path, CR_CARD: source.card ? String(source.card) : '', CR_RUN: join(TEAMS_DIR, team.id, 'run') },
  });
  closeSync(fd);
  child.unref();
  child.on('error', (err) => {
    l.exit = err.message;
  });
  l.pid = child.pid ?? null;
  l.status = l.pid ? 'starting' : 'failed';
  l.exit = l.pid ? null : 'Kunde inte starta zsh.';
  changed(team.id);
  follow(team.id, app, l);
}

/** Waits until it answers, fails, or the time is up. */
async function ready(l: Live, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (l.status === 'running') return true;
    if (l.status === 'failed' || l.status === 'stopped') return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return l.status === 'running';
}

const tail = (key: string, lines = 30) => {
  try {
    return readFileSync(logPath(key), 'utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
};

// ---------------------------------------------------------------- sources

export function ownerSource(team: Team, app: DevApp): Source {
  const repo = team.repos.find((r) => r.id === app.repo) ?? team.repos[0];
  return { root: repo.path, card: null, label: `din checkout av ${repo.id}` };
}

/** The card's worktree when it is in the app's repo; otherwise the owner's checkout. */
export function cardSource(team: Team, app: DevApp, card: Subtask): Source {
  const repo = team.repos.find((r) => r.id === app.repo) ?? team.repos[0];
  if (card.worktree && inside(card.worktree, repo.path)) return { root: card.worktree, card: card.id, label: `kort #${card.id}${card.branch ? ` (${card.branch})` : ''}` };
  return { ...ownerSource(team, app), card: card.id };
}

// ---------------------------------------------------------------- the owner

function appOf(teamId: string, appId: string): { team: Team; app: DevApp } {
  const team = getTeam(teamId);
  const app = team?.devApps.find((a) => a.id === appId);
  if (!team || !app) throw new Error('appen finns inte');
  return { team, app };
}

/** The owner starts it, from the own checkout or a card's worktree, and holds it. */
export async function ownerStart(teamId: string, appId: string, from: number | null, force: boolean) {
  const { team, app } = appOf(teamId, appId);
  const card = from ? getSubtask(from) : undefined;
  const source = card ? cardSource(team, app, card) : ownerSource(team, app);
  const l = live(keyOf(teamId, appId));
  l.held = true;
  // Cards using it on another checkout lose it: tell them.
  for (const u of l.users) if (u.card !== card?.id) void tellCard(u.card, `${OWNER_NAME} startade om ${app.label} från ${source.label}. Kör use_app igen om du behöver den.`);
  l.users = l.users.filter((u) => u.card === card?.id);
  await launch(team, app, source, { force });
}

export async function ownerStop(teamId: string, appId: string) {
  const { team, app } = appOf(teamId, appId);
  const l = live(keyOf(teamId, appId));
  for (const u of l.users) {
    addEvent(u.card, 'system', `${OWNER_NAME} stoppade ${app.label}.`);
    void tellCard(u.card, `${OWNER_NAME} stoppade ${app.label}. Kör use_app igen om du fortfarande behöver den.`);
  }
  l.users = [];
  l.held = false;
  l.ask = null;
  await kill(teamId, app, `${OWNER_NAME} stoppade den.`);
  await serveQueue(team, app);
}

/** The owner holds it (agents use it as it is), or lets the agents have it again. */
export async function ownerHold(teamId: string, appId: string, held: boolean) {
  const { team, app } = appOf(teamId, appId);
  const l = live(keyOf(teamId, appId));
  l.held = held;
  if (held) l.ask = null;
  changed(teamId);
  if (!held && !l.users.length) await serveQueue(team, app);
}

/** The owner's answer when the last agent is done: keep it running, or stop it. */
export async function ownerAnswer(teamId: string, appId: string, keep: boolean) {
  const { app } = appOf(teamId, appId);
  const l = live(keyOf(teamId, appId));
  l.ask = null;
  if (keep) changed(teamId);
  else await kill(teamId, app, `${OWNER_NAME} stängde ner den när agenten var klar.`);
}

export function logText(teamId: string, appId: string): string {
  appOf(teamId, appId);
  try {
    const text = readFileSync(logPath(keyOf(teamId, appId)), 'utf8');
    return text.length > 300_000 ? text.slice(-300_000) : text;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- the agents

/** The next in line gets it, started from its worktree, and is woken. */
async function serveQueue(team: Team, app: DevApp) {
  const l = live(keyOf(team.id, app.id));
  l.queue = l.queue.filter((w) => !finished(w.card));
  const next = l.queue.shift();
  if (!next) {
    changed(team.id);
    return;
  }
  const along = l.queue.filter((w) => sameUse(w.what, next.what));
  l.queue = l.queue.filter((w) => !along.includes(w));
  l.users = [next, ...along];
  const card = getSubtask(next.card)!;
  const source = cardSource(team, app, card);
  await launch(team, app, source, { asker: card });
  for (const w of l.users) {
    addEvent(w.card, 'system', `${app.label} är din nu och startar från ${source.label}.`);
    void tellCard(w.card, `${app.label} är din nu: den startar från ${source.label}. Kör use_app igen; den väntar tills appen svarar. Fortsätt sedan testet.`);
  }
}

/** A card is done with the app: the next in line gets it, or the owner is asked. */
async function letGo(team: Team, app: DevApp, cardId: number) {
  const l = live(keyOf(team.id, app.id));
  const was = l.users.some((u) => u.card === cardId);
  l.users = l.users.filter((u) => u.card !== cardId);
  l.queue = l.queue.filter((u) => u.card !== cardId);
  if (!was || l.users.length) return changed(team.id);
  if (l.held) return changed(team.id);
  if (l.queue.length) return serveQueue(team, app);
  if (!app.keepRunning && (l.status === 'running' || l.status === 'starting')) l.ask = cardId;
  changed(team.id);
}

const usage = (team: Team, app: DevApp, l: Live, key: string) => {
  const notes = app.notes ? `\n${app.notes}` : '';
  return `${app.label} kör från ${l.source?.label}: ${app.url || `port ${app.ports.join(', ')}`}.${notes}
Loggen: ${logPath(key)} (läs den med Read eller tail när något går fel).
Starta ingen egen kopia och stoppa den inte. Ändrar du koden i ${l.source?.label} plockar den oftast upp det själv; behöver den startas om, kör use_app med restart: true. Säg done_with_app när du är klar med den.`;
};

/**
 * use_app: the app running from the card's worktree, started if needed, or a
 * place in line. Waits for it to answer, up to a few minutes.
 */
export async function useApp(team: Team, appId: string, card: Subtask, what: string, restart: boolean): Promise<string> {
  const app = team.devApps.find((a) => a.id === appId || a.label.toLowerCase() === appId.toLowerCase());
  if (!app) throw new Error(`okänd app ${appId}. Finns: ${team.devApps.map((a) => a.id).join(', ') || 'inga'}`);
  const key = keyOf(team.id, app.id);
  const l = live(key);
  const source = cardSource(team, app, card);
  const mine = l.users.find((u) => u.card === card.id);
  const active = l.status === 'starting' || l.status === 'running';
  const here = active && l.source?.root === source.root;
  const sharing = active && l.users.some((u) => u.card !== card.id && sameUse(u.what, what));
  const others = l.users.filter((u) => u.card !== card.id);

  if (here || sharing || (mine && active)) {
    if (!mine) l.users.push({ card: card.id, what });
    l.queue = l.queue.filter((w) => w.card !== card.id);
    l.ask = null;
    if (restart && !others.length && !l.held) await launch(team, app, l.source!, { asker: card });
    changed(team.id);
  } else if (active && (others.length || l.held)) {
    if (!l.queue.some((w) => w.card === card.id)) l.queue.push({ card: card.id, what });
    changed(team.id);
    const place = l.queue.findIndex((w) => w.card === card.id) + 1;
    const by = l.held ? `${OWNER_NAME} tittar på den (från ${l.source?.label})` : `kort #${others.map((u) => u.card).join(', #')} använder den (från ${l.source?.label})`;
    return `${app.label} är upptagen: ${by}. Du står som nummer ${place} i kön. Förbered allt utom att starta (branch, beroenden, bygge), rapportera sedan watching. Du väcks när den är din; den startas då från din worktree.`;
  } else {
    // Stopped, failed, or left running from another checkout that nobody uses: it is this card's.
    l.users = [{ card: card.id, what }];
    l.queue = l.queue.filter((w) => w.card !== card.id);
    await launch(team, app, source, { asker: card });
  }

  const ok = await ready(l, 4 * 60_000);
  if (ok) return usage(team, app, l, key);
  if (l.status === 'starting') return `${app.label} startar fortfarande (från ${l.source?.label}). Kör use_app igen om en stund; den väntar då vidare. Loggen: ${logPath(key)}`;
  l.users = l.users.filter((u) => u.card !== card.id);
  changed(team.id);
  return `${app.label} startade inte: ${l.exit ?? 'okänt fel'}
Sista raderna i loggen (${logPath(key)}):
${tail(key)}

Är felet i koden på din branch, rätta det och kör use_app igen. Är det hur appen startas (kommandot: ${app.command}${app.dir ? `, i ${app.dir}` : ''}): ${team.runScripts.length ? `rätta skriptet i ${join(TEAMS_DIR, team.id, 'run')} om det är där felet sitter, annars ` : ''}skriv vad som behöver ändras i din slutrapport, så rättar ${OWNER_NAME} det under Inställningar → Appar.`;
}

export async function doneWithApp(team: Team, appId: string, card: Subtask): Promise<string> {
  const app = team.devApps.find((a) => a.id === appId || a.label.toLowerCase() === appId.toLowerCase());
  if (!app) throw new Error(`okänd app ${appId}`);
  await letGo(team, app, card.id);
  return 'Tack. Stoppa den inte själv; kontrollrummet tar det härifrån.';
}

/** A card that is done, failed or has its PR open lets go of every app it used or waited for. */
export function cardLeftApps(card: Subtask) {
  if (!['done', 'failed', 'pr-open'].includes(card.status)) return;
  const team = getTeam(card.team);
  if (!team) return;
  for (const app of team.devApps) {
    const l = lives.get(keyOf(team.id, app.id));
    if (l && (l.users.some((u) => u.card === card.id) || l.queue.some((u) => u.card === card.id))) void letGo(team, app, card.id).catch(() => undefined);
  }
}

/** For the agents' prompt. */
export function devAppsSection(team: Team): string {
  if (!team.devApps.length) return '';
  const lines = team.devApps.map((a) => {
    const l = live(keyOf(team.id, a.id));
    const now = l.status === 'running' ? `kör nu från ${l.source?.label}` : l.status === 'starting' ? 'startar' : 'stoppad';
    return `- **${a.id}**: ${a.label}, ${a.url || `port ${a.ports.join(', ')}`} (${now})${a.notes ? `. ${a.notes}` : ''}`;
  });
  return `## Projektets appar lokalt

Kontrollrummet kör projektets utvecklingsmiljöer. Behöver du köra appen (testa i webbläsaren, anropa API:t), använd use_app med appens id: den startas från din worktree om ingen använder den, och du delar den med kort som kör samma PR. Starta aldrig en egen kopia med npm, pnpm, dotnet eller ett skript, och stoppa den aldrig själv. Säg done_with_app när du är klar.
${lines.join('\n')}`;
}

// ---------------------------------------------------------------- start-up

/** Picks up the apps that ran before the server restarted. */
export function startDevApps() {
  protectRoots(() => [...lives.values()].filter((l) => l.status !== 'stopped' && l.source).map((l) => l.source!.root));
  if (!existsSync(SAVED)) return;
  let saved: Record<string, Partial<Live>> = {};
  try {
    saved = JSON.parse(readFileSync(SAVED, 'utf8')) as Record<string, Partial<Live>>;
  } catch {
    return;
  }
  for (const [key, s] of Object.entries(saved)) {
    const [teamId, appId] = key.split(':');
    const team = getTeam(teamId);
    const app = team?.devApps.find((a) => a.id === appId);
    if (!team || !app) continue;
    const l = live(key);
    l.source = s.source ?? null;
    l.startedAt = s.startedAt ?? null;
    l.users = s.users ?? [];
    l.queue = s.queue ?? [];
    l.held = s.held ?? false;
    l.ask = s.ask ?? null;
    l.exit = s.exit ?? null;
    if (s.pid && alive(s.pid)) {
      l.pid = s.pid;
      l.status = 'starting';
      try {
        l.offset = statSync(logPath(key)).size;
      } catch {
        l.offset = 0;
      }
      follow(teamId, app, l);
    } else {
      l.status = s.status === 'failed' ? 'failed' : 'stopped';
      l.users = [];
    }
  }
  save();
}

/** The server stops: the apps go on, and are picked up again after. */
export function saveDevApps() {
  save();
}
