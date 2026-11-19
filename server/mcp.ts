import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bus, type Approval } from './bus.ts';
import { OWNER, OWNERS } from './owner.ts';
import {
  addEvent,
  addNotice,
  createSubtask,
  savePlan,
  getSubtask,
  listSubtasks,
  listTasks,
  updateSubtask,
  type Ask,
  type Login,
  type Subtask,
  type SubtaskStatus,
} from './db.ts';
import { attachImage, generateImage, IMAGE_MODEL, imagesAvailable } from './images.ts';
import { askPeer, replyPeer } from './handoff.ts';
import { appendNote, getTeam, repoFor, type Role, type RoleKind, type Team } from './roles.ts';
import { sleepVm, vmFor, wakeVm } from './vms.ts';
import { suggestInfra } from './infra.ts';

/**
 * The control room's own MCP server. Every agent process gets a token for its
 * card; the token is the agent's identity here, so a card can only act as
 * itself and only inside its own team.
 */

const tokens = new Map<string, number>();

export function issueToken(subtaskId: number): string {
  const token = randomBytes(24).toString('hex');
  tokens.set(token, subtaskId);
  return token;
}

export function revokeToken(token: string) {
  tokens.delete(token);
}

// ---------------------------------------------------------------- reports

export interface Report {
  status: 'done' | 'pr-open' | 'needs-you' | 'failed' | 'watching';
  summary: string;
  prUrl?: string;
  ask?: Ask;
}

const reports = new Map<number, Report>();
/** What the agent said with `report` during its turn; read once when the turn ends. */
export function takeReport(subtaskId: number): Report | undefined {
  const r = reports.get(subtaskId);
  reports.delete(subtaskId);
  return r;
}

// ---------------------------------------------------------------- locks

/** Things only one agent can use at a time: a simulator, an emulator, the Windows PC. */
export const RESOURCES = ['ios-simulator', 'android-emulator', 'windows-pc', 'parallels-vm', 'metro-8081'] as const;
const locks = new Map<string, number>();

/** VMs a card woke: they go back to sleep when the card lets go. */
const wokenVms = new Map<string, { teamId: string; subtaskId: number }>();

export function releaseLocks(subtaskId: number) {
  for (const [resource, holder] of locks) if (holder === subtaskId) locks.delete(resource);
  for (const [resource, w] of wokenVms) {
    if (w.subtaskId !== subtaskId) continue;
    wokenVms.delete(resource);
    const team = getTeam(w.teamId);
    const vm = team && vmFor(team, resource);
    if (vm) void sleepVm(vm).catch(() => undefined);
  }
}

export const lockHolders = () => Object.fromEntries(locks);

/** A deploy job takes a resource too, so no card grabs the VM mid-build. Holder -1 is "a deploy". */
export function lockForDeploy(resource: string): number | null {
  const holder = locks.get(resource);
  if (holder !== undefined && holder !== -1) return holder;
  locks.set(resource, -1);
  return null;
}

export function unlockDeploy(resource: string) {
  if (locks.get(resource) === -1) locks.delete(resource);
}

// ---------------------------------------------------------------- approvals

const pending = new Map<string, { approval: Approval; resolve: (allow: boolean, reason?: string) => void }>();

export const listApprovals = () => [...pending.values()].map((p) => p.approval);

export function decideApproval(id: string, allow: boolean, reason?: string) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  p.resolve(allow, reason);
  bus.emit({ type: 'approval-done', id });
  return true;
}

/** An approval nobody answers is a no, after half an hour; the card is not left hanging forever. */
const APPROVAL_TIMEOUT = 30 * 60 * 1000;

function askApproval(subtask: Subtask, tool: string, input: unknown): Promise<{ allow: boolean; reason?: string }> {
  const asked = requestApproval({ subtaskId: subtask.id, team: subtask.team }, tool, input);
  bus.emit({ type: 'event', event: addEvent(subtask.id, 'status', `Väntar på ditt godkännande: ${tool} ${asked.approval.summary.slice(0, 200)}`) });
  return asked.answer;
}

