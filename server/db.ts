import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH } from './config.ts';

export type SubtaskStatus =
  | 'queued'
  | 'running'
  /** A lead or bug card that handed out work and waits for it, without holding a slot. */
  | 'watching'
  /** Cut off by the subscription's limit; resumes on its own after the reset. */
  | 'quota'
  | 'needs-you'
  | 'pr-open'
  | 'testing'
  | 'done'
  | 'failed';

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
  /** The card that created this one and hears how it goes. */
  parentId: number | null;
  /** The last thing the agent reported, or a note from the team leader. */
  note: string | null;
  branch: string | null;
  worktree: string | null;
  /** The team repo the card works in, by id; null: its agent's first. */
  repo: string | null;
  sessionId: string | null;
  prNumber: number | null;
  prUrl: string | null;
  summary: string | null;
  /** What the agent asks the owner when it stops on needs-you: a question, choices, what it would need to go on alone. */
  ask: Ask | null;
  /** Where the card's open PR stands with its reviewers, from the PR round. */
  review: PrReview | null;
  costUsd: number;
  /** Tokens the agent read on its latest call: how big the conversation has grown. */
  contextTokens: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * waiting: someone is asked to review (or a review is required) and has not;
 * changes: a reviewer wants changes; approved: approved; none: nobody asked.
 */
export interface PrReview {
  state: 'waiting' | 'changes' | 'approved' | 'none';
  /** Who it waits for, wants changes or approved: people's names where the project knows them. */
  who: string[];
}

export interface Ask {
  question: string;
  /** Short choices the owner can pick with one click. */
  options?: string[];
  /** For a test the agent could not run: what it would need to run it itself. */
  unblock?: string;
  /** Something is logged out: what, and how to log in again from the card. */
  login?: Login;
  /** The message the agent never got because it stopped first: sent again with "Fortsätt". */
  retry?: string;
}

/**
 * A login that ran out. fix is a check's fix (checks.ts: login-claude,
 * login-host:github, azure-profile, mcp-<server>) that opens Terminal; url is a
 * page to log in on in the browser, for what has no command.
 */
export interface Login {
  what: string;
  fix?: string;
  url?: string;
}

export type EventKind = 'user' | 'text' | 'tool' | 'tool-result' | 'status' | 'error' | 'system' | 'image';

export interface Notice {
  id: number;
  team: string;
  subtaskId: number | null;
  text: string;
  at: string;
  /** The owner has dealt with it ("Klart") or put it away ("Stäng"): out of the inbox. */
  closedAt: string | null;
}

export type PlanStatus = 'draft' | 'ready' | 'parked' | 'implementing' | 'done' | 'discarded';

export interface Plan {
  id: number;
  team: string;
  /** The architect's card that wrote it; messages to that card revise the plan. */
  subtaskId: number;
  title: string;
  body: string;
  status: PlanStatus;
  /** The task the plan became when the owner chose to implement it. */
  taskId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentEvent {
  id: number;
  subtaskId: number;
  kind: EventKind;
  body: string;
  at: string;
}

mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    team TEXT NOT NULL,
    title TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
  );
  CREATE TABLE IF NOT EXISTS subtasks (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    team TEXT NOT NULL,
    agent TEXT NOT NULL,
    brief TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    depends_on TEXT NOT NULL DEFAULT '[]',
    branch TEXT,
    worktree TEXT,
    session_id TEXT,
    pr_number INTEGER,
    pr_url TEXT,
    summary TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    subtask_id INTEGER NOT NULL REFERENCES subtasks(id),
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
  );
  CREATE INDEX IF NOT EXISTS events_by_subtask ON events(subtask_id, id);
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY,
    team TEXT NOT NULL,
    subtask_id INTEGER NOT NULL UNIQUE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    task_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
  );
  CREATE TABLE IF NOT EXISTS marks (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    PRIMARY KEY (scope, key)
  );
  CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY,
    team TEXT NOT NULL,
    subtask_id INTEGER,
    text TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
  );
