import { execFile, spawn, type ChildProcessWithoutNullStreams } from './proc.ts';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { APP_ROOT, CLAUDE_BIN, DATA_DIR, PORT, expandHome } from './config.ts';
import { getAccount, identityTerminal } from './accounts.ts';
import { countAlso, runningCount } from './agent.ts';
import { accountCap, hasRoomUnder } from './limits.ts';
import { heldBy } from './holds.ts';
import { bus } from './bus.ts';
import { NEVER, CONTROL_ROOM_TOOL_MS, claudeEnv, contextOf, describeTool, toolResultText, userLine } from './claude-run.ts';
import {
  addConvEvent,
  createConversation,
  getConversation,
  listConvEvents,
  listConversations,
  updateConversation,
  type Conversation,
  type ConversationPatch,
  type EventKind,
} from './db.ts';
import { DESK_TOOLS, type DeskTool } from './desk.ts';
import { requestApproval } from './mcp.ts';
import { pauseLeft, pauseUntil, readRateLimitEvent } from './usage.ts';
import { openTerminal } from './terminal.ts';
import { shownText } from './images.ts';
import { slug } from './worktree.ts';
import { setExcluded } from './project.ts';
import { OWNER, OWNERS } from './owner.ts';

const git = promisify(execFile);

/**
 * Gudfadern: Claude with no team, card or role. A conversation runs in any
 * folder on any of the owner's accounts, with the full tool set, and can act on
 * the board like a desk. It is how the control room itself is built further,
 * and a stand-in for the Claude Code app.
 *
 * Every turn is its own `claude -p` process, resumed with --resume, as for the
 * cards; claude-run.ts holds what they share.
 */

const PROMPT = `# Gudfadern

Du är Gudfadern: ${OWNERS} egen Claude i kontrollrummet, utan team och utan kort. ${OWNER} skriver till dig från kontrollrummets webbsida eller från telefonen. Du arbetar i den mapp samtalet startades i och kan göra det en vanlig Claude Code-session gör.

- Kontrollrummets kod ligger i ${APP_ROOT}. Arbetar du i en worktree av den: committa på samtalets branch, så tar ${OWNER} i bruk ändringarna med knappen "Ta i bruk". Starta aldrig om servern själv.
- Med verktygen \`mcp__control-room__*\` agerar du som ${OWNER} på boarden: lämna uppgifter till ett team, följ kort och svara på dem. Arbete i ett teams repo hör hemma hos teamet, inte här, om ${OWNER} inte ber dig göra det själv.
- Följ ${OWNERS} regler för commits och PR:er: ingen AI-attribution.
- Kontrollrummets kod är publik (KaffaKaffa/kontrollrummet): följ CLAUDE.md i repots rot. Inga riktiga namn, kunder, adresser eller nycklar, inte ens i kommentarer och commit-meddelanden. En PR dit görs med skillen pr-kontrollrummet.
- Skriv på svenska, kort och utan utfyllnad. Sammanfatta inte vad du just gjort efter varje steg.
- Det ett verktyg skriver ut läses om vid varje steg efter. Kapa utskrifter (\`| tail -40\`, \`--json\` med få fält) och läs bara de delar av filer du behöver.`;

interface Run {
  child: ChildProcessWithoutNullStreams;
  account: string;
  token: string;
  followUps: string[];
  stopped: boolean;
  limitedUntil: number | null;
  costBefore: number;
  context: number;
  lastError: string;
}

const runs = new Map<number, Run>();
/** Process token → conversation, for the control room's MCP endpoint. */
const tokens = new Map<string, number>();

countAlso((account) => [...runs.values()].filter((r) => !account || r.account === account).length);

export const isConversationRunning = (id: number) => runs.has(id);

function log(id: number, kind: EventKind, body: string) {
  // The owner's message without the paths meant for Claude: the files named in one line.
  const shown = kind === 'user' ? shownText(body, { names: true }) : body;
  if (!shown) return;
  bus.emit({ type: 'conv-event', event: addConvEvent(id, kind, shown) });
}

function patch(id: number, p: ConversationPatch): Conversation {
  const conversation = updateConversation(id, p);
  bus.emit({ type: 'conversation', conversation });
  return conversation;
}