/** Asks the owner on the board; a card or a Gudfadern conversation. */
export function requestApproval(
  owner: { subtaskId: number | null; conversationId?: number; team: string },
  tool: string,
  input: unknown,
): { approval: Approval; answer: Promise<{ allow: boolean; reason?: string }> } {
  const detail =
    input && typeof input === 'object'
      ? String((input as Record<string, unknown>).command ?? (input as Record<string, unknown>).file_path ?? JSON.stringify(input))
      : String(input);
  const approval: Approval = {
    id: randomUUID(),
    ...owner,
    tool,
    summary: detail.slice(0, 600),
    at: new Date().toISOString(),
  };
  const answer = new Promise<{ allow: boolean; reason?: string }>((resolve) => {
    const timer = setTimeout(() => decideApproval(approval.id, false, 'Ingen svarade inom 30 minuter.'), APPROVAL_TIMEOUT);
    pending.set(approval.id, {
      approval,
      resolve: (allow, reason) => {
        clearTimeout(timer);
        resolve({ allow, reason });
      },
    });
    bus.emit({ type: 'approval', approval });
  });
  return { approval, answer };
}

// ---------------------------------------------------------------- tools

interface Ctx {
  subtask: Subtask;
  team: Team;
  role: Role;
}

interface Tool {
  name: string;
  description: string;
  kinds: RoleKind[] | 'all';
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, any>, ctx: Ctx) => Promise<string> | string;
}

let onBoardChange = () => {};
/** The scheduler hears about new cards an agent made, so they start without waiting. */
export function onCardsCreated(listener: () => void) {
  onBoardChange = listener;
}

let messageCard: (id: number, text: string) => Promise<void> = async () => {};
/** How a lead's reply reaches another card's agent; set by the server, which owns the agents. */
export function onMessageCard(listener: (id: number, text: string) => Promise<void>) {
  messageCard = listener;
}


function emitSubtask(s: Subtask) {
  bus.emit({ type: 'subtask', subtask: s });
}

function roster(team: Team): string {
  return team.roles.map((r) => `${r.id} (${r.name}: ${r.title})`).join('; ');
}

function sameTeamCard(id: unknown, ctx: Ctx): Subtask {
  const s = getSubtask(Number(id));
  if (!s || s.team !== ctx.team.id) throw new Error(`kort ${id} finns inte i ${ctx.team.name}`);
  return s;
}

function newCard(ctx: Ctx, agent: string, brief: string, dependsOn: number[], parentId: number | null, repo?: string | null): Subtask {
  if (!ctx.team.roles.some((r) => r.id === agent)) throw new Error(`okänd agent "${agent}". Teamet: ${roster(ctx.team)}`);
  for (const d of dependsOn) sameTeamCard(d, ctx);
  // Several repos: a card may name the one it is about; the agent's own is the default.
  if (repo && !ctx.team.repos.some((r) => r.id === repo)) throw new Error(`okänt repo "${repo}". Teamets repon: ${ctx.team.repos.map((r) => r.id).join(', ')}`);
  const s = createSubtask({ id: ctx.subtask.taskId, team: ctx.team.id }, agent, brief, { dependsOn, parentId, repo: repo || null });
  emitSubtask(s);
  addEvent(s.id, 'system', `Skapat av ${ctx.role.name} (kort ${ctx.subtask.id}).`);
  onBoardChange();
  return s;
}

/** The lead of a task, if it has one: the card a delegation is reported to. */
function leadOf(taskId: number, team: Team): Subtask | undefined {
  const leads = new Set(team.roles.filter((r) => r.kind === 'lead' || r.kind === 'bug').map((r) => r.id));
  return listSubtasks().find((s) => s.taskId === taskId && leads.has(s.agent));
}

function describe(s: Subtask): string {
  const parts = [`#${s.id} ${s.agent} [${s.status}]`, s.brief.split('\n')[0].slice(0, 140)];
  if (s.dependsOn.length) parts.push(`väntar på ${s.dependsOn.map((d) => `#${d}`).join(', ')}`);
  if (s.prUrl) parts.push(s.prUrl);
  if (s.note) parts.push(`notis: ${s.note.slice(0, 200)}`);
  return parts.join(' · ');
}

/** A login from report, with only fixes the card's button can run. */
function loginOf(raw: unknown): Login | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const what = typeof r.what === 'string' ? r.what.trim() : '';
  if (!what) return null;
  const fix = typeof r.fix === 'string' && /^(login-claude|login-host:(github|azure)|azure-profile|azure-portal|infra:[\w-]+|mcp-[\w.-]+)$/.test(r.fix.trim()) ? r.fix.trim() : undefined;
  const url = typeof r.url === 'string' && /^https:\/\//.test(r.url.trim()) ? r.url.trim() : undefined;
  return { what, ...(fix ? { fix } : {}), ...(url ? { url } : {}) };
}

