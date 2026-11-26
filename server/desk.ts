import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { planAction, submitTask, type PlanAction } from './actions.ts';
import { getSubtask, listEvents, listNotices, listPlans, listSubtasks, listTasks, type Subtask } from './db.ts';
import { isRunning, startAgent } from './agent.ts';
import { decideApproval, listApprovals } from './mcp.ts';
import { loadTeams, whoIn, type Team } from './roles.ts';
import { scanRepo } from './scan.ts';
import { createProject, librarySkills, listTemplates } from './project.ts';
import { accountsView, defaultAccountId } from './accounts.ts';
import { bus } from './bus.ts';
import { OWNER } from './owner.ts';
import { setUpNewProject } from './infra.ts';

/**
 * The desks: Claude Code sessions the owner drives from the Claude app through
 * Remote Control (desks/teamleader, desks/architect). They act as the owner on
 * the board: hand out tasks, follow cards, answer, approve and plan. The board
 * stays the record; a desk is a way in, not a second team.
 */

const TOKEN_FILE = join(DATA_DIR, 'desk-token');

export const deskToken: string = existsSync(TOKEN_FILE)
  ? readFileSync(TOKEN_FILE, 'utf8').trim()
  : (() => {
      const t = randomBytes(24).toString('hex');
      writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
      return t;
    })();

function team(id?: string): Team {
  const teams = loadTeams();
  const t = id ? teams.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase()) : teams[0];
  if (!t) throw new Error(`okänt team. Finns: ${teams.map((x) => x.id).join(', ')}`);
  return t;
}

function card(id: unknown): Subtask {
  const s = getSubtask(Number(id));
  if (!s) throw new Error(`kort ${id} finns inte`);
  return s;
}

const line = (s: Subtask) =>
  `#${s.id} ${whoIn(s.team, s.agent)} [${s.status}] ${s.brief.split('\n')[0].slice(0, 120)}${s.prUrl ? ` · ${s.prUrl}` : ''}`;

/** Wait for a card's turn to end, so the answer can go straight back to the app. */
async function waitForTurn(id: number, maxMinutes: number): Promise<Subtask> {
  const until = Date.now() + maxMinutes * 60_000;
  // Give the queue a moment to pick it up.
  await new Promise((r) => setTimeout(r, 1500));
  while (Date.now() < until) {
    const s = card(id);
    if (!isRunning(id) && s.status !== 'queued' && s.status !== 'running') return s;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return card(id);
}

function answerOf(s: Subtask): string {
  const said = [...listEvents(s.id)].reverse().find((e) => e.kind === 'text');
  return said?.body ?? s.summary ?? '(inget svar)';
}

export interface DeskTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (a: Record<string, any>) => Promise<string> | string;
}

const teamArg = { team: { type: 'string', description: 'Team-id. Utelämnat: första teamet.' } };

