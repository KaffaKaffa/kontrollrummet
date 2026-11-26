import { consultantServers, consultantsSection } from './consultants.ts';
import { spawn, type ChildProcessWithoutNullStreams } from './proc.ts';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_BIN, PORT } from './config.ts';
import { accountCap, hasRoomUnder } from './limits.ts';
import { pauseLeft, pauseUntil, readRateLimitEvent } from './usage.ts';
import { CONTROL_ROOM_TOOL_MS, claudeEnv, contextOf, describeTool, toolResultText, userLine } from './claude-run.ts';
import { issueToken, releaseLocks, reportDenial, revokeToken, takeReport, toolGuide } from './mcp.ts';
import { addGrant, allowedFor, neverFor } from './grants.ts';
import { rulesFor } from './permissions.ts';
import { bus } from './bus.ts';
import { addEvent, getMark, getSubtask, setMark, updateSubtask, type EventKind, type Subtask } from './db.ts';
import { getTeam, peopleNames, peopleSection, readNotes, repoFor, who, type Role, type Team } from './roles.ts';
import { OWNER, withOwner } from './owner.ts';
import { IMAGES_DIR, shownText } from './images.ts';
import { infraEnv, infraSection } from './infra.ts';
import { devAppsSection } from './devapps.ts';
import { accountLabel, accountStatus, getAccount, hasSession, isFoundry } from './accounts.ts';
import { ensureWorktree } from './worktree.ts';
import { serversFor, teamSecrets } from './mcp-servers.ts';
import { ANY_PR_URL, prNumberOf, providerFor } from './git.ts';

/** Roles that plan and follow up. They hand work out; they never do it, so they cannot edit. */
const PLANNERS = new Set(['lead', 'bug', 'architect']);
const HANDS_OFF = ['Edit', 'Write', 'NotebookEdit', 'Task'];

const PLANNER_RULE = `## Du delar ut, du gör inte

Du gör aldrig själva jobbet, inte ens när det verkar litet eller snabbare. Varje del som ska göras blir ett kort med create_subtask, till den agent som äger det. Sedan avslutar du med report status watching. Du väcks med ett meddelande när dina kort rör sig. Rapportera status done först när alla dina kort är klara.`;

/**
 * A card woken with a conversation bigger than this starts a new session with
 * the card's brief and latest state instead of resuming: a wake-up only needs
 * to know where things stand, not every step that led there.
 */
const FRESH_AT = 70_000;