export { listConversations, listConvEvents };

// ---------------------------------------------------------------- creating

export interface NewConversation {
  cwd: string;
  account?: string;
  model?: string;
  effort?: string;
  mcp?: 'none' | 'all';
  /** A worktree and branch of its own, when the folder is a git checkout. */
  worktree?: boolean;
  title?: string;
}

async function gitTop(dir: string): Promise<string | null> {
  try {
    const { stdout } = await git('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function newConversation(input: NewConversation): Promise<Conversation> {
  const cwd = resolve(expandHome(input.cwd?.trim() || homedir()));
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`mappen ${cwd} finns inte`);
  const account = getAccount(input.account).id;
  let conversation = createConversation({
    title: input.title?.trim() || 'Nytt samtal',
    cwd,
    account,
    model: input.model?.trim() || 'opus',
    effort: input.effort ?? 'medium',
    mcp: input.mcp === 'all' ? 'all' : 'none',
  });
  if (input.worktree) {
    const top = await gitTop(cwd);
    if (!top) throw new Error(`${cwd} är inte ett git-repo, så det kan inte få en worktree`);
    const name = `gf-${conversation.id}-${slug(conversation.title === 'Nytt samtal' ? basename(top) : conversation.title)}`.slice(0, 50);
    const path = join(top, '.claude/worktrees', name);
    const branch = `gudfadern/${name}`;
    // From the checkout as it is, not origin: the control room may have changes that are not pushed.
    setExcluded(top, '/.claude/worktrees/', true);
    await git('git', ['worktree', 'add', '-b', branch, path, 'HEAD'], { cwd: top });
    conversation = updateConversation(conversation.id, { cwd: path, repo: top, branch });
    log(conversation.id, 'system', `Worktree ${path} på ${branch}.`);
  }
  bus.emit({ type: 'conversation', conversation });
  return conversation;
}

// ---------------------------------------------------------------- running

/**
 * A conversation with no session but with history (a new session asked for,
 * or another account) starts with the last exchanges, so it is not lost.
 */
function carryOver(id: number, message: string): string {
  const said = listConvEvents(id)
    .filter((e) => e.kind === 'user' || e.kind === 'text')
    .slice(-9, -1);
  if (!said.length) return message;
  const lines = said.map((e) => `${e.kind === 'user' ? OWNER : 'Du'}: ${e.body.length > 1500 ? `${e.body.slice(0, 1500)}…` : e.body}`);
  return `[Kontrollrummet] Samtalet fortsätter i en ny session. Det senaste som sades:\n\n${lines.join('\n\n')}\n\n---\n\n${message}`;
}

/** A message from the owner: the next turn, or queued for after the one that runs. */
export function sendMessage(id: number, text: string) {
  const conversation = getConversation(id);
  if (!conversation) throw new Error('samtalet finns inte');
  const run = runs.get(id);
  if (run) {
    log(id, 'user', text);
    run.followUps.push(text);
    return;
  }
  if (conversation.title === 'Nytt samtal') patch(id, { title: text.replace(/\s+/g, ' ').trim().slice(0, 60) });
  log(id, 'user', text);
  launch(id, text);
}

function launch(id: number, message: string) {
  let conversation = getConversation(id)!;
  const account = conversation.account;
  const left = pauseLeft(account);
  if (left > 0) {
    const at = new Date(Date.now() + left).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    log(id, 'status', `Kvoten för kontot är slut till ${at}. Byt konto eller skriv igen då.`);
    patch(id, { status: 'quota' });
    return;
  }
  // the owner asked for it, so it does not queue; but say so when the account is already busy.
  if (!hasRoomUnder(runningCount(account), accountCap(account))) {
    log(id, 'system', `Kontot kör redan ${runningCount(account)} agenter. Samtalet startar ändå; kort som väcks väntar tills det finns plats.`);
  }
  const token = randomBytes(24).toString('hex');
  tokens.set(token, id);
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', conversation.model,
    '--permission-mode', 'auto',
    '--permission-prompt-tool', 'mcp__control-room__approve',
    '--mcp-config', JSON.stringify({
      mcpServers: {
        'control-room': { type: 'http', url: `http://127.0.0.1:${PORT}/mcp/godfather`, headers: { Authorization: `Bearer ${token}` }, timeout: CONTROL_ROOM_TOOL_MS },
      },
    }),
    '--append-system-prompt', PROMPT,
    '--allowedTools', 'mcp__control-room',
    '--disallowedTools', ...NEVER,
  ];
  // Only with "all" does it read the account's MCP servers' instructions on every step.
  if (conversation.mcp !== 'all') args.push('--strict-mcp-config');
  if (conversation.effort) args.push('--effort', conversation.effort);
  let first = message;
  if (conversation.sessionId) args.push('--resume', conversation.sessionId);
  else first = carryOver(id, message);

  const child = spawn(CLAUDE_BIN, args, {
    cwd: conversation.cwd,
    env: claudeEnv(account, 0, { CONTROL_ROOM_CONVERSATION: String(id) }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const run: Run = {
    child,
    account,
    token,
    followUps: [],
    stopped: false,
    limitedUntil: null,
    costBefore: conversation.costUsd,
    context: conversation.contextTokens,
    lastError: '',
  };
  runs.set(id, run);
  conversation = patch(id, { status: 'running' });

  createInterface({ input: child.stdout }).on('line', (line) => handleLine(id, run, line));
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  child.on('error', (err) => log(id, 'error', `Kunde inte starta claude: ${err.message}`));
  child.on('close', (code) => {
    if (code !== 0 && stderr.trim() && !run.stopped) log(id, 'error', stderr.trim());
    finish(id, run, code);
  });
  child.stdin.write(userLine(first));
}

function handleLine(id: number, run: Run, line: string) {
  let msg: Record<string, any>;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  switch (msg.type) {
    case 'rate_limit_event': {
      const usage = readRateLimitEvent(run.account, msg);
      if (usage) bus.emit({ type: 'usage', account: run.account, usage });
      const info = msg.rate_limit_info;
      if (info && info.status && info.status !== 'allowed' && info.status !== 'allowed_warning') {
        run.limitedUntil = typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : Date.now() + 30 * 60_000;
      }
      return;
    }
    case 'system':
      if (msg.subtype === 'init' && msg.session_id) patch(id, { sessionId: msg.session_id });
      return;
    case 'assistant': {
      const context = contextOf(msg.message?.usage);
      if (context != null && Math.abs(context - run.context) >= 5_000) {
        run.context = context;
        patch(id, { contextTokens: context });
      }
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) log(id, 'text', block.text);
        else if (block.type === 'tool_use') log(id, 'tool', describeTool(block.name, block.input ?? {}));
      }
      return;
    }
    case 'user':
      for (const block of Array.isArray(msg.message?.content) ? msg.message.content : []) {
        if (block.type === 'tool_result') {
          const text = toolResultText(block.content).trim();
          if (text) log(id, 'tool-result', text.length > 2000 ? `${text.slice(0, 2000)}\n…` : text);
        }
      }
      return;
    case 'result':
      patch(id, { costUsd: run.costBefore + Number(msg.total_cost_usd ?? 0) });
      if (msg.is_error) {
        run.lastError = String(msg.result ?? msg.subtype ?? 'okänt fel');
        log(id, 'error', run.lastError);
      }
      run.child.stdin.end();
      return;
  }
}

function finish(id: number, run: Run, code: number | null) {
  runs.delete(id);
  tokens.delete(run.token);
  if (run.followUps.length && !run.stopped) {
    launch(id, run.followUps.join('\n\n'));
    return;
  }
  if (run.limitedUntil && !run.stopped) {
    pauseUntil(run.account, run.limitedUntil + 60_000);
    const at = new Date(run.limitedUntil).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    log(id, 'status', `Kvoten tog slut. Den återställs ${at}; byt konto eller skriv igen då.`);
    patch(id, { status: 'quota' });
    return;
  }
  if (run.stopped) log(id, 'status', 'Stoppad.');
  patch(id, { status: code === 0 || run.stopped ? 'idle' : 'error' });
  onIdle();
}

export function stopConversation(id: number): boolean {
  const run = runs.get(id);
  if (!run) return false;
  run.stopped = true;
  run.child.kill('SIGTERM');
  return true;
}

export function stopAllConversations() {
  for (const id of runs.keys()) stopConversation(id);
}

/** Cards resume on their own after a restart; a conversation waits for the owner to write. */
export function recoverConversations() {
  for (const c of listConversations()) {
    if (c.status !== 'running') continue;
    updateConversation(c.id, { status: 'idle' });
    addConvEvent(c.id, 'status', 'Servern startades om mitt i en tur. Skriv för att fortsätta där samtalet var.');
  }
}

// ---------------------------------------------------------------- settings

export function updateSettings(
  id: number,
  input: Partial<Pick<Conversation, 'title' | 'account' | 'model' | 'effort' | 'mcp' | 'archived'>>,
): Conversation {
  const current = getConversation(id);
  if (!current) throw new Error('samtalet finns inte');
  const next: ConversationPatch = {};
  if (typeof input.title === 'string' && input.title.trim()) next.title = input.title.trim().slice(0, 80);
  if (typeof input.model === 'string' && input.model.trim()) next.model = input.model.trim();
  if (typeof input.effort === 'string') next.effort = input.effort;
  if (input.mcp === 'all' || input.mcp === 'none') next.mcp = input.mcp;
  if (typeof input.archived === 'boolean') next.archived = input.archived;
  if (typeof input.account === 'string' && input.account !== current.account) {
    const account = getAccount(input.account);
    if (account.id !== input.account) throw new Error('kontot finns inte');
    if (runs.has(id)) throw new Error('vänta tills turen är klar, eller stoppa den, innan du byter konto');
    // A session belongs to one profile and cannot be resumed from another.
    next.account = account.id;
    next.sessionId = null;
    next.contextTokens = 0;
    log(id, 'system', `Bytte till kontot ${account.name}. Nästa meddelande startar en ny session med det senaste i samtalet.`);
  }
  if (next.status === undefined && current.status === 'quota' && next.account) next.status = 'idle';
  return patch(id, next);
}

/** Start over with a fresh session; the next message carries the last exchanges along. */
export function newSession(id: number): Conversation {
  if (runs.has(id)) throw new Error('vänta tills turen är klar, eller stoppa den');
  log(id, 'system', 'Ny session. Nästa meddelande får med sig det senaste i samtalet.');
  return patch(id, { sessionId: null, contextTokens: 0 });
}

export function openConversationInTerminal(id: number) {
  const c = getConversation(id);
  if (!c?.sessionId) throw new Error('samtalet har ingen session än');
  openTerminal({ ...identityTerminal(c.account, 'fortsätt samtalet'), cwd: c.cwd, steps: [[CLAUDE_BIN, '--resume', c.sessionId]] });
}

/** A file the owner attaches: saved where the conversation can read it, and the path goes in the message. */
export function saveUpload(id: number, name: string, base64: string): string {
  if (!getConversation(id)) throw new Error('samtalet finns inte');
  const dir = join(DATA_DIR, 'uploads', String(id));
  mkdirSync(dir, { recursive: true });
  const safe = basename(name).replace(/[^\w.\- ]+/g, '_').slice(-120) || 'fil';
  const path = join(dir, `${Date.now()}-${safe}`);
  writeFileSync(path, Buffer.from(base64, 'base64'));
  return path;
}

// ---------------------------------------------------------------- taking changes into use

let restartWanted = false;
let onIdle = () => {};

/**
 * Merges the conversation's branch into the checkout it came from. For the
 * control room itself the server then restarts, once nothing is running:
 * launchd starts it again, and the start script builds the web app.
 */
export async function applyConversation(id: number): Promise<{ merged: string; restart: boolean }> {
  const c = getConversation(id);
  if (!c?.repo || !c.branch) throw new Error('samtalet har ingen egen branch att ta i bruk');
  if (runs.has(id)) throw new Error('vänta tills turen är klar');
  const { stdout: dirty } = await git('git', ['status', '--porcelain'], { cwd: c.cwd });
  if (dirty.trim()) throw new Error('det finns ändringar som inte är committade i samtalets worktree. Be Gudfadern committa först.');
  const { stdout: ahead } = await git('git', ['rev-list', '--count', `HEAD..${c.branch}`], { cwd: c.repo });
  if (Number(ahead.trim()) === 0) throw new Error('branchen har inga nya commits');
  try {
    await git('git', ['merge', '--no-edit', c.branch], { cwd: c.repo });
  } catch (err) {
    await git('git', ['merge', '--abort'], { cwd: c.repo }).catch(() => undefined);
    throw new Error(`kunde inte merga: ${(err as { stderr?: string }).stderr?.trim() || (err as Error).message}`);
  }
  const { stdout: head } = await git('git', ['log', '-1', '--format=%h %s'], { cwd: c.repo });
  log(id, 'status', `Tagen i bruk i ${c.repo}: ${head.trim()}.`);
  const restart = resolve(c.repo) === resolve(APP_ROOT);
  if (restart) requestRestart();
  return { merged: head.trim(), restart };
}

/** Restart once every agent and conversation is between turns. */
export function requestRestart() {
  restartWanted = true;
  onIdle = checkRestart;
  checkRestart();
}

let restartTimer: NodeJS.Timeout | undefined;

function checkRestart() {
  if (!restartWanted) return;
  // Agents, and builds whose processes would die with the server.
  const busy = runningCount() + heldBy();
  bus.emit({ type: 'restart', waitingFor: busy });
  clearTimeout(restartTimer);
  if (busy > 0) {
    restartTimer = setTimeout(checkRestart, 5000);
    return;
  }
  // launchd (KeepAlive) starts the server again; in dev, node --watch already has.
  console.log('Startar om för att ta ändringar i bruk.');
  setTimeout(() => process.exit(0), 300);
}

export const restartPending = () => restartWanted;

// ---------------------------------------------------------------- MCP

const APPROVE: DeskTool = {
  name: 'approve',
  description: `Används av Claude Code för att be ${OWNER} om lov. Anropa inte själv.`,
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name', 'input'],
  },
  run: () => '',
};

