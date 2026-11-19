import { useEffect, useReducer } from 'react';

export type SubtaskStatus =
  | 'queued'
  | 'running'
  | 'watching'
  | 'quota'
  | 'needs-you'
  | 'pr-open'
  | 'testing'
  | 'done'
  | 'failed';

export type RoleKind = 'lead' | 'architect' | 'bug' | 'tester' | 'designer' | 'app';

export interface Role {
  id: string;
  kind: RoleKind;
  vibe: string;
  /** Appearance, for the portrait and the 3D office. */
  look?: string;
  /** The 3D character it is drawn as; empty: the template with the role's id. */
  character?: string;
  name: string;
  title: string;
  model: string;
  wakeModel: string;
  context?: number;
  effort?: string;
  /** MCP servers by id besides the control room's, or 'all': the account's whole set. */
  mcp: 'all' | string[];
  owns: string[];
  /** With several repos: the ones it works in, its own first. */
  repos: string[];
  worktree: boolean;
  permission: string;
  prompt: string;
}

export interface Account {
  id: string;
  name: string;
  isDefault: boolean;
  loggedIn: boolean;
  email: string | null;
  organization: string | null;
}

export interface McpServerInfo {
  id: string;
  label: string;
  note: string;
  /** Where it is defined, in words. */
  source: string;
  auth: 'none' | 'oauth' | 'token';
  suggestWhen: string[];
}

export interface RoleTemplateInfo {
  id: string;
  name: string;
  kind: RoleKind;
  title: string;
  model: string;
  mcp: 'all' | string[];
  owns: string[];
  suggestWhen: string[];
}

export interface LibrarySkill {
  id: string;
  label: string;
  description: string;
  suggestWhen: string[];
}

export interface RepoSkill {
  id: string;
  description: string;
  tracked: boolean;
  fromLibrary: boolean;
}

export interface Library {
  templates: RoleTemplateInfo[];
  skills: LibrarySkill[];
}

export interface Team {
  id: string;
  name: string;
  repo: string;
  /** The Claude account its agents run on. */
  account: string;
  /** MCP servers its agents can be given. */
  mcpServers: McpServerInfo[];
  baseBranch: string;
  hasLogo: boolean;
  /** The checkouts: one, or several under the project's folder. */
  repos: { id: string; path: string; baseBranch: string }[];
  /** Hosted on Azure DevOps, and the project's own az profile if it has one. */
  azure: boolean;
  azureConfigDir: string | null;
  /** The az profile for the Azure portal, when another login than DevOps'. */
  azurePortalConfigDir: string | null;
  /** Where the project runs and reads errors from: Inställningar → Infrastruktur. */
  infraItems: InfraItem[];
  monitorEveryMinutes: number;
  /** Existing skills and commands the agents do not use. */
  disabledSkills: string[];
  teamPrompt: string;
  hasReleases: boolean;
  /** The people in the project: who merges, decides, reviews. */
  people: { name: string; account?: string; does?: string }[];
  roles: Role[];
}

export type InfraMonitor =
  | { type: 'sentry'; org: string; project: string }
  | { type: 'appInsights'; appId: string; subscription: string; azureConfigDir?: string }
  | { type: 'googleLogging'; project: string; account?: string };

/** One thing the project runs on or reads errors from (server/roles.ts InfraItem). */
export interface InfraItem {
  id: string;
  title: string;
  kind: string;
  facts: Record<string, string>;
  notes?: string;
  env?: Record<string, string>;
  login?: { env?: Record<string, string>; steps?: string[][]; url?: string; secret?: string };
  check?: { env?: Record<string, string>; command: string[] };
  monitor?: InfraMonitor;
  source?: string;
  suggested?: boolean;
}

export interface Task {
  id: number;
  team: string;
  title: string;
  text: string;
  createdAt: string;
}