/** What a fresh session needs to pick a card up where the last one left off. */
function handoff(subtask: Subtask, message: string, why = 'Den förra blev stor, så den är stängd'): string {
  return [
    `Du fortsätter kort #${subtask.id} i en ny session. ${why}; allt du behöver står här och i repot.`,
    `## Uppdraget\n\n${subtask.brief}`,
    subtask.summary || subtask.note ? `## Senaste läget\n\n${subtask.note ?? subtask.summary}` : '',
    subtask.prUrl ? `PR: ${subtask.prUrl}` : '',
    subtask.branch ? `Branch: ${subtask.branch}. Kolla \`git log\` och \`git status\` i worktreen innan du gör något.` : '',
    `## Nytt\n\n${message}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

interface Run {
  child: ChildProcessWithoutNullStreams;
  lastText: string;
  /** Set when Claude says the subscription's limit is reached: when it resets, epoch ms. */
  limitedUntil: number | null;
  stopped: boolean;
  /**
   * Messages that arrived while the agent worked. A process takes exactly one
   * turn (the CLI merges queued input into one turn, so counting turns lies);
   * these become the next turn, resumed in a new process.
   */
  followUps: string[];
  /** The card's cost before this process; total_cost_usd counts every turn of the process. */
  costBefore: number;
  /** This process's identity on the control room's MCP server. */
  token: string;
  /** Tokens read on the latest call, last written to the card. */
  context: number;
  /** The Claude account it runs on: limits and quota are counted per account. */
  account: string;
  /** What this turn was given: sent again once a lost login is back. */
  message: string;
  /** The error the turn ended on, from Claude's result. */
  error: string;
  /** Tool calls of this turn by id, to know what a denial was for. */
  calls: Map<string, { name: string; input: unknown }>;
}

const runs = new Map<number, Run>();
/** Cards between "start" and a live process (the worktree is still being made), with their account. */
const starting = new Map<number, string>();

/** Wake-up messages that waited for a slot or the quota, per card. */
const WAKES = 'wake';

/** The waiting wake-up for a card, taken: the scheduler passes it on when the card starts. */
export function takeWake(subtaskId: number): string | null {
  const text = getMark(WAKES, String(subtaskId));
  if (!text) return null;
  setMark(WAKES, String(subtaskId), null);
  return text;
}

export const isRunning = (subtaskId: number) => runs.has(subtaskId) || starting.has(subtaskId);
/**
 * Processes holding a slot, on one account or all of them. Gudfadern's
 * conversations count too: they share the account's limits.
 */
export function runningCount(account?: string): number {
  let n = extraRunning(account);
  for (const r of runs.values()) if (!account || r.account === account) n++;
  for (const a of starting.values()) if (!account || a === account) n++;
  return n;
}

/** Agents holding a slot for one project (cards only; Gudfadern belongs to no project). */
export function runningInTeam(teamId: string): number {
  let n = 0;
  for (const id of [...runs.keys(), ...starting.keys()]) if (getSubtask(id)?.team === teamId) n++;
  return n;
}

/** Whether a card may start: both its account and its project have room. */
export function hasRoom(subtaskId: number): boolean {
  const s = getSubtask(subtaskId);
  const team = s ? getTeam(s.team) : undefined;
  const account = team?.account ?? '';
  return hasRoomUnder(runningCount(account), accountCap(account)) && (!team || hasRoomUnder(runningInTeam(team.id), team.maxAgents));
}

let extraRunning: (account?: string) => number = () => 0;
/** Other processes on the same accounts (Gudfadern) report how many they run. */
export function countAlso(counter: (account?: string) => number) {
  extraRunning = counter;
}

/** The account a card runs on: its team's. */
export function accountOfCard(subtaskId: number): string {
  const s = getSubtask(subtaskId);
  return (s && getTeam(s.team)?.account) || '';
}
/** Messages that arrived while the card's worktree was still being made. */
const early = new Map<number, string[]>();

let onPaused = () => {};
/** The scheduler hears when the queue must wait for the quota. */
export function onQuotaPause(listener: () => void) {
  onPaused = listener;
}

let slotFreed = () => {};
/** The scheduler hears when a card stops holding a slot without a status change of its own. */
export function onSlotFreed(listener: () => void) {
  slotFreed = listener;
}

function log(subtaskId: number, kind: EventKind, body: string) {
  // The owner's message without the attachment paths: the images show on the card on their own.
  const shown = kind === 'user' ? shownText(body) : body;
  if (!shown) return;
  bus.emit({ type: 'event', event: addEvent(subtaskId, kind, shown) });
}

function patch(id: number, p: Parameters<typeof updateSubtask>[1]) {
  const subtask = updateSubtask(id, p);
  bus.emit({ type: 'subtask', subtask });
  return subtask;
}

/** The project's own shared resources and the scripts that start its app. */
function sharedSection(team: Team): string {
  const parts: string[] = [];
  const res = Object.entries(team.resources);
  if (res.length)
    parts.push(
      `## Delade resurser\n\nBara ett kort åt gången (eller flera på samma branch). Ta den med acquire_resource och ange what (branch eller PR) innan du startar något på den; släpp den med release_resource när du är klar och har stoppat dina servrar.\n${res
        .map(([id, r]) => `- \`${id}\`: ${r.label}${r.ports.length ? ` (portar ${r.ports.join(', ')})` : ''}`)
        .join('\n')}`,
    );
  parts.push(
    '## Uppgiftens titel\n\nTiteln på boarden är först det som skrevs. Är ditt kort överst i uppgiften (utan förälder) och vet du mer, till exempel att den gäller ett ärende med nummer: sätt en bättre titel med `set_task_title`, med ärendets titel och nummer ("US 2491: Radera inaktiva användare").',
  );
  // Law and policy go through the team's own lawyer, whoever notices.
  const lawyer = team.roles.find((r) => r.id === 'jurist' || /jurist/i.test(r.name));
  if (lawyer)
    parts.push(
      `## Juridik\n\nPåverkar något du gör en lag- eller policytext, koppla in ${lawyer.nick ? `${lawyer.nick} (${lawyer.name})` : lawyer.name}, \`${lawyer.id}\`, med delegate och berätta vad som ändras och varför. Det gäller till exempel nya personuppgifter som samlas in eller sparas längre, en ny tredjepart, SDK eller underbiträde (analys, felrapportering, betalning, e-post), cookies och lokal lagring, ändrade villkor, priser eller abonnemang, åldersgränser, och data som flyttas till ett annat land. Hellre en gång för mycket. Är du själv ${lawyer.nick || lawyer.name}: det här är ditt.`,
    );
  const consultants = consultantsSection(team.id);
  if (consultants) parts.push(consultants);
  // The control room runs the apps: the scripts are what their commands start, not for the agents to run.
  if (team.devApps.length) {
    parts.push(devAppsSection(team));
    if (team.runScripts.length)
      parts.push(
        `Apparnas kommandon använder skripten i ${team.runScripts.map((x) => x.path).join(', ')}. Startar en app inte för att skriptet är fel, rätta skriptet (det ligger utanför repot) och kör use_app igen, och säg vad du ändrat i din rapport.`,
      );
  } else if (team.runScripts.length)
    parts.push(
      `## Starta appen\n\nSå här startas appen, på samma sätt som de som jobbar i projektet gör. Använd skripten i stället för att sätta ihop det själv. Fungerar något inte: rätta skriptet (det ligger utanför repot) så att nästa kort slipper, och säg vad du ändrat i din rapport.\n\n${team.runScripts
        .map((x) => `### ${x.path}\n\n${x.about}`)
        .join('\n\n')}`,
    );
  return parts.join('\n\n');
}

function systemPrompt(team: Team, role: Role, subtask: Subtask, prHow: string): string {
  const parts = [
    team.prompt,
    `## Din roll: ${role.name} i team ${team.name}${role.nick ? `\n\nDu heter ${role.nick}. Så kallar alla i projektet dig.` : ''}\n\n${role.prompt}`,
    role.owns.length ? `Du äger: ${role.owns.join(', ')}.` : '',
    peopleSection(team),
    `## Teamet\n\n${team.roles.map((r) => `- ${r.id}: ${who(r)}, ${r.title}${team.repos.length > 1 && r.repos.length ? ` (repo: ${r.repos.join(', ')})` : ''}`).join('\n')}${
      team.roles.some((r) => r.nick) ? '\n\nAgenter med namn kallas vid namn, i text och när ni pratar med varandra. Där ett verktyg vill ha en agent går både roll-id och namn.' : ''
    }`,
    sharedSection(team),
    team.repos.length > 1
      ? `## Repona\n\nProjektet är flera repon i ${team.repo}:\n${team.repos.map((r) => `- ${r.id}: ${r.path} (basbranch ${r.baseBranch})`).join('\n')}\n\n${
          role.worktree
            ? `Det här kortet arbetar i ${repoFor(team, role, subtask).id}. Rör inget annat repo; behövs en ändring där blir det ett eget kort (delegate med repo).`
            : 'Ett kort till en agent gäller dess eget repo. Gäller det ett annat av agentens repon, ange repo i create_subtask.'
        }`
      : '',
    infraSection(team),
    role.kind === 'lead' || role.kind === 'bug' ? PLANNER_RULE : '',
    `## Kontrollrummets verktyg\n\nAvsluta alltid ett kort med \`report\`.\n\n${toolGuide(role.kind)}`,
    '## Det här kortet',
    `Kort #${subtask.id}. Branch: ${subtask.branch ?? '(ingen)'}. Worktree: ${subtask.worktree ?? team.repo}. Basbranch: ${repoFor(team, role, subtask).baseBranch}.`,
    prHow,
    team.vms && Object.keys(team.vms).length
      ? `## Virtuella maskiner\n\n${Object.entries(team.vms)
          .map(([id, vm]) => {
            const ssh = vm.sshHost
              ? ` SSH: \`ssh${vm.sshKey ? ` -i ${vm.sshKey}` : ''}${vm.sshHostKeyAlias ? ` -o HostKeyAlias=${vm.sshHostKeyAlias}` : ''} ${vm.sshUser ? `${vm.sshUser}@` : ''}${vm.sshHost}\`.`
              : '';
            return `- \`${id}\`: ${vm.name}. Starta med start_vm om den inte är igång.${ssh}`;
          })
          .join('\n')}`
      : '',
    (() => {
      const notes = readNotes(team.id, role.id);
      return notes
        ? `## Det din roll har lärt sig\n\nAnteckningar från tidigare kort med din roll. Lita på dem och börja inte om från noll. Lägg till nya lärdomar med save_note.\n\n${notes}`
        : 'Spara det du lär dig om repot med save_note, så slipper nästa kort börja om.';
    })(),
    team.memory
      ? `Projektets memory finns i ${team.memory}. Läs indexet och bara de filer som rör just det här kortet.`
      : '',
  ];
  // shared.md and the roles write {{owner}} for whoever runs this control room, {{people}} for the project's people.
  return withOwner(parts.filter(Boolean).join('\n\n').replaceAll('{{people}}', peopleNames(team, '{{owner}}')));
}