const TOOLS: Tool[] = [
  {
    name: 'report',
    kinds: 'all',
    description:
      `Säg hur ditt kort slutar, precis innan du avslutar turen. status: "pr-open" (PR öppen, ange pr_url), "done" (klart utan PR), "needs-you" (du behöver ${OWNER}), "failed" (går inte), eller "watching" (du har kort ute, t.ex. en designfråga hos designern, och väntar på dem; du väcks när de är klara). Vid needs-you: question = frågan i en eller två meningar; options = 2–4 korta alternativ när det finns några att välja mellan (${OWNER} klickar ett eller skriver eget); unblock = om det gäller ett test du inte kunde göra: exakt vad du behöver för att göra det själv (en inloggning, en enhet, en fil, en miljö); login = när du stoppar för att något är utloggat eller en inloggning gått ut (gh, az, en MCP-server, App Store Connect, en webbsida): vad som är utloggat, så får ${OWNER} en knapp som loggar in igen.`,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pr-open', 'done', 'needs-you', 'failed', 'watching'] },
        summary: { type: 'string', description: 'Ett par meningar på svenska.' },
        pr_url: { type: 'string' },
        question: { type: 'string', description: `Vid needs-you: frågan till ${OWNER}.` },
        options: { type: 'array', items: { type: 'string' }, description: 'Vid needs-you: 2–4 korta alternativ.' },
        unblock: { type: 'string', description: 'Vid needs-you för ett test: vad du behöver för att testa själv.' },
        login: {
          type: 'object',
          description: 'Vid needs-you för att något är utloggat.',
          properties: {
            what: { type: 'string', description: 'Vad som är utloggat, med konto om du vet det, t.ex. "gh (GitHub) för kontot anna" eller "MCP-servern figma".' },
            fix: {
              type: 'string',
              description:
                'Om det loggas in med ett kommando: "login-host:github" (gh), "login-host:azure" (az), "azure-profile" (projektets az-profil för DevOps), "azure-portal" (projektets az-profil för Azure-portalen), "infra:<post-id>" (en post under Infrastruktur, står i din prompt), "mcp-<server-id>" (en MCP-server), "login-claude" (Claude-kontot).',
            },
            url: { type: 'string', description: 'Annars: sidan där man loggar in i webbläsaren.' },
          },
          required: ['what'],
        },
      },
      required: ['status', 'summary'],
    },
    run: (a, ctx) => {
      // Anyone with cards out may wait on them: an app agent that sent a design question to the designer.
      const open = listSubtasks().some((c) => c.parentId === ctx.subtask.id && c.status !== 'done' && c.status !== 'failed');
      const standing = listTasks().find((t) => t.id === ctx.subtask.taskId)?.title === 'Boarden';
      if (a.status === 'watching' && !open && !standing)
        throw new Error(`du har inga öppna kort att bevaka: rapportera done om arbetet är klart, eller needs-you om något väntar på ${OWNER}`);
      const options = Array.isArray(a.options) ? a.options.map(String).map((o: string) => o.trim()).filter(Boolean).slice(0, 4) : [];
      const ask: Ask | undefined =
        a.status === 'needs-you'
          ? {
              question: String(a.question ?? a.summary).trim(),
              ...(options.length ? { options } : {}),
              ...(a.unblock && String(a.unblock).trim() ? { unblock: String(a.unblock).trim() } : {}),
              ...(loginOf(a.login) ? { login: loginOf(a.login)! } : {}),
            }
          : undefined;
      reports.set(ctx.subtask.id, { status: a.status, summary: String(a.summary), prUrl: a.pr_url, ask });
      return 'Noterat. Avsluta turen nu.';
    },
  },
  {
    name: 'create_subtask',
    kinds: ['lead', 'bug', 'tester'],
    description:
      'Skapa ett kort åt en agent i teamet, under samma uppgift. Briefen ska stå på egna ben: agenten ser bara den. depends_on: kort som måste vara klara (status done, alltså PR mergad) innan det här startar. Du blir förälder och väcks när kortet rör sig.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Roll-id, t.ex. backend, ios, android, web, mac, windows, designer, tester.' },
        brief: { type: 'string' },
        depends_on: { type: 'array', items: { type: 'number' } },
        repo: { type: 'string', description: 'Bara när teamet har flera repon och kortet gäller ett annat än agentens eget: repots id.' },
      },
      required: ['agent', 'brief'],
    },
    run: (a, ctx) => {
      // A tester is done when it reports; what it found belongs to the task's lead.
      const parent = ctx.role.kind === 'tester' ? (leadOf(ctx.subtask.taskId, ctx.team)?.id ?? ctx.subtask.id) : ctx.subtask.id;
      const s = newCard(ctx, String(a.agent), String(a.brief), (a.depends_on ?? []).map(Number), parent, a.repo ? String(a.repo) : null);
      return `Kort #${s.id} skapat åt ${s.agent}${s.dependsOn.length ? `, väntar på ${s.dependsOn.join(', ')}` : ''}.`;
    },
  },
  {
    name: 'delegate',
    kinds: ['app', 'designer'],
    description:
      'Lämna över något som hör till en annan agent, t.ex. ett nytt API-fält till backend eller samma ändring på Android. Blir ett eget kort under samma uppgift; teamleadern ser det. Gör inte jobbet själv.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string' },
        brief: { type: 'string', description: 'Vad som behövs och varför, så att agenten klarar sig utan dig.' },
        wait: { type: 'boolean', description: 'true: du väntar på svaret (t.ex. en design att bygga efter). Du blir förälder och väcks när kortet är klart; rapportera watching.' },
        repo: { type: 'string', description: 'Bara när teamet har flera repon och det gäller ett annat än agentens eget: repots id.' },
      },
      required: ['agent', 'brief'],
    },
    run: (a, ctx) => {
      const lead = leadOf(ctx.subtask.taskId, ctx.team);
      const s = newCard(ctx, String(a.agent), String(a.brief), [], a.wait ? ctx.subtask.id : (lead?.id ?? ctx.subtask.id), a.repo ? String(a.repo) : null);
      if (a.wait) return `Kort #${s.id} skapat åt ${s.agent}. Rapportera watching nu; du väcks när det är klart.`;
      return `Kort #${s.id} skapat åt ${s.agent}.${lead ? ` Teamleadern (kort ${lead.id}) följer det.` : ''}`;
    },
  },
  {
    name: 'request_test',
    kinds: ['app', 'designer'],
    description: 'Be testaren verifiera ditt arbete, t.ex. din PR på simulatorn. Beskriv vad som ska provas och hur det ser ut när det fungerar.',
    inputSchema: {
      type: 'object',
      properties: { what: { type: 'string' }, pr_url: { type: 'string' } },
      required: ['what'],
    },
    run: (a, ctx) => {
      const tester = ctx.team.roles.find((r) => r.kind === 'tester');
      if (!tester) throw new Error('teamet har ingen testare');
      const brief = `Verifiera kort #${ctx.subtask.id} (${ctx.role.name})${a.pr_url ? ` – ${a.pr_url}` : ''}.\n\n${a.what}`;
      // The tester checks out the PR in the repo it was made in.
      const s = newCard(ctx, tester.id, brief, [], ctx.subtask.id, ctx.team.repos.length > 1 ? repoFor(ctx.team, ctx.role, ctx.subtask).id : null);
      return `Testkort #${s.id} skapat. Du får svaret som ett meddelande.`;
    },
  },
  {
    name: 'ask_peer',
    kinds: ['lead', 'architect'],
    description:
      'Fråga eller lämna något till ett annat kontrollrum (en kollegas, med eget namn i handoff) via en GitHub-issue i repot. Använd det för det som kräver den andra personens beslut, kod eller miljö, inte för sådant teamet kan själv. Rapportera sedan watching; du väcks när de svarar eller stänger issuen.',
    inputSchema: {
      type: 'object',
      properties: {
        peer: { type: 'string', description: 'Mottagarens namn, som det står i handoff.peers.' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Vad som behövs och varför, så att mottagaren klarar sig utan följdfrågor.' },
      },
      required: ['peer', 'title', 'body'],
    },
    run: async (a, ctx) => `Issue skapad: ${await askPeer(ctx.team.id, ctx.subtask.id, String(a.peer), String(a.title), String(a.body))}. Rapportera watching.`,
  },
  {
    name: 'reply_peer',
    kinds: ['lead', 'architect'],
    description: 'Svara på en GitHub-issue från eller till ett annat kontrollrum. close: true stänger den.',
    inputSchema: {
      type: 'object',
      properties: { issue: { type: 'number' }, text: { type: 'string' }, close: { type: 'boolean' } },
      required: ['issue', 'text'],
    },
    run: async (a, ctx) => {
      await replyPeer(ctx.team.id, Number(a.issue), String(a.text), Boolean(a.close));
      return a.close ? 'Svarat och stängd.' : 'Svarat.';
    },
  },
  {
    name: 'list_board',
    kinds: ['lead', 'bug'],
    description: 'Teamets board: alla kort som inte är klara, plus de senast klara. Använd det för att se läget innan du planerar eller följer upp.',
    inputSchema: { type: 'object', properties: { include_done: { type: 'boolean' } } },
    run: (a, ctx) => {
      const cards = listSubtasks().filter((s) => s.team === ctx.team.id && (a.include_done || s.status !== 'done'));
      const tasks = new Map(listTasks().map((t) => [t.id, t]));
      if (!cards.length) return 'Boarden är tom.';
      const byTask = new Map<number, Subtask[]>();
      for (const c of cards) byTask.set(c.taskId, [...(byTask.get(c.taskId) ?? []), c]);
      return [...byTask]
        .map(([id, cs]) => `Uppgift ${id}: ${tasks.get(id)?.title ?? ''}\n${cs.map((c) => `  ${describe(c)}`).join('\n')}`)
        .join('\n\n');
    },
  },
  {
    name: 'get_subtask',
    kinds: 'all',
    description: 'Läs ett kort i teamet: brief, status, PR och senaste rapport.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    run: (a, ctx) => {
      const s = sameTeamCard(a.id, ctx);
      return `${describe(s)}\n\nBrief:\n${s.brief}${s.summary ? `\n\nSenaste svar:\n${s.summary}` : ''}`;
    },
  },
  {
    name: 'update_subtask',
    kinds: ['lead'],
    description:
      'Styr ett kort: ge det till en annan agent (reassign), ändra beroenden, skriv en notis, eller sätt status queued (kör igen), done eller failed. Ett kort som arbetar just nu kan bara få notis.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        reassign: { type: 'string' },
        depends_on: { type: 'array', items: { type: 'number' } },
        note: { type: 'string' },
        status: { type: 'string', enum: ['queued', 'done', 'failed'] },
      },
      required: ['id'],
    },
    run: (a, ctx) => {
      const s = sameTeamCard(a.id, ctx);
      const changes: Parameters<typeof updateSubtask>[1] = {};
      if (a.note) changes.note = String(a.note);
      if (s.status !== 'running') {
        if (a.reassign) {
          if (!ctx.team.roles.some((r) => r.id === a.reassign)) throw new Error(`okänd agent ${a.reassign}`);
          Object.assign(changes, { agent: String(a.reassign), sessionId: null, worktree: null, branch: null });
        }
        if (a.depends_on) changes.dependsOn = a.depends_on.map(Number);
        if (a.status) changes.status = a.status as SubtaskStatus;
      }
      const updated = updateSubtask(s.id, changes);
      emitSubtask(updated);
      addEvent(s.id, 'system', `Ändrat av ${ctx.role.name}: ${JSON.stringify(a)}`);
      onBoardChange();
      return describe(updated);
    },
  },
  {
    name: 'save_plan',
    kinds: ['architect'],
    description:
      `Spara planen så att ${OWNER} ser den under Planer, där planen kan genomföras, parkeras eller kastas. Spara igen när du reviderat: samma plan uppdateras. body är markdown: Bakgrund, Förslag, Steg per app/roll (vem gör vad, i vilken ordning, beroenden), Risker och öppna frågor, Verifiering. Skriv för teamleadern: den ska kunna dela ut planen utan att fråga dig.`,
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Kort namn på featuren.' }, body: { type: 'string' } },
      required: ['title', 'body'],
    },
    run: (a, ctx) => {
      const plan = savePlan(ctx.team.id, ctx.subtask.id, String(a.title), String(a.body));
      bus.emit({ type: 'plan', plan });
      return `Plan #${plan.id} sparad. Avsluta med report status done, eller needs-you om du har frågor till ${OWNER}.`;
    },
  },
  {
    name: 'reply_to_card',
    kinds: ['lead', 'bug'],
    description:
      `Svara ett kort som väntar på ett beslut, när svaret är ditt att ge (en teknisk fråga, ett förtydligande av uppgiften). Agenten fortsätter med ditt svar. Beslut som är ${OWNERS} (pengar, design, prioritet, något utåtriktat) lämnar du åt ${OWNER}.`,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' }, text: { type: 'string' } },
      required: ['id', 'text'],
    },
    run: async (a, ctx) => {
      const s = sameTeamCard(a.id, ctx);
      if (s.id === ctx.subtask.id) throw new Error('du kan inte svara dig själv');
      await messageCard(s.id, `[${ctx.role.name}, kort ${ctx.subtask.id}] ${a.text}`);
      return `Skickat till kort #${s.id}.`;
    },
  },
  {
    name: 'notify_user',
    kinds: ['lead'],
    description:
      `Säg något till ${OWNER} i notisflödet (och senare som push till telefonen). Bara när det kräver ${OWNER} eller är värt att veta: gruppera, aldrig en notis per händelse.`,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: (a, ctx) => {
      const notice = addNotice(ctx.team.id, ctx.subtask.id, String(a.text));
      bus.emit({ type: 'notice', notice });
      return 'Skickat.';
    },
  },
  {
    name: 'acquire_resource',
    kinds: 'all',
    description: `Lås en delad resurs innan du använder den, så att två agenter inte krockar: ${RESOURCES.join(', ')}. Släpps automatiskt när din tur slutar. Är den upptagen: gör annat och försök senare, eller rapportera.`,
    inputSchema: { type: 'object', properties: { resource: { type: 'string', enum: [...RESOURCES] } }, required: ['resource'] },
    run: (a, ctx) => {
      const holder = locks.get(a.resource);
      if (holder && holder !== ctx.subtask.id) return `Upptagen av kort #${holder}.`;
      locks.set(a.resource, ctx.subtask.id);
      return `${a.resource} är din.`;
    },
  },
  {
    name: 'release_resource',
    kinds: 'all',
    description: 'Släpp en resurs du låst.',
    inputSchema: { type: 'object', properties: { resource: { type: 'string' } }, required: ['resource'] },
    run: (a, ctx) => {
      if (locks.get(a.resource) === ctx.subtask.id) locks.delete(a.resource);
      return 'Släppt.';
    },
  },
  {
    name: 'start_vm',
    kinds: ['tester', 'app'],
    description:
      `Be om att få starta en virtuell maskin, t.ex. parallels-vm (Windows 11 i Parallels på Macen), när den inte är igång. ${OWNER} godkänner i Inkorgen; sedan väcks den, servern väntar tills SSH svarar och den låses åt ditt kort. Startade du den pausas den igen när din tur slutar. Säg varför i reason.`,
    inputSchema: {
      type: 'object',
      properties: { vm: { type: 'string', description: 'Resursnamnet, t.ex. parallels-vm.' }, reason: { type: 'string' } },
      required: ['vm', 'reason'],
    },
    run: async (a, ctx) => {
      const id = String(a.vm);
      const vm = vmFor(ctx.team, id);
      if (!vm) throw new Error(`${id} finns inte i team.json. Finns: ${Object.keys(ctx.team.vms ?? {}).join(', ') || 'inga'}`);
      const holder = locks.get(id);
      if (holder && holder !== ctx.subtask.id) return `Upptagen av kort #${holder}.`;
      const { allow, reason } = await askApproval(ctx.subtask, `Starta ${vm.name}`, { command: String(a.reason) });
      if (!allow) return `${OWNER} sa nej${reason ? `: ${reason}` : ''}. Testa på annat sätt eller rapportera needs-you.`;
      const { woke, message } = await wakeVm(vm);
      locks.set(id, ctx.subtask.id);
      if (woke) wokenVms.set(id, { teamId: ctx.team.id, subtaskId: ctx.subtask.id });
      bus.emit({ type: 'event', event: addEvent(ctx.subtask.id, 'status', message) });
      return `${message} Den är låst åt dig.${woke ? ' Den pausas igen när din tur slutar.' : ''}`;
    },
  },
  {
    name: 'generate_image',
    kinds: ['lead', 'designer'],
    description: `Generera en bild eller illustration med OpenAI (${IMAGE_MODEL}). Bra till skisser, illustrationer, tomma lägen, ikoner att rita om, moodboards. Prompten skickas till OpenAI: inga personuppgifter, kunddata eller hemligheter i den. save_to kopierar bilden till en sökväg i din worktree (för att checka in); annars sparas den bara i kontrollrummet och visas på kortet.`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        name: { type: 'string', description: 'Kort filnamn utan ändelse.' },
        size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536', 'auto'] },
        save_to: { type: 'string', description: 'Relativ sökväg i worktreen, t.ex. design/illustrations/empty-library.png' },
      },
      required: ['prompt'],
    },
    run: async (a, ctx) => {
      if (!imagesAvailable()) throw new Error('OpenAI-nyckel saknas på servern');
      const img = await generateImage({
        team: ctx.team.id,
        prompt: String(a.prompt),
        name: a.name,
        size: a.size,
        saveTo: a.save_to,
        worktree: ctx.subtask.worktree,
      });
      bus.emit({ type: 'event', event: addEvent(ctx.subtask.id, 'image', img.url) });
      return `Bild sparad: ${img.path}${img.copiedTo ? `\nKopierad till ${img.copiedTo}` : ''}\nVisas på kortet. Öppna filen med Read om du vill se den.`;
    },
  },
  {
    name: 'save_note',
    kinds: 'all',
    description:
      'Spara något du lärt dig som nästa kort med din roll har nytta av: ett kommando som fungerar, en fallgrop, var något ligger, hur något testas, eller en rättelse du fått och hur du gör framöver. En mening, konkret. Läggs i din rolls anteckningar och syns i nästa korts prompt. Inte för kortets status (det är report) och inte för det som redan står i CLAUDE.md eller memory.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
    run: (a, ctx) => {
      appendNote(ctx.team.id, ctx.role.id, String(a.note), ctx.subtask.id);
      return 'Sparat.';
    },
  },
  {
    name: 'suggest_infra',
    kinds: 'all',
    description:
      `Föreslå en post under projektets Infrastruktur när du saknar uppgifter om var något körs eller loggar (ett molnprojekt, ett konto, en resurs, Sentry, App Insights, en databas), eller när en post är fel. ${OWNER} godkänner, och sedan får alla agenter den i sin prompt. Ange bara det du har en källa för, och var du hittade det i source. Ändrar du en befintlig post: samma id.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Kort, t.ex. appinsights-prod. Samma id som en befintlig post för att rätta den.' },
        title: { type: 'string' },
        kind: { type: 'string', description: 'google, azure, cloudflare, expo, sentry, appinsights, database …' },
        facts: { type: 'object', additionalProperties: { type: 'string' }, description: 'Det en agent behöver veta: projekt-id, konto, prenumeration, resursnamn.' },
        notes: { type: 'string', description: 'Hur en agent använder det rätt, t.ex. flaggor som aldrig får utelämnas.' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Variabler agenterna ska få. En token: "secret:<namn>".' },
        check: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } }, description: 'Ett kommando som bara läser och lyckas när inloggningen fungerar.' },
        monitor: { type: 'object', description: 'För en felkälla: { type: "sentry", org, project } | { type: "appInsights", appId, subscription } | { type: "googleLogging", project, account }.' },
        source: { type: 'string', description: 'Var du hittade det: fil, kommando eller samtal.' },
      },
      required: ['title', 'kind', 'facts', 'source'],
    },
    run: (a, ctx) => {
      const item = suggestInfra(ctx.team, a, `Föreslaget av ${ctx.role.name} på kort #${ctx.subtask.id}: ${String(a.source ?? '')}`.slice(0, 300));
      const notice = addNotice(ctx.team.id, ctx.subtask.id, `${ctx.role.name} föreslår en post under Infrastruktur: ${item.title}. Godkänn eller avvisa under Inställningar → Infrastruktur (#/${ctx.team.id}/settings).`);
      bus.emit({ type: 'notice', notice });
      return `Föreslaget som "${item.title}". ${OWNER} ser det under Inställningar → Infrastruktur och godkänner.`;
    },
  },
  {
    name: 'show_image',
    kinds: 'all',
    description:
      `Visa en bild du själv tagit på ditt kort, så att ${OWNER} ser den: en skärmdump från simulatorn (xcrun simctl io <udid> screenshot), emulatorn (adb exec-out screencap -p) eller webbläsaren (Playwright). Ange sökvägen, gärna med en bildtext. Krymp stora bilder först med sips -Z 1600.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolut, eller relativ till din worktree.' },
        caption: { type: 'string', description: 'Vad bilden visar, en mening.' },
      },
      required: ['path'],
    },
    run: (a, ctx) => {
      const img = attachImage({ team: ctx.team.id, path: String(a.path), worktree: ctx.subtask.worktree ?? ctx.team.repo });
      if (a.caption) bus.emit({ type: 'event', event: addEvent(ctx.subtask.id, 'status', String(a.caption)) });
      bus.emit({ type: 'event', event: addEvent(ctx.subtask.id, 'image', img.url) });
      return 'Bilden syns nu på kortet.';
    },
  },
  {
    name: 'approve',
    kinds: 'all',
    description: `Används av Claude Code för att be ${OWNER} om lov. Anropa inte själv.`,
    inputSchema: {
      type: 'object',
      properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
      required: ['tool_name', 'input'],
    },
    run: async (a, ctx) => {
      const { allow, reason } = await askApproval(ctx.subtask, String(a.tool_name), a.input);
      bus.emit({
        type: 'event',
        event: addEvent(ctx.subtask.id, 'status', allow ? `Godkänt av ${OWNER}.` : `Nekat${reason ? `: ${reason}` : '.'}`),
      });
      return JSON.stringify(
        allow
          ? { behavior: 'allow', updatedInput: a.input }
          : { behavior: 'deny', message: reason ?? `${OWNER} sa nej. Fortsätt utan det, eller fråga varför i ditt slutmeddelande.` },
      );
    },
  },
];

export function toolsFor(kind: RoleKind): Tool[] {
  return TOOLS.filter((t) => t.kinds === 'all' || t.kinds.includes(kind));
}

/**
 * What a role can do here, for its system prompt: one line per tool. The full
 * description comes with the tool itself, so it is not paid for twice.
 */
export function toolGuide(kind: RoleKind): string {
  return toolsFor(kind)
    .filter((t) => t.name !== 'approve')
    .map((t) => `- \`mcp__control-room__${t.name}\`: ${t.description.split(/(?<=\.)\s/)[0]}`)
    .join('\n');
}