`);

/** Columns added after the first version; old databases get them on start. */
for (const [table, column, type] of [
  ['subtasks', 'parent_id', 'INTEGER'],
  ['subtasks', 'note', 'TEXT'],
  ['subtasks', 'ask', 'TEXT'],
  ['subtasks', 'context_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['subtasks', 'repo', 'TEXT'],
  ['subtasks', 'review', 'TEXT'],
  ['notices', 'closed_at', 'TEXT'],
] as const) {
  const has = (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

type Row = Record<string, unknown>;

const toTask = (r: Row): Task => ({
  id: Number(r.id),
  team: String(r.team),
  title: String(r.title),
  text: String(r.text),
  createdAt: String(r.created_at),
});

const toSubtask = (r: Row): Subtask => ({
  id: Number(r.id),
  taskId: Number(r.task_id),
  team: String(r.team),
  agent: String(r.agent),
  brief: String(r.brief),
  status: r.status as SubtaskStatus,
  dependsOn: JSON.parse(String(r.depends_on)) as number[],
  parentId: r.parent_id == null ? null : Number(r.parent_id),
  note: (r.note as string | null) ?? null,
  branch: (r.branch as string | null) ?? null,
  worktree: (r.worktree as string | null) ?? null,
  repo: (r.repo as string | null) ?? null,
  sessionId: (r.session_id as string | null) ?? null,
  prNumber: r.pr_number == null ? null : Number(r.pr_number),
  prUrl: (r.pr_url as string | null) ?? null,
  summary: (r.summary as string | null) ?? null,
  ask: r.ask ? (JSON.parse(String(r.ask)) as Ask) : null,
  review: r.review ? (JSON.parse(String(r.review)) as PrReview) : null,
  costUsd: Number(r.cost_usd),
  contextTokens: Number(r.context_tokens ?? 0),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const toEvent = (r: Row): AgentEvent => ({
  id: Number(r.id),
  subtaskId: Number(r.subtask_id),
  kind: r.kind as EventKind,
  body: String(r.body),
  at: String(r.at),
});

export function createTask(team: string, title: string, text: string): Task {
  const r = db
    .prepare('INSERT INTO tasks (team, title, text) VALUES (?, ?, ?) RETURNING *')
    .get(team, title, text) as Row;
  return toTask(r);
}

/** A better title once more is known: the ticket's own, with its number. */
export function setTaskTitle(id: number, title: string): Task {
  const r = db.prepare('UPDATE tasks SET title = ? WHERE id = ? RETURNING *').get(title, id) as Row | undefined;
  if (!r) throw new Error('uppgiften finns inte');
  return toTask(r);
}

export function getTask(id: number): Task | undefined {
  const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
  return r && toTask(r);
}

export function listTasks(): Task[] {
  return (db.prepare('SELECT * FROM tasks ORDER BY id DESC').all() as Row[]).map(toTask);
}

export function createSubtask(
  task: Pick<Task, 'id' | 'team'>,
  agent: string,
  brief: string,
  { dependsOn = [], parentId = null, repo = null }: { dependsOn?: number[]; parentId?: number | null; repo?: string | null } = {},
): Subtask {
  const r = db
    .prepare(
      'INSERT INTO subtasks (task_id, team, agent, brief, depends_on, parent_id, repo) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *',
    )
    .get(task.id, task.team, agent, brief, JSON.stringify(dependsOn), parentId, repo) as Row;
  return toSubtask(r);
}

export function getSubtask(id: number): Subtask | undefined {
  const r = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(id) as Row | undefined;
  return r && toSubtask(r);
}

export function listSubtasks(): Subtask[] {
  return (db.prepare('SELECT * FROM subtasks ORDER BY id').all() as Row[]).map(toSubtask);
}

const COLUMNS = {
  status: 'status',
  branch: 'branch',
  worktree: 'worktree',
  sessionId: 'session_id',
  prNumber: 'pr_number',
  prUrl: 'pr_url',
  summary: 'summary',
  costUsd: 'cost_usd',
  contextTokens: 'context_tokens',
  note: 'note',
  agent: 'agent',
  dependsOn: 'depends_on',
  ask: 'ask',
  review: 'review',
} as const;

export type SubtaskPatch = Partial<Pick<Subtask, keyof typeof COLUMNS>>;

export function updateSubtask(id: number, patch: SubtaskPatch): Subtask {
  const keys = Object.keys(patch) as (keyof typeof COLUMNS)[];
  if (keys.length > 0) {
    const sets = keys.map((k) => `${COLUMNS[k]} = ?`).join(', ');
    const values = keys.map((k) =>
      k === 'dependsOn' ? JSON.stringify(patch[k] ?? []) : k === 'ask' || k === 'review' ? (patch[k] ? JSON.stringify(patch[k]) : null) : (patch[k] ?? null),
    );
    db.prepare(
      `UPDATE subtasks SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id = ?`,
    ).run(...values, id);
  }
  const s = getSubtask(id);
  if (!s) throw new Error(`subtask ${id} not found`);
  return s;
}

export function addEvent(subtaskId: number, kind: EventKind, body: string): AgentEvent {
  const r = db
    .prepare('INSERT INTO events (subtask_id, kind, body) VALUES (?, ?, ?) RETURNING *')
    .get(subtaskId, kind, body) as Row;
  return toEvent(r);
}

export function listEvents(subtaskId: number, afterId = 0): AgentEvent[] {
  return (
    db.prepare('SELECT * FROM events WHERE subtask_id = ? AND id > ? ORDER BY id').all(subtaskId, afterId) as Row[]
  ).map(toEvent);
}

const toNotice = (r: Row): Notice => ({
  id: Number(r.id),
  team: String(r.team),
  subtaskId: r.subtask_id == null ? null : Number(r.subtask_id),
  text: String(r.text),
  at: String(r.at),
  closedAt: (r.closed_at as string | null) ?? null,
});

export function closeNotice(id: number): Notice | undefined {
  const r = db.prepare("UPDATE notices SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id = ? RETURNING *").get(id) as Row | undefined;
  return r && toNotice(r);
}

export function addNotice(team: string, subtaskId: number | null, text: string): Notice {
  return toNotice(
    db.prepare('INSERT INTO notices (team, subtask_id, text) VALUES (?, ?, ?) RETURNING *').get(team, subtaskId, text) as Row,
  );
}

export function listNotices(limit = 50): Notice[] {
  // Open ones whatever their age, and the latest few closed (the watches look at what was told).
  return (db.prepare('SELECT * FROM notices WHERE closed_at IS NULL OR id > (SELECT MAX(id) FROM notices) - ? ORDER BY id DESC').all(limit) as Row[]).map(toNotice);
}

const toPlan = (r: Row): Plan => ({
  id: Number(r.id),
  team: String(r.team),
  subtaskId: Number(r.subtask_id),
  title: String(r.title),
  body: String(r.body),
  status: r.status as PlanStatus,
  taskId: r.task_id == null ? null : Number(r.task_id),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

/** One plan per architect card; saving again is a revision of the same plan. */
export function savePlan(team: string, subtaskId: number, title: string, body: string): Plan {
  return toPlan(
    db
      .prepare(
        `INSERT INTO plans (team, subtask_id, title, body) VALUES (?, ?, ?, ?)
         ON CONFLICT(subtask_id) DO UPDATE SET title = excluded.title, body = excluded.body,
           status = CASE WHEN plans.status IN ('parked', 'discarded', 'done') THEN 'ready' ELSE plans.status END,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ')
         RETURNING *`,
      )
      .get(team, subtaskId, title, body) as Row,
  );
}

export function getPlan(id: number): Plan | undefined {
  const r = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as Row | undefined;
  return r && toPlan(r);
}

export function listPlans(): Plan[] {
  return (db.prepare('SELECT * FROM plans ORDER BY updated_at DESC').all() as Row[]).map(toPlan);
}

export function updatePlan(id: number, patch: { status?: PlanStatus; taskId?: number | null }): Plan {
  if (patch.status) db.prepare("UPDATE plans SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id = ?").run(patch.status, id);
  if (patch.taskId !== undefined) db.prepare('UPDATE plans SET task_id = ? WHERE id = ?').run(patch.taskId, id);
  const p = getPlan(id);
  if (!p) throw new Error(`plan ${id} finns inte`);
  return p;
}

// ---------------------------------------------------------------- marks

/** Small remembered facts: an error already reported, an issue handed over and to which card. */
export function getMark(scope: string, key: string): string | null | undefined {
  const r = db.prepare('SELECT value FROM marks WHERE scope = ? AND key = ?').get(scope, key) as Row | undefined;
  return r ? ((r.value as string | null) ?? null) : undefined;
}

export function setMark(scope: string, key: string, value: string | null = null) {
  db.prepare('INSERT INTO marks (scope, key, value) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value').run(scope, key, value);
}

export function listMarks(scope: string): { key: string; value: string | null }[] {
  return (db.prepare('SELECT key, value FROM marks WHERE scope = ?').all(scope) as Row[]).map((r) => ({ key: String(r.key), value: (r.value as string | null) ?? null }));
}

export function countMarks(scope: string): number {
  return Number((db.prepare('SELECT count(*) AS n FROM marks WHERE scope = ?').get(scope) as Row).n);
}

// ---------------------------------------------------------------- Gudfadern

/**
 * Gudfadern's conversations: Claude with no team, card or role, in a folder
 * the owner picks, on an account they pick. Its own tables, so the board never
 * sees them.
 */
export type ConversationStatus = 'idle' | 'running' | 'quota' | 'error';

export interface Conversation {
  id: number;
  title: string;
  /** Where Claude runs: the folder the owner picked, or the worktree made for it. */
  cwd: string;
  /** The checkout the worktree was cut from, when the conversation has one. */
  repo: string | null;
  branch: string | null;
  account: string;
  model: string;
  effort: string;
  /** 'all': the account's own MCP servers and connectors. 'none': only the control room's. */
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
  kind: EventKind;
  body: string;
  at: string;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    cwd TEXT NOT NULL,
    repo TEXT,
    branch TEXT,
    account TEXT NOT NULL,
    model TEXT NOT NULL,
    effort TEXT NOT NULL DEFAULT '',
    mcp TEXT NOT NULL DEFAULT 'none',
    status TEXT NOT NULL DEFAULT 'idle',
    session_id TEXT,
    context_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
  );
  CREATE TABLE IF NOT EXISTS conv_events (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
  );
  CREATE INDEX IF NOT EXISTS conv_events_by_conversation ON conv_events(conversation_id, id);
`);