const STATUS_WORD: Record<string, string> = {
  'pr-open': 'PR öppen',
  done: 'Klar',
  'needs-you': 'Behöver dig',
  failed: 'Gick inte',
  watching: 'Bevakar',
};

/** A PR link on GitHub or Azure DevOps. */
const PR_URL = ANY_PR_URL;

function handleLine(subtaskId: number, run: Run, line: string) {
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
      if (msg.subtype === 'init' && msg.session_id) patch(subtaskId, { sessionId: msg.session_id });
      return;
    case 'assistant': {
      const context = contextOf(msg.message?.usage);
      if (context != null) {
        // Often enough to follow on the card, not on every message.
        if (Math.abs(context - run.context) >= 5_000) {
          run.context = context;
          patch(subtaskId, { contextTokens: context });
        }
      }
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) {
          run.lastText = block.text;
          log(subtaskId, 'text', block.text);
        } else if (block.type === 'tool_use') {
          run.calls.set(block.id, { name: block.name, input: block.input ?? {} });
          log(subtaskId, 'tool', describeTool(block.name, block.input ?? {}));
        }
      }
      return;
    }
    case 'user':
      for (const block of Array.isArray(msg.message?.content) ? msg.message.content : []) {
        if (block.type === 'tool_result') {
          const text = toolResultText(block.content).trim();
          if (text) log(subtaskId, 'tool-result', text.length > 2000 ? `${text.slice(0, 2000)}\n…` : text);
          const call = run.calls.get(block.tool_use_id);
          const denied = block.is_error && call ? denialReason(text) : null;
          const subtask = denied ? getSubtask(subtaskId) : undefined;
          if (denied && call && subtask) reportDenial(subtask, call.name, call.input, denied, (what) => allowAndRerun(subtaskId, call.name, what));
        }
      }
      return;
    case 'result': {
      patch(subtaskId, { costUsd: run.costBefore + Number(msg.total_cost_usd ?? 0) });
      if (msg.is_error) {
        run.error = String(msg.result ?? msg.subtype ?? 'okänt fel');
        log(subtaskId, 'error', run.error);
      }
      run.child.stdin.end();
      return;
    }
  }
}