// ---------------------------------------------------------------- JSON-RPC over HTTP

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, any>;
}

async function handle(msg: RpcRequest, ctx: Ctx): Promise<unknown | undefined> {
  const tools = toolsFor(ctx.role.kind);
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'control-room', version: '0.2.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call': {
      const tool = tools.find((t) => t.name === msg.params?.name);
      if (!tool) return { content: [{ type: 'text', text: `Okänt verktyg ${msg.params?.name}` }], isError: true };
      // The card may have changed since the process started (a reassign, a note).
      const fresh = { ...ctx, subtask: getSubtask(ctx.subtask.id) ?? ctx.subtask };
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      // A field the schema requires and the agent left out would be stored as "undefined".
      const required = ((tool.inputSchema as { required?: string[] }).required ?? []).filter(
        (k) => args[k] == null || (typeof args[k] === 'string' && !(args[k] as string).trim()),
      );
      const props = ((tool.inputSchema as { properties?: Record<string, { enum?: unknown[] }> }).properties ?? {});
      const wrong = Object.entries(props).find(([k, p]) => p.enum && args[k] != null && !p.enum.includes(args[k]));
      if (wrong) {
        return { content: [{ type: 'text', text: `${wrong[0]} måste vara ett av ${wrong[1].enum!.map((v) => JSON.stringify(v)).join(', ')}.` }], isError: true };
      }
      if (required.length) {
        return { content: [{ type: 'text', text: `Saknar ${required.join(', ')}. Anropa ${tool.name} igen med ${required.length > 1 ? 'dem' : 'det'} ifyllt.` }], isError: true };
      }
      try {
        const text = await tool.run(args, fresh);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
    default:
      return msg.method.startsWith('notifications/') ? undefined : { __error: `okänd metod ${msg.method}` };
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, body: unknown) {
  const auth = req.headers.authorization ?? '';
  const subtaskId = tokens.get(auth.replace(/^Bearer /, ''));
  const subtask = subtaskId == null ? undefined : getSubtask(subtaskId);
  const team = subtask && getTeam(subtask.team);
  const role = team?.roles.find((r) => r.id === subtask?.agent);
  if (!subtask || !team || !role) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'okänd token' }));
    return;
  }
  const ctx = { subtask, team, role };
  const batch = Array.isArray(body) ? (body as RpcRequest[]) : [body as RpcRequest];
  const out: unknown[] = [];
  for (const msg of batch) {
    const result = await handle(msg, ctx);
    if (msg.id === undefined || result === undefined) continue;
    const r = result as { __error?: string };
    out.push(
      r.__error
        ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: r.__error } }
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