/** Acting as the owner on the board: the desks' tools, and Gudfadern's. */
export const DESK_TOOLS: DeskTool[] = [
  {
    name: 'scan_repo',
    description:
      'Läs in ett repo som ska bli ett projekt i kontrollrummet: git-värd, basbranch, vilka appar det har, CLAUDE.md, skills, .mcp.json och vilka agenter och skills som föreslås. Kostar inga tokens.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: (a) => {
      const r = scanRepo(String(a.path));
      if (!r.exists) return `${r.path} finns inte.`;
      return [
        `${r.path}: ${r.isGit ? `git, ${r.host === 'none' ? 'ingen känd värd' : r.host} (${r.remote ?? 'ingen remote'}), basbranch ${r.baseBranch}` : 'inget git-repo'}`,
        `Hittade: ${r.found.join(' · ') || 'inget särskilt'}`,
        `CLAUDE.md: ${r.claudeMd ? 'ja' : 'nej'}. Skills: ${r.skills.map((s) => s.id).join(', ') || 'inga'}. .mcp.json: ${r.mcpJson.join(', ') || 'ingen'}.`,
        `Föreslagna agenter (mall [äger]): ${r.suggested.roles.map((x) => `${x.template}${x.owns.length ? ` [${x.owns.join(', ')}]` : ''}`).join(', ')}`,
        `Föreslagna skills: ${r.suggested.skills.join(', ') || 'inga'}`,
        `Mallar som finns: ${listTemplates().map((t) => t.id).join(', ')}. Skills i biblioteket: ${librarySkills().map((s) => s.id).join(', ')}.`,
      ].join('\n');
    },
  },
  {
    name: 'create_project',
    description:
      `Skapa ett projekt (team) för ett repo som finns på Macen, efter att ${OWNER} har bekräftat namn, konto, agenter och skills. Använd scan_repo först. Guiden i webben (#/new) gör samma sak med kontroller.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        path: { type: 'string' },
        account: { type: 'string', description: 'Claude-kontots id, se accounts. Utelämnat: standardkontot.' },
        roles: { type: 'array', items: { type: 'object', properties: { template: { type: 'string' }, owns: { type: 'array', items: { type: 'string' } } }, required: ['template'] } },
        skills: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, mode: { type: 'string', enum: ['local', 'commit'] } }, required: ['id', 'mode'] } },
        onboarding: { type: 'boolean', description: 'Ett första kort som skriver CLAUDE.md och checkar in skills.' },
      },
      required: ['name', 'path', 'roles'],
    },
    run: async (a) => {
      const r = await createProject({
        name: String(a.name),
        source: { kind: 'existing', path: String(a.path) },
        account: a.account ? String(a.account) : defaultAccountId(),
        roles: a.roles,
        skills: a.skills ?? [],
        onboarding: a.onboarding !== false,
      });
      bus.emit({ type: 'teams' });
      setUpNewProject(r.teamId);
      return `Projektet ${r.teamId} är skapat för ${r.repo}.${r.card ? ` Onboarding-kort #${r.card}.` : ''} Kontroller och inställningar: #/${r.teamId}/settings.`;
    },
  },
  {
    name: 'accounts',
    description: 'Claude-kontona på Macen: id, namn, om de är inloggade och vilket som är standard.',
    inputSchema: { type: 'object', properties: {} },
    run: () => accountsView().map((x) => `${x.id}: ${x.name}${x.isDefault ? ' (standard)' : ''}, ${x.kind === 'foundry' ? `Foundry, ${x.ready ? 'redo' : 'inte redo'} (${x.detail})` : x.loggedIn ? `inloggat som ${x.email}` : 'inte inloggat'}`).join('\n'),
  },
  {
    name: 'submit_task',
    description:
      'Lämna en uppgift till teamet. Utan agent går den till teamleadern på boarden, som delar ut den. Returnerar kortnumret direkt; teamet jobbar vidare utan att du väntar.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, agent: { type: 'string', description: 'Roll-id om den ska direkt till en agent.' }, ...teamArg },
      required: ['text'],
    },
    run: (a) => {
      const { subtask } = submitTask(team(a.team).id, String(a.text), a.agent || undefined);
      return `Lämnat som kort #${subtask.id} till ${whoIn(subtask.team, subtask.agent)}.`;
    },
  },
  {
    name: 'board',
    description: `Läget på boarden: pågående uppgifter och kort, vad som väntar på ${OWNER}, godkännanden och teamleaderns senaste notiser.`,
    inputSchema: { type: 'object', properties: { include_done: { type: 'boolean' }, ...teamArg } },
    run: (a) => {
      const t = team(a.team);
      const cards = listSubtasks().filter((s) => s.team === t.id && (a.include_done || !['done', 'failed'].includes(s.status)));
      const tasks = new Map(listTasks().map((x) => [x.id, x]));
      const byTask = new Map<number, Subtask[]>();
      for (const c of cards) byTask.set(c.taskId, [...(byTask.get(c.taskId) ?? []), c]);
      const parts = [...byTask].map(([id, cs]) => `Uppgift ${id}: ${tasks.get(id)?.title}\n${cs.map((c) => `  ${line(c)}`).join('\n')}`);
      const approvals = listApprovals().filter((x) => x.team === t.id);
      const notices = listNotices(5).filter((n) => n.team === t.id);
      return [
        parts.length ? parts.join('\n\n') : 'Inget pågår.',
        approvals.length ? `\nGodkännanden som väntar:\n${approvals.map((x) => `  ${x.id}: kort #${x.subtaskId} vill köra ${x.tool}: ${x.summary.slice(0, 160)}`).join('\n')}` : '',
        notices.length ? `\nTeamleaderns senaste notiser:\n${notices.map((n) => `  ${n.text.slice(0, 200)}`).join('\n')}` : '',
      ].join('\n');
    },
  },
  {
    name: 'card',
    description: 'Ett kort i detalj: brief, status, PR, och de senaste händelserna i dess logg.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    run: (a) => {
      const s = card(a.id);
      const events = listEvents(s.id)
        .filter((e) => e.kind !== 'tool-result')
        .slice(-15)
        .map((e) => `  [${e.kind}] ${e.body.slice(0, 300)}`);
      return `${line(s)}\n\nBrief:\n${s.brief}\n\nSenaste:\n${events.join('\n')}`;
    },
  },
  {
    name: 'message_card',
    description:
      'Skriv till ett korts agent, t.ex. svara på en fråga den ställt. wait: vänta på agentens svar (upp till max_minutes, standard 15) och få det tillbaka.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' }, text: { type: 'string' }, wait: { type: 'boolean' }, max_minutes: { type: 'number' } },
      required: ['id', 'text'],
    },
    run: async (a) => {
      const s = card(a.id);
      await startAgent(s.id, String(a.text));
      if (!a.wait) return `Skickat till kort #${s.id}.`;
      const after = await waitForTurn(s.id, Number(a.max_minutes ?? 15));
      return `Kort #${after.id} [${after.status}]:\n${answerOf(after)}`;
    },
  },
  {
    name: 'decide_approval',
    description: 'Godkänn eller neka något en agent väntar på lov för (id från board).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, allow: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['id', 'allow'],
    },
    run: (a) => (decideApproval(String(a.id), a.allow === true, a.reason) ? 'Klart.' : 'Frågan finns inte längre.'),
  },
  {
    name: 'plan_feature',
    description:
      'Låt arkitekten ta fram en plan för en feature. Väntar tills arkitekten är klar (upp till max_minutes, standard 20) och returnerar planen, eller arkitektens frågor om den behöver svar först.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, max_minutes: { type: 'number' }, ...teamArg },
      required: ['text'],
    },
    run: async (a) => {
      const t = team(a.team);
      const architect = t.roles.find((r) => r.kind === 'architect');
      if (!architect) throw new Error(`${t.name} har ingen arkitekt`);
      const { subtask } = submitTask(t.id, String(a.text), architect.id);
      const after = await waitForTurn(subtask.id, Number(a.max_minutes ?? 20));
      const plan = listPlans().find((p) => p.subtaskId === after.id);
      if (plan) return `Plan #${plan.id}: ${plan.title} [${plan.status}] (arkitektens kort #${after.id})\n\n${plan.body}`;
      return `Arkitektens kort #${after.id} [${after.status}]:\n${answerOf(after)}`;
    },
  },
  {
    name: 'revise_plan',
    description: 'Be arkitekten revidera en plan eller svara på dess frågor. Väntar och returnerar den uppdaterade planen.',
    inputSchema: {
      type: 'object',
      properties: { plan_id: { type: 'number' }, card_id: { type: 'number', description: 'Arkitektens kort, om planen inte finns än.' }, text: { type: 'string' }, max_minutes: { type: 'number' } },
      required: ['text'],
    },
    run: async (a) => {
      const plan = a.plan_id != null ? listPlans().find((p) => p.id === Number(a.plan_id)) : undefined;
      const id = plan?.subtaskId ?? Number(a.card_id);
      if (!id) throw new Error('ange plan_id eller card_id');
      await startAgent(id, String(a.text));
      const after = await waitForTurn(id, Number(a.max_minutes ?? 20));
      const fresh = listPlans().find((p) => p.subtaskId === id);
      return fresh ? `Plan #${fresh.id}: ${fresh.title} [${fresh.status}]\n\n${fresh.body}` : `Kort #${id} [${after.status}]:\n${answerOf(after)}`;
    },
  },
  {
    name: 'plans',
    description: 'Planerna: titel, status och id. include_body för hela texten.',
    inputSchema: { type: 'object', properties: { include_body: { type: 'boolean' }, ...teamArg } },
    run: (a) => {
      const t = team(a.team);
      const ps = listPlans().filter((p) => p.team === t.id);
      if (!ps.length) return 'Inga planer.';
      return ps.map((p) => `#${p.id} [${p.status}] ${p.title}${a.include_body ? `\n${p.body}\n` : ''}`).join('\n');
    },
  },
  {
    name: 'plan_action',
    description: 'Gör något med en plan: implement (lämnas till teamleadern), park, unpark eller discard.',
    inputSchema: {
      type: 'object',
      properties: { plan_id: { type: 'number' }, action: { type: 'string', enum: ['implement', 'park', 'unpark', 'discard'] } },
      required: ['plan_id', 'action'],
    },
    run: (a) => {
      const p = planAction(Number(a.plan_id), a.action as PlanAction);
      return `Plan #${p.id} är nu ${p.status}${p.taskId ? ` (uppgift ${p.taskId})` : ''}.`;
    },
  },
];

interface Rpc {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, any>;
}

async function handle(msg: Rpc): Promise<unknown | undefined> {
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'control-room-desk', version: '0.3.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: DESK_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call': {
      const tool = DESK_TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return { content: [{ type: 'text', text: `Okänt verktyg ${msg.params?.name}` }], isError: true };
      try {
        return { content: [{ type: 'text', text: await tool.run(msg.params?.arguments ?? {}) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
    default:
      return msg.method.startsWith('notifications/') ? undefined : null;
  }
}

export async function handleDesk(req: IncomingMessage, res: ServerResponse, body: unknown) {
  if ((req.headers.authorization ?? '') !== `Bearer ${deskToken}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'okänd token' }));
    return;
  }
  const batch = Array.isArray(body) ? (body as Rpc[]) : [body as Rpc];
  const out: unknown[] = [];
  for (const msg of batch) {
    const result = await handle(msg);
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