/**
 * Claude Code's own no, said without asking anyone: a rule from --disallowedTools
 * or auto mode's classifier. A no from the owner through the approve tool reads
 * differently and is not asked again.
 */
function denialReason(text: string): string | null {
  const t = text.replace(/^Error:\s*/, '');
  const classifier = /denied by the Claude Code auto mode classifier\.?\s*(?:Reason:\s*(\[[^\]]+\]))?/i.exec(t);
  if (classifier) return `Auto-läget sa nej${classifier[1] ? ` ${classifier[1]}` : ''}.`;
  if (/^Permission to use \S+ .*has been denied\.?$/s.test(t)) return 'En spärr i kontrollrummet sa nej.';
  return null;
}

/** The owner said yes to something Claude Code denied: keep it on the card and let the agent try again. */
function allowAndRerun(subtaskId: number, tool: string, what: string) {
  const grant = addGrant(subtaskId, tool, what);
  const lifted = grant.lifts.length ? ` Spärren ${grant.lifts.join(', ')} gäller inte längre för kortet.` : '';
  log(subtaskId, 'system', `${OWNER} tillät ${tool}: ${what.slice(0, 300)}.${lifted}`);
  // In the owner's words: auto mode's classifier reads the user's messages for what is allowed.
  void startAgent(subtaskId, `Jag tillåter det som nekades: ${tool === 'Bash' ? `\`${what}\`` : `${tool} ${what}`}. Kör det igen och fortsätt där du var.`);
}

/** Claude Code's own login is gone: the agent never got to start. */
const CLAUDE_LOGGED_OUT = /failed to authenticate|oauth (session|token) (has )?expired|not logged in|please run \/login|invalid api key|chainedtokencredential|azureadtokenprovider|defaultazurecredential/i;

function finish(subtaskId: number, run: Run, code: number | null, stderr = '') {
  runs.delete(subtaskId);
  revokeToken(run.token);
  releaseLocks(subtaskId);
  const report = takeReport(subtaskId);
  const subtask = getSubtask(subtaskId);
  if (!subtask) return;
  if (run.followUps.length > 0 && !run.stopped) {
    // the owner wrote while the agent worked: that is the next turn.
    const next = run.followUps.join('\n\n');
    void startAgent(subtaskId, next, { logged: true });
    return;
  }
  // Marked done by hand while it ran: that is the answer, not the stop.
  if (subtask.status === 'done') return;
  const prs = [...run.lastText.matchAll(PR_URL)];
  const pr = prs.at(-1);
  // Out of quota is not a failure: queue it again and let it resume after the reset.
  const limitText = /you've hit your [\w-]+ limit/i.test(run.lastText);
  if (!run.stopped && (run.limitedUntil || (limitText && !report))) {
    const until = run.limitedUntil ?? Date.now() + 30 * 60_000;
    pauseUntil(run.account, until + 60_000);
    patch(subtaskId, { status: 'quota' });
    const at = new Date(until).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    log(subtaskId, 'status', `Kvoten tog slut. Kortet fortsätter av sig självt efter ${at}, när den återställs.`);
    onPaused();
    return;
  }
  if (!run.stopped && !report && CLAUDE_LOGGED_OUT.test(`${run.error}\n${stderr}`)) {
    const account = getAccount(run.account);
    const what = accountLabel(account);
    const question = isFoundry(account)
      ? `${what} kom inte in (${account.foundry!.auth === 'key' ? 'nyckeln saknas eller stämmer inte' : 'inte inloggad i Azure'}), så agenten kom aldrig igång. Åtgärda det och tryck sedan Fortsätt.`
      : `${what} är utloggat, så agenten kom aldrig igång. Logga in och tryck sedan Fortsätt.`;
    patch(subtaskId, {
      status: 'needs-you',
      summary: question,
      ask: { question, login: { what, fix: isFoundry(account) ? 'login-foundry' : 'login-claude' }, retry: run.message },
    });
    log(subtaskId, 'status', `Utloggat: ${what}.`);
    return;
  }
  if (run.stopped) {
    patch(subtaskId, { status: 'needs-you', ask: { question: 'Stoppad. Skriv till agenten för att fortsätta.' } });
    log(subtaskId, 'status', 'Stoppad. Skriv till agenten för att fortsätta.');
  } else if (report) {
    const prUrl = report.prUrl ?? pr?.[0] ?? subtask.prUrl;
    const prNumber = prUrl ? prNumberOf(prUrl) : null;
    // A PR that is reported "done" is not done until it is merged.
    const status = report.status === 'done' && prUrl && !subtask.prUrl ? 'pr-open' : report.status;
    patch(subtaskId, { status, summary: report.summary, note: report.summary, prUrl: prUrl ?? null, prNumber, ask: status === 'needs-you' ? (report.ask ?? null) : null });
    log(subtaskId, 'status', `${STATUS_WORD[status]}: ${report.summary}`);
  } else if (pr) {
    patch(subtaskId, { status: 'pr-open', prUrl: pr[0], prNumber: prNumberOf(pr[0]), summary: run.lastText });
    log(subtaskId, 'status', `PR #${prNumberOf(pr[0])} öppen.`);
  } else if (code !== 0) {
    patch(subtaskId, { status: 'failed', summary: run.lastText || null });
    log(subtaskId, 'status', `Agenten avslutades med kod ${code}.`);
  } else {
    // Finished a turn without a PR: it is asking, or it is done and says so.
    patch(subtaskId, { status: subtask.prUrl ? 'pr-open' : 'needs-you', summary: run.lastText || null });
  }
}