export interface Subtask {
  id: number;
  taskId: number;
  team: string;
  agent: string;
  brief: string;
  status: SubtaskStatus;
  dependsOn: number[];
  parentId: number | null;
  note: string | null;
  branch: string | null;
  worktree: string | null;
  sessionId: string | null;
  prNumber: number | null;
  prUrl: string | null;
  summary: string | null;
  /** On needs-you: the question, one-click choices, and what the agent needs to test on its own. */
  ask: { question: string; options?: string[]; unblock?: string; login?: { what: string; fix?: string; url?: string }; retry?: string } | null;
  costUsd: number;
  contextTokens: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentEvent {
  id: number;
  subtaskId: number;
  kind: 'user' | 'text' | 'tool' | 'tool-result' | 'status' | 'error' | 'system' | 'image';
  body: string;
  at: string;
}

export interface Approval {
  id: string;
  /** The card asking, or null when a Gudfadern conversation asks. */
  subtaskId: number | null;
  conversationId?: number | null;
  team: string;
  tool: string;
  summary: string;
  at: string;
}

export interface Notice {
  id: number;
  team: string;
  subtaskId: number | null;
  text: string;
  at: string;
}

export type PlanStatus = 'draft' | 'ready' | 'parked' | 'implementing' | 'done' | 'discarded';

export interface Plan {
  id: number;
  team: string;
  subtaskId: number;
  title: string;
  body: string;
  status: PlanStatus;
  taskId: number | null;
  createdAt: string;
  updatedAt: string;
}

export type ConversationStatus = 'idle' | 'running' | 'quota' | 'error';

/** One of Gudfadern's conversations: Claude in a folder, on an account, with no team. */
export interface Conversation {
  id: number;
  title: string;
  cwd: string;
  repo: string | null;
  branch: string | null;
  account: string;
  model: string;
  effort: string;
  mcp: 'none' | 'all';
  status: ConversationStatus;
  sessionId: string | null;
  contextTokens: number;
  costUsd: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConvEvent {
  id: number;
  conversationId: number;
  kind: AgentEvent['kind'];
  body: string;
  at: string;
}

export interface UsageWindow {
  utilization: number;
  resetsAt: string | null;
  status: string;
}

export interface Usage {
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  seenAt: string;
}

export interface Job {
  id: string;
  team: string;
  app: string;
  kind: 'test' | 'prod' | 'release';
  title: string;
  status: 'running' | 'done' | 'failed';
  log: string;
  startedAt: string;
  endedAt: string | null;
}

interface ServerState {
  teams: Team[];
  tasks: Task[];
  subtasks: Subtask[];
  /** maxAgents is per Claude account. */
  limits: { maxAgents: number; running: number };
  accounts: Account[];
  approvals: Approval[];
  notices: Notice[];
  locks: Record<string, number>;
  images: { available: boolean; model: string };
  plans: Plan[];
  /** Per account: each is its own subscription. */
  usage: Record<string, Usage>;
  jobs: Job[];
  /** Accounts whose queue waits for the subscription's limit to reset, and until when. */
  pausedUntil: Record<string, string>;
  conversations: Conversation[];
  /** A restart to take changes into use is waiting for agents to finish. */
  restartPending: boolean;
  /** Who runs this control room: the name agents ask and wait for. */
  owner: string;
}

export interface Board extends ServerState {
  /** Live events per card, filled as they stream in and when a card is opened. */
  events: Record<number, AgentEvent[]>;
  connected: boolean;
  /** Bumped on every (re)connect, so open logs fetch what they missed while it was down. */
  generation: number;
  /** Gudfadern's conversations' logs, filled as they stream in and when one is opened. */
  convEvents: Record<number, ConvEvent[]>;
  /** While a restart waits: how many agents it waits for. */
  restartWaitingFor: number | null;
}

type Action =
  | { type: 'state'; state: ServerState }
  | { type: 'task'; task: Task }
  | { type: 'subtask'; subtask: Subtask }
  | { type: 'event'; event: AgentEvent }
  | { type: 'events'; subtaskId: number; events: AgentEvent[] }
  | { type: 'notice'; notice: Notice }
  | { type: 'plan'; plan: Plan }
  | { type: 'usage'; account: string; usage: Usage }
  | { type: 'job'; job: Job }
  | { type: 'approval'; approval: Approval }
  | { type: 'approval-done'; id: string }
  | { type: 'connected'; connected: boolean }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'conv-event'; event: ConvEvent }
  | { type: 'conv-events'; conversationId: number; events: ConvEvent[] }
  | { type: 'restart'; waitingFor: number | null };

const initial: Board = {
  teams: [],
  tasks: [],
  subtasks: [],
  limits: { maxAgents: 0, running: 0 },
  accounts: [],
  approvals: [],
  notices: [],
  locks: {},
  images: { available: false, model: '' },
  plans: [],
  usage: {},
  jobs: [],
  pausedUntil: {},
  conversations: [],
  restartPending: false,
  convEvents: {},
  restartWaitingFor: null,
  owner: '',
  events: {},
  connected: false,
  generation: 0,
};

function upsert<T extends { id: number }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function reduce(board: Board, action: Action): Board {
  switch (action.type) {
    case 'state':
      // A server older than the page may lack fields; the page must still draw.
      return {
        ...board,
        ...action.state,
        accounts: action.state.accounts ?? [],
        conversations: action.state.conversations ?? [],
        usage: action.state.usage && !('seenAt' in action.state.usage) ? action.state.usage : {},
        pausedUntil: action.state.pausedUntil && typeof action.state.pausedUntil === 'object' ? action.state.pausedUntil : {},
        teams: action.state.teams.map((t) => ({ ...t, mcpServers: t.mcpServers ?? [], repos: t.repos ?? [], azure: t.azure ?? false, azureConfigDir: t.azureConfigDir ?? null, azurePortalConfigDir: t.azurePortalConfigDir ?? null, infraItems: t.infraItems ?? [], monitorEveryMinutes: t.monitorEveryMinutes ?? 30, disabledSkills: t.disabledSkills ?? [], roles: t.roles.map((r) => ({ ...r, mcp: r.mcp ?? [], repos: r.repos ?? [] })) })),
      };
    case 'task':
      return { ...board, tasks: [action.task, ...board.tasks.filter((t) => t.id !== action.task.id)] };
    case 'subtask': {
      const subtasks = upsert(board.subtasks, action.subtask);
      const running = subtasks.filter((s) => s.status === 'running').length;
      return { ...board, subtasks, limits: { ...board.limits, running } };
    }
    case 'event': {
      const list = board.events[action.event.subtaskId] ?? [];
      if (list.some((e) => e.id === action.event.id)) return board;
      return { ...board, events: { ...board.events, [action.event.subtaskId]: [...list, action.event] } };
    }
    case 'events': {
      // Merge, never replace: lines that streamed in while the fetch was out stay.
      const byId = new Map((board.events[action.subtaskId] ?? []).map((e) => [e.id, e]));
      for (const e of action.events) byId.set(e.id, e);
      const merged = [...byId.values()].sort((a, b) => a.id - b.id);
      return { ...board, events: { ...board.events, [action.subtaskId]: merged } };
    }
    case 'notice':
      return { ...board, notices: [action.notice, ...board.notices] };
    case 'plan':
      return { ...board, plans: [action.plan, ...board.plans.filter((p) => p.id !== action.plan.id)] };
    case 'usage':
      return { ...board, usage: { ...board.usage, [action.account]: action.usage } };
    case 'job':
      return { ...board, jobs: [action.job, ...board.jobs.filter((j) => j.id !== action.job.id)] };
    case 'approval':
      return { ...board, approvals: [...board.approvals, action.approval] };
    case 'approval-done':
      return { ...board, approvals: board.approvals.filter((a) => a.id !== action.id) };
    case 'conversation':
      return {
        ...board,
        conversations: [action.conversation, ...board.conversations.filter((c) => c.id !== action.conversation.id)],
      };
    case 'conv-event': {
      const list = board.convEvents[action.event.conversationId] ?? [];
      if (list.some((e) => e.id === action.event.id)) return board;
      return { ...board, convEvents: { ...board.convEvents, [action.event.conversationId]: [...list, action.event] } };
    }
    case 'conv-events': {
      const byId = new Map((board.convEvents[action.conversationId] ?? []).map((e) => [e.id, e]));
      for (const e of action.events) byId.set(e.id, e);
      const merged = [...byId.values()].sort((a, b) => a.id - b.id);
      return { ...board, convEvents: { ...board.convEvents, [action.conversationId]: merged } };
    }
    case 'restart':
      return { ...board, restartPending: true, restartWaitingFor: action.waitingFor };
    case 'connected':
      return {
        ...board,
        connected: action.connected,
        generation: action.connected ? board.generation + 1 : board.generation,
      };
    default:
      // A message type this page does not know yet: ignore it rather than lose the board.
      return board;
  }
}

export async function put(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export async function post(path: string, body: unknown = {}): Promise<unknown> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export const avatarUrl = (team: string, role: string) => `/avatars/${team}-${role}.png`;

/** The whole board, kept live over one WebSocket that reconnects on its own. */
export function useBoard() {
  const [board, dispatch] = useReducer(reduce, initial);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let closed = false;

    const load = () =>
      fetch('/api/state')
        .then((r) => r.json())
        .then((state: ServerState) => dispatch({ type: 'state', state }))
        .catch(() => undefined);

    const connect = () => {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${scheme}://${location.host}/api/live`);
      socket.onopen = () => {
        dispatch({ type: 'connected', connected: true });
        void load();
      };
      socket.onmessage = (e) => {
        const message = JSON.parse(String(e.data)) as Action | { type: 'teams' };
        // A project's files changed: the teams come with the whole state.
        if (message.type === 'teams') void load();
        else dispatch(message);
      };
      socket.onclose = () => {
        dispatch({ type: 'connected', connected: false });
        if (!closed) retry = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, []);

  const loadEvents = (subtaskId: number) =>
    fetch(`/api/subtasks/${subtaskId}/events`)
      .then((r) => r.json())
      .then((events: AgentEvent[]) => dispatch({ type: 'events', subtaskId, events }));

  const loadConvEvents = (conversationId: number) =>
    fetch(`/api/conversations/${conversationId}/events`)
      .then((r) => r.json())
      .then((events: ConvEvent[]) => dispatch({ type: 'conv-events', conversationId, events }));

  return { board, loadEvents, loadConvEvents };
}

export type GitHost = 'github' | 'azure' | 'none';

/** What the server read from a repo, and what it suggests. */
export interface Scan {
  path: string;
  exists: boolean;
  isGit: boolean;
  name: string;
  remote: string | null;
  host: GitHost;
  baseBranch: string;
  found: string[];
  signals: string[];
  owns: Record<string, string[]>;
  claudeMd: boolean;
  agentsMd: boolean;
  skills: RepoSkill[];
  mcpJson: string[];
  tools: string[];
  suggested: Suggested;
  /** A folder of several repos: each one. Empty for a single checkout. */
  repos: ScanRepo[];
  /** What the project already has. */
  existing: Existing;
  /** The az profile the project's own Claude settings point at. */
  azureConfigDir: string | null;
}

export interface ScanRepo {
  id: string;
  path: string;
  remote: string | null;
  host: GitHost;
  baseBranch: string;
  signals: string[];
  found: string[];
  duplicateOf: string | null;
}

export interface Suggested {
  roles: { template: string; owns: string[]; repos?: string[] }[];
  skills: string[];
}

export interface ExistingSkill {
  id: string;
  kind: 'skill' | 'command';
  /** The repo it is in; '' for the project's folder. */
  where: string;
  description: string;
  tracked: boolean;
  /** In the settings: whether the project's agents use it. */
  enabled?: boolean;
}

export interface Instruction {
  file: string;
  where: string;
  note: string;
  tracked: boolean;
}

export interface Existing {
  skills: ExistingSkill[];
  instructions: Instruction[];
}

export interface Check {
  id: string;
  label: string;
  required: boolean;
  status: 'ok' | 'fail' | 'warn';
  detail: string;
  fix?: { label: string; kind: 'terminal' | 'run' | 'auth'; id: string };
}

/** A check target: a project that exists, or the one being set up. */
export type CheckFor =
  | { team: string }
  | {
      draft: {
        repo: string;
        repos?: { id: string; path: string; baseBranch: string; host: GitHost }[];
        account: string;
        azureConfigDir?: string | null;
        host: GitHost;
        baseBranch: string;
        servers: string[];
        tools: string[];
      };
    };