const toConversation = (r: Row): Conversation => ({
  id: Number(r.id),
  title: String(r.title),
  cwd: String(r.cwd),
  repo: (r.repo as string | null) ?? null,
  branch: (r.branch as string | null) ?? null,
  account: String(r.account),
  model: String(r.model),
  effort: String(r.effort ?? ''),
  mcp: r.mcp === 'all' ? 'all' : 'none',
  status: r.status as ConversationStatus,
  sessionId: (r.session_id as string | null) ?? null,
  contextTokens: Number(r.context_tokens ?? 0),
  costUsd: Number(r.cost_usd ?? 0),
  archived: Number(r.archived) === 1,
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const CONV_COLUMNS = {
  title: 'title',
  cwd: 'cwd',
  repo: 'repo',
  branch: 'branch',
  account: 'account',
  model: 'model',
  effort: 'effort',
  mcp: 'mcp',
  status: 'status',
  sessionId: 'session_id',
  contextTokens: 'context_tokens',
  costUsd: 'cost_usd',
  archived: 'archived',
} as const;

export type ConversationPatch = Partial<Pick<Conversation, keyof typeof CONV_COLUMNS>>;

export function createConversation(c: Pick<Conversation, 'title' | 'cwd' | 'account' | 'model' | 'effort' | 'mcp'> & Partial<Pick<Conversation, 'repo' | 'branch'>>): Conversation {
  const r = db
    .prepare('INSERT INTO conversations (title, cwd, repo, branch, account, model, effort, mcp) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *')
    .get(c.title, c.cwd, c.repo ?? null, c.branch ?? null, c.account, c.model, c.effort, c.mcp) as Row;
  return toConversation(r);
}

export function getConversation(id: number): Conversation | undefined {
  const r = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Row | undefined;
  return r && toConversation(r);
}

export function listConversations(): Conversation[] {
  return (db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all() as Row[]).map(toConversation);
}

export function updateConversation(id: number, patch: ConversationPatch): Conversation {
  const keys = Object.keys(patch) as (keyof typeof CONV_COLUMNS)[];
  if (keys.length > 0) {
    const sets = keys.map((k) => `${CONV_COLUMNS[k]} = ?`).join(', ');
    const values = keys.map((k) => (k === 'archived' ? (patch.archived ? 1 : 0) : (patch[k] ?? null)));
    db.prepare(`UPDATE conversations SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id = ?`).run(...values, id);
  }
  const c = getConversation(id);
  if (!c) throw new Error(`samtal ${id} finns inte`);
  return c;
}

const toConvEvent = (r: Row): ConvEvent => ({
  id: Number(r.id),
  conversationId: Number(r.conversation_id),
  kind: r.kind as EventKind,
  body: String(r.body),
  at: String(r.at),
});

export function addConvEvent(conversationId: number, kind: EventKind, body: string): ConvEvent {
  return toConvEvent(
    db.prepare('INSERT INTO conv_events (conversation_id, kind, body) VALUES (?, ?, ?) RETURNING *').get(conversationId, kind, body) as Row,
  );
}

export function listConvEvents(conversationId: number, afterId = 0): ConvEvent[] {
  return (
    db.prepare('SELECT * FROM conv_events WHERE conversation_id = ? AND id > ? ORDER BY id').all(conversationId, afterId) as Row[]
  ).map(toConvEvent);
}