/**
 * Start the card's agent, or resume it with a message from the owner. Every turn
 * is its own `claude -p` process; the conversation carries over with --resume,
 * so nothing is lost when the server restarts between turns.
 */
export async function startAgent(
  subtaskId: number,
  message?: string,
  {
    logged = false,
    wake = false,
    fresh = false,
  }: {
    logged?: boolean;
    wake?: boolean;
    /** Picks up again after a pause (quota, restart): a big session starts over, as on a wake-up. */
    fresh?: boolean;
  } = {},
): Promise<void> {
  const existing = runs.get(subtaskId);
  if (existing) {
    if (message) send(existing, subtaskId, message);
    return;
  }
  // While out of quota, or with every slot taken, wake-ups wait in the queue
  // with their message; only the owner's own messages go straight through.
  const account = accountOfCard(subtaskId);
  const full = !hasRoom(subtaskId);
  if (wake && (pauseLeft(account) > 0 || full)) {
    if (message) {
      const waiting = getMark(WAKES, String(subtaskId));
      setMark(WAKES, String(subtaskId), waiting ? `${waiting}\n\n${message}` : message);
    }
    const s = getSubtask(subtaskId);
    if (s && s.status !== 'queued' && s.status !== 'quota') {
      const quota = pauseLeft(account) > 0;
      patch(subtaskId, { status: quota ? 'quota' : 'queued' });
      log(subtaskId, 'status', quota ? 'Väckningen väntar tills kvoten har återställts.' : 'Väckningen väntar på en ledig plats.');
    }
    return;
  }
  if (starting.has(subtaskId)) {
    if (message) {
      log(subtaskId, 'user', message);
      early.set(subtaskId, [...(early.get(subtaskId) ?? []), message]);
    }
    return;
  }
  starting.set(subtaskId, account);
  try {
    await launch(subtaskId, message, logged, wake, fresh);
  } finally {
    starting.delete(subtaskId);
    if (!runs.has(subtaskId)) slotFreed();
  }
}