async function approve(id: number, a: Record<string, any>): Promise<string> {
  const { approval, answer } = requestApproval({ subtaskId: null, conversationId: id, team: '' }, String(a.tool_name), a.input);
  log(id, 'status', `Väntar på ditt godkännande: ${approval.tool} ${approval.summary.slice(0, 200)}`);
  const { allow, reason } = await answer;
  log(id, 'status', allow ? 'Godkänt.' : `Nekat${reason ? `: ${reason}` : '.'}`);
  return JSON.stringify(
    allow
      ? { behavior: 'allow', updatedInput: a.input }
      : { behavior: 'deny', message: reason ?? `${OWNER} sa nej. Fortsätt utan det, eller fråga varför.` },
  );
}

const TOOLS = [...DESK_TOOLS, APPROVE];

export async function handleGodfatherMcp(req: IncomingMessage, res: ServerResponse, body: unknown) {
  const id = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
  if (id == null) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'okänd token' }));
    return;
  }
  const batch = (Array.isArray(body) ? body : [body]) as { id?: string | number; method: string; params?: Record<string, any> }[];
  const out: unknown[] = [];
  for (const msg of batch) {
    let result: unknown;
    switch (msg.method) {
      case 'initialize':
        result = {
          protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'control-room-godfather', version: '0.1.0' },
        };
        break;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
        break;
      case 'tools/call': {
        const name = msg.params?.name;
        const args = (msg.params?.arguments ?? {}) as Record<string, any>;
        const tool = TOOLS.find((t) => t.name === name);
        try {
          if (!tool) throw new Error(`Okänt verktyg ${name}`);
          const text = name === 'approve' ? await approve(id, args) : await tool.run(args);
          result = { content: [{ type: 'text', text }] };
        } catch (err) {
          result = { content: [{ type: 'text', text: (err as Error).message }], isError: true };
        }
        break;
      }
      default:
        result = msg.method.startsWith('notifications/') ? undefined : null;
    }
    if (msg.id === undefined || result === undefined) continue;
    out.push(
      result === null
        ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `okänd metod ${msg.method}` } }
        : { jsonrpc: '2.0', id: msg.id, result },
    );
  }
  if (!out.length) {
    res.writeHead(202);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(Array.isArray(body) ? out : out[0]));
}