async function launch(
  subtaskId: number,
  message: string | undefined,
  logged: boolean,
  wake: boolean,
  fresh: boolean,
): Promise<void> {
  let subtask = getSubtask(subtaskId);
  if (!subtask) throw new Error(`kort ${subtaskId} finns inte`);
  const team = getTeam(subtask.team);
  if (!team) throw new Error(`teamet ${subtask.team} finns inte i teams/`);
  const agent = subtask.agent;
  const role = team.roles.find((r) => r.id === agent);
  if (!role) throw new Error(`rollen ${agent} finns inte i teams/${team.id}/roles/`);

  // No worktree yet, or it was removed after the card was done: (re)make it.
  if (role.worktree && (!subtask.worktree || !existsSync(subtask.worktree))) {
    try {
      const wt = await ensureWorktree(team, repoFor(team, role, subtask), subtask.id, role.id, subtask.brief);
      subtask = patch(subtask.id, { worktree: wt.path, branch: wt.branch });
      log(subtask.id, 'system', `Worktree ${wt.path} på ${wt.branch}.`);
    } catch (err) {
      patch(subtask.id, { status: 'failed' });
      log(subtask.id, 'error', `Kunde inte skapa worktree: ${(err as Error).message}`);
      return;
    }
  }

  const token = issueToken(subtask.id);
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    // A wake-up only reads a status message and reacts; the role may say a cheaper model does.
    '--model', wake && role.wakeModel ? role.wakeModel : role.model,
    // The same judgement as an interactive session; anything it would have to
    // ask about is denied instead of hanging a process nobody is watching.
    '--permission-mode', role.permission,
    // What auto mode would ask about comes to the owner in the board, through our MCP server.
    '--permission-prompt-tool', 'mcp__control-room__approve',
    '--mcp-config', JSON.stringify({
      mcpServers: {
        // Only the servers this role is given: each one's instructions are read on every step.
        // Its own servers, and those of the consultants it may ask that are reached through MCP.
        ...serversFor(team, role.mcp === 'all' ? role : { mcp: [...new Set([...role.mcp, ...consultantServers(team.id, role.id)])] }),
        'control-room': { type: 'http', url: `http://127.0.0.1:${PORT}/mcp`, headers: { Authorization: `Bearer ${token}` }, timeout: CONTROL_ROOM_TOOL_MS },
      },
    }),
    '--append-system-prompt', systemPrompt(team, role, subtask, (await providerFor(repoFor(team, role, subtask).path))?.prHow ?? ''),
    // The control room's own tools never need asking about.
    // What the owner allowed on this card after Claude Code said no.
    '--allowedTools', 'mcp__control-room', ...rulesFor(team.id, PLANNERS.has(role.kind)), ...allowedFor(subtask.id),
    '--disallowedTools', ...neverFor(subtask.id), ...(PLANNERS.has(role.kind) ? HANDS_OFF : []),
    // Skills and commands in the repos that the project has turned off.
    ...team.disabledSkills.map((s) => `Skill(${s})`),
  ];
  // Only "all" gets the account's own servers and connectors; everyone else exactly what it is given.
  if (role.mcp !== 'all') args.push('--strict-mcp-config');
  // Images the owner pasted into a message, and the team's generated ones: readable without asking.
  mkdirSync(join(IMAGES_DIR, team.id), { recursive: true });
  args.push('--add-dir', join(IMAGES_DIR, team.id));
  // A wake-up reads a status and reacts: no long thinking for that.
  const effort = wake ? 'low' : role.effort;
  if (effort) args.push('--effort', effort);
  let first = message ?? subtask.brief;
  // After a pause the prompt cache is gone anyway, so resuming would pay for all of it again.
  if (subtask.sessionId && (wake || fresh) && subtask.contextTokens > FRESH_AT) {
    // A big conversation is not worth reading again for a wake-up.
    log(subtask.id, 'system', `Ny session: den förra hade vuxit till ${Math.round(subtask.contextTokens / 1000)}k.`);
    first = handoff(subtask, first);
    subtask = patch(subtask.id, { sessionId: null, contextTokens: 0 });
  }
  // The project switched account, or Claude Code cleaned the session away: start over instead of failing.
  if (subtask.sessionId && !hasSession(team.account, subtask.sessionId)) {
    log(subtask.id, 'system', `Ny session: den förra finns inte under kontot ${getAccount(team.account).name} (bytt konto eller städad).`);
    first = handoff(subtask, first, 'Den förra finns inte längre under projektets konto');
    subtask = patch(subtask.id, { sessionId: null, contextTokens: 0 });
  }
  if (subtask.sessionId) args.push('--resume', subtask.sessionId);

  const child = spawn(CLAUDE_BIN, args, {
    cwd: subtask.worktree ?? team.repo,
    // An approval can wait for the owner for half an hour; the tool call must outlive that.
    // The team's Claude account and gh, a small compaction window, short tool output.
    env: claudeEnv(team.account, role.context, {
      ...teamSecrets(team),
      // The project's own az login, for Azure DevOps in another tenant.
      ...(team.azureConfigDir ? { AZURE_CONFIG_DIR: team.azureConfigDir } : {}),
      // The project's own accounts and projects on Firebase, Cloudflare, Expo, the Azure portal.
      ...infraEnv(team),
      CONTROL_ROOM_SUBTASK: String(subtask.id),
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const run: Run = {
    child,
    lastText: '',
    stopped: false,
    limitedUntil: null,
    followUps: early.get(subtask.id) ?? [],
    costBefore: subtask.costUsd,
    token,
    context: subtask.contextTokens,
    account: team.account,
    message: first,
    error: '',
    calls: new Map(),
  };
  runs.set(subtask.id, run);
  // A new turn answers whatever was asked: an old question (a login) must not linger.
  patch(subtask.id, { status: 'running', ask: null });

  const id = subtask.id;
  createInterface({ input: child.stdout }).on('line', (line) => handleLine(id, run, line));
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  child.on('error', (err) => log(id, 'error', `Kunde inte starta claude: ${err.message}`));
  child.on('close', (code) => {
    if (code !== 0 && stderr.trim() && !run.stopped) log(id, 'error', stderr.trim());
    finish(id, run, code, stderr);
  });

  early.delete(id);
  write(run, first, logged ? undefined : id);
}

/** A message for an agent that is working: it waits for the turn to end. */
function send(run: Run, subtaskId: number, text: string) {
  log(subtaskId, 'user', text);
  run.followUps.push(text);
}

/** The process's one turn; logged first when given the card to log it on. */
function write(run: Run, text: string, logOn?: number) {
  if (logOn != null) log(logOn, 'user', text);
  run.child.stdin.write(userLine(text));
}

export function stopAgent(subtaskId: number) {
  const run = runs.get(subtaskId);
  if (!run) return false;
  run.stopped = true;
  run.child.kill('SIGTERM');
  return true;
}

export function stopAll() {
  for (const id of runs.keys()) stopAgent(id);
}
