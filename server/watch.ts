import { providerFor } from './git.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { bus } from './bus.ts';
import { OWNER } from './owner.ts';
import {
  addEvent,
  addNotice,
  createSubtask,
  createTask,
  getSubtask,
  listSubtasks,
  listPlans,
  listTasks,
  updatePlan,
  updateSubtask,
  type Subtask,
  type SubtaskStatus,
} from './db.ts';
import { isRunning, startAgent } from './agent.ts';
import { getTeam, loadTeams, peopleNames, repoFor } from './roles.ts';


/** Statuses a parent wants to hear about. Starting and running are noise. */
const WORTH_TELLING: SubtaskStatus[] = ['done', 'failed', 'needs-you', 'pr-open'];

const STATUS_TEXT: Record<SubtaskStatus, string> = {
  queued: 'i kö',
  quota: 'väntar på kvoten',
  running: 'arbetar',
  watching: 'bevakar',
  'needs-you': 'behöver ett beslut',
  'pr-open': 'har öppnat en PR',
  testing: 'testas',
  done: 'är klart',
  failed: 'gick inte',
};

const lastStatus = new Map<number, SubtaskStatus>();
/** Per parent: what happened to its cards since it was last told, sent as one message. */
const pending = new Map<number, Set<number>>();
const timers = new Map<number, NodeJS.Timeout>();

/** Grouped by cause, never one message per event: wait a moment for siblings to land. */
const DEBOUNCE_MS = 8000;

/**
 * Waking a parent costs a whole turn with its whole conversation. It hears at
 * once when a card needs a decision or failed; otherwise only when all of its
 * cards have settled (done or with an open PR), as one message about all of them.
 */
function parentShouldHear(child: Subtask): boolean {
  if (child.parentId == null) return false;
  // A question for the owner is theirs, in the Inbox; waking the parent to relay it only costs a turn.
  if (child.status === 'needs-you') return false;
  if (child.status === 'failed') return true;
  const siblings = listSubtasks().filter((s) => s.parentId === child.parentId);
  const settled = (s: Subtask) => s.status === 'done' || s.status === 'pr-open';
  if (!siblings.every(settled)) return false;
  // All settled: tell about every sibling that has not been told about yet.
  for (const s of siblings) if (s.id !== child.id) queueForParent(s);
  return true;
}

function queueForParent(child: Subtask) {
  if (child.parentId == null) return;
  const set = pending.get(child.parentId) ?? new Set();
  set.add(child.id);
  pending.set(child.parentId, set);
}

function tellParent(child: Subtask) {
  if (child.parentId == null) return;
  const parent = getSubtask(child.parentId);
  if (!parent || parent.status === 'done' || parent.status === 'failed') return;
  const set = pending.get(parent.id) ?? new Set();
  set.add(child.id);
  pending.set(parent.id, set);
  clearTimeout(timers.get(parent.id));
  timers.set(
    parent.id,
    setTimeout(() => flush(parent.id), DEBOUNCE_MS),
  );
}

function flush(parentId: number) {
  timers.delete(parentId);
  const ids = [...(pending.get(parentId) ?? [])];
  pending.delete(parentId);
  const lines = ids
    .map((id) => getSubtask(id))
    .filter((s): s is Subtask => Boolean(s))
    .map((s) => {
      const said = s.summary ? `\n  Sa: ${s.summary.slice(0, 600).replaceAll('\n', '\n  ')}` : '';
      return `- Kort #${s.id} (${s.agent}) ${STATUS_TEXT[s.status]}${s.prUrl ? `: ${s.prUrl}` : ''}.${said}`;
    });
  if (!lines.length) return;
  const message = [
    '[Kontrollrummet] Läget på dina kort:',
    ...lines,
    '',
    `Följ upp: svara på frågor du kan svara på själv (reply_to_card), skapa det som saknas, och hör av dig till ${OWNER} bara om något kräver ${OWNER}. Avsluta med report.`,
  ].join('\n');
  void startAgent(parentId, message, { wake: true }).catch((err: Error) => {
    bus.emit({ type: 'event', event: addEvent(parentId, 'error', `Kunde inte väcka: ${err.message}`) });
  });
}

// ---------------------------------------------------------------- PRs

/** A card with an open PR is done when the PR is merged; that is what unblocks the next card. */
/** Cards whose PR conflicts and whose agent was told once; cleared when the host says it merges again. */
const conflicted = new Set<number>();

/**
 * Asks GitHub or Azure DevOps where one card's PR is, and settles the card: merged is done,
 * closed failed, and a conflict sends the owning agent to resolve it.
 */
async function settlePr(s: Subtask): Promise<string> {
  const team = getTeam(s.team);
  if (!team || !s.prUrl) throw new Error('kortet har ingen PR');
  // The repo the card worked in, on GitHub or Azure DevOps, as the team's account.
  const repo = repoFor(team, team.roles.find((r) => r.id === s.agent), s);
  const host = await providerFor(repo.path);
  if (!host) throw new Error('repot har ingen GitHub- eller Azure DevOps-remote');
  const { state, mergeable } = await host.prState(s.prUrl, repo.path, { account: team.account, azureConfigDir: team.azureConfigDir });
  if (state === 'OPEN' && mergeable === 'CONFLICTING') {
    if (!conflicted.has(s.id)) {
      // Once per conflict: the agent that owns the PR brings main in and pushes, then it is mergeable again.
      conflicted.add(s.id);
      bus.emit({ type: 'event', event: addEvent(s.id, 'status', `PR #${s.prNumber} har merge-konflikter mot ${repo.baseBranch}. Agenten löser dem.`) });
      void startAgent(
        s.id,
        `[Kontrollrummet] PR #${s.prNumber} har merge-konflikter mot ${repo.baseBranch}. Hämta origin/${repo.baseBranch}, merga in den i din branch, lös konflikterna så att båda ändringarna finns kvar, kör testerna och pusha. Rapportera pr-open igen när PR:en går att merga. Ligger konflikten i en annan agents område och kräver deras kunskap, delegera den med delegate i stället för att gissa. Är en konflikt ett beslut snarare än en sammanfogning: rapportera needs-you med valet som question och alternativen som options.`,
        { wake: true },
      ).catch(() => conflicted.delete(s.id));
    }
    return 'CONFLICTING';
  }
  if (mergeable === 'MERGEABLE') conflicted.delete(s.id);
  if (state === 'MERGED') {
    bus.emit({ type: 'subtask', subtask: updateSubtask(s.id, { status: 'done' }) });
    bus.emit({ type: 'event', event: addEvent(s.id, 'status', `PR #${s.prNumber} är mergad. Kortet är klart.`) });
  } else if (state === 'CLOSED') {
    bus.emit({ type: 'subtask', subtask: updateSubtask(s.id, { status: 'failed' }) });
    bus.emit({ type: 'event', event: addEvent(s.id, 'status', `PR #${s.prNumber} stängdes utan merge.`) });
  }
  return state;
}

async function checkPrs() {
  for (const s of listSubtasks()) {
    if (s.status !== 'pr-open' || !s.prUrl || isRunning(s.id)) continue;
    // gh offline or rate limited: try again next round.
    await settlePr(s).catch(() => undefined);
  }
  closeIdleWatchers();
}

/**
 * A watcher whose cards are all finished has nothing left to wait for. Waking
 * it to say so would cost a turn; it is closed here, deepest first, so a
 * teamleader above a finished bug card closes in the same round. The team's
 * standing board card never closes.
 */
function closeIdleWatchers() {
  const boards = new Set(listTasks().filter((t) => t.title === BOARD_TITLE).map((t) => t.id));
  let changed = true;
  while (changed) {
    changed = false;
    const all = listSubtasks();
    for (const s of all) {
      if (s.status !== 'watching' || boards.has(s.taskId) || isRunning(s.id)) continue;
      const kids = all.filter((c) => c.parentId === s.id);
      if (!kids.length || !kids.every((c) => c.status === 'done' || c.status === 'failed')) continue;
      bus.emit({ type: 'subtask', subtask: updateSubtask(s.id, { status: 'done' }) });
      bus.emit({ type: 'event', event: addEvent(s.id, 'status', 'Allt under kortet är klart. Kortet stängdes.') });
      changed = true;
    }
  }
}

/**
 * The owner says they merged: ask GitHub now instead of at the next round, for
 * every open card on the same PR. The answer is GitHub's, not the click's.
 */
export async function checkPrNow(id: number): Promise<{ state: string; prNumber: number | null }> {
  const card = getSubtask(id);
  if (!card?.prUrl) throw new Error('kortet har ingen PR');
  const same = listSubtasks().filter((s) => s.team === card.team && s.status === 'pr-open' && s.prUrl === card.prUrl);
  let state = 'OPEN';
  for (const s of same.length ? same : [card]) if (!isRunning(s.id)) state = await settlePr(s);
  return { state, prNumber: card.prNumber };
}

// ---------------------------------------------------------------- reviews

const REVIEW_FILE = join(DATA_DIR, 'review-requests.json');

/** Per repo: the PR links the owner has already been told wait for their review. */
function reviewState(): Record<string, string[]> {
  try {
    return existsSync(REVIEW_FILE) ? (JSON.parse(readFileSync(REVIEW_FILE, 'utf8')) as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

/**
 * PRs in the teams' repos, on GitHub or Azure DevOps, that wait for the owner's
 * approval: one notice per team with what is new since the last round. A PR
 * is told once while it waits; asked again after he has voted, it is new.
 */
async function checkReviewRequests() {
  const state = reviewState();
  const next: Record<string, string[]> = {};
  const seen = new Set<string>();
  for (const team of loadTeams()) {
    const fresh: string[] = [];
    for (const repo of team.repos) {
      const host = await providerFor(repo.path);
      if (!host) continue;
      const key = `${host.id}:${repo.path}`;
      if (key in next) continue;
      try {
        const prs = await host.reviewRequests(repo.path, { account: team.account, azureConfigDir: team.azureConfigDir }, team.reviewer);
        next[key] = prs.map((p) => p.url);
        for (const p of prs) {
          if (state[key]?.includes(p.url) || seen.has(p.url)) continue;
          seen.add(p.url);
          fresh.push(`- ${repo.id} #${p.number} ${p.title} (${p.author}): ${p.url}`);
        }
      } catch {
        // Offline or signed out: keep what was told, try again next round.
        next[key] = state[key] ?? [];
      }
    }
    if (!fresh.length) continue;
    const notice = addNotice(team.id, null, [fresh.length === 1 ? 'En PR väntar på din granskning:' : `${fresh.length} PR:er väntar på din granskning:`, ...fresh].join('\n'));
    bus.emit({ type: 'notice', notice });
  }
  writeFileSync(REVIEW_FILE, JSON.stringify(next));
}

// ---------------------------------------------------------------- standup

const BOARD_TITLE = 'Boarden';

/** Each team's lead has one standing card for keeping the board in order. */
function boardCard(teamId: string, leadRole: string): Subtask {
  const task = listTasks().find((t) => t.team === teamId && t.title === BOARD_TITLE);
  const existing = task && listSubtasks().find((s) => s.taskId === task.id && s.agent === leadRole);
  if (existing) return existing;
  const t =
    task ??
    createTask(teamId, BOARD_TITLE, 'Teamleaderns stående kort: håll ordning på boarden, följ upp det som står still och PR:er som väntar.');
  bus.emit({ type: 'task', task: t });
  const s = createSubtask(t, leadRole, t.text);
  // It is woken by the standup, not by the queue.
  const watching = updateSubtask(s.id, { status: 'watching' });
  bus.emit({ type: 'subtask', subtask: watching });
  return watching;
}

const STALE_MS = 2 * 60 * 60 * 1000;
/** Even an unchanged board gets a look this often, for review comments on waiting PRs. */
const QUIET_MAX_MS = 6 * 60 * 60 * 1000;
const lastStandup = new Map<string, { signature: string; at: number }>();

function standup() {
  for (const team of loadTeams()) {
    const lead = team.roles.find((r) => r.kind === 'lead');
    if (!lead) continue;
    const active = listSubtasks().filter(
      (s) => s.team === team.id && !['done', 'failed', 'watching'].includes(s.status) && s.agent !== lead.id,
    );
    if (!active.length) continue;
    const now = Date.now();
    // Only when something moved, something newly stalled, or it has been a while:
    // a PR waiting days for review must not wake an Opus lead every half hour.
    const signature = active
      .map((s) => `${s.id}:${s.status}:${now - Date.parse(s.updatedAt) > STALE_MS ? 's' : ''}`)
      .sort()
      .join(',');
    const last = lastStandup.get(team.id);
    // Standup is for what has stalled. Moving cards wake their own parents;
    // without a stall the lead looks at most every six hours.
    const stalled = active.some((s) => now - Date.parse(s.updatedAt) > STALE_MS && s.status !== 'pr-open');
    if (last && (last.signature === signature || !stalled) && now - last.at < QUIET_MAX_MS) continue;
    if (!last && !stalled) {
      lastStandup.set(team.id, { signature, at: now });
      continue;
    }
    const card = boardCard(team.id, lead.id);
    if (isRunning(card.id)) continue;
    lastStandup.set(team.id, { signature, at: now });
    const lines = active.map((s) => {
      const age = Math.round((now - Date.parse(s.updatedAt)) / 60000);
      const stale = now - Date.parse(s.updatedAt) > STALE_MS ? ' (står still)' : '';
      return `- #${s.id} ${s.agent} [${s.status}] ${age} min sedan senaste ändring${stale}: ${s.brief.split('\n')[0].slice(0, 100)}`;
    });
    void startAgent(
      card.id,
      [
        '[Kontrollrummet] Standup. Det här är aktivt:',
        ...lines,
        '',
        `Kontrollera öppna PR:er (gh pr view på GitHub; az repos pr show och trådarna med az devops invoke --area git --resource pullRequestThreads på Azure DevOps) (${peopleNames(team, OWNER)} mergar mellan varven), skapa kort för review-kommentarer som inte är åtgärdade, och följ upp det som står still. Säg till med notify_user bara om något kräver ${OWNER}, samlat i en notis. Avsluta med report status watching.`,
      ].join('\n'),
      { wake: true },
    ).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- Figma sync

const SYNC_FILE = join(DATA_DIR, 'figma-sync.json');
const SYNC_TITLE = 'Figma-synk';

/** Per team: the newest merge already looked at. First run starts from now, no backfill. */
function syncState(): Record<string, string> {
  try {
    return existsSync(SYNC_FILE) ? (JSON.parse(readFileSync(SYNC_FILE, 'utf8')) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * The code is the source and Figma follows. Any PR merged to the base branch,
 * from a card or from the owner, that touches the team's figmaSync
 * paths gives the designer a card to bring Figma up to date.
 */
async function checkFigmaSync() {
  const state = syncState();
  for (const team of loadTeams()) {
    const designer = team.roles.find((r) => r.kind === 'designer');
    if (!designer || !team.figmaSync.length) continue;
    const since = state[team.id];
    if (!since) {
      state[team.id] = new Date().toISOString();
      continue;
    }
    try {
      // figmaSync paths are in the team's first repo.
      const main = team.repos[0];
      const host = await providerFor(main.path);
      if (!host) continue;
      const merged = (await host.mergedPrs(main.path, main.baseBranch, { account: team.account, azureConfigDir: team.azureConfigDir })).filter((pr) => Date.parse(pr.mergedAt) > Date.parse(since));
      if (!merged.length) continue;
      state[team.id] = merged.at(-1)!.mergedAt;
      const relevant = merged
        .map((pr) => ({ pr, files: pr.files.filter((f) => team.figmaSync.some((p) => f.startsWith(p))) }))
        .filter((x) => x.files.length);
      if (!relevant.length) continue;

      const task =
        listTasks().find((t) => t.team === team.id && t.title === SYNC_TITLE) ??
        (() => {
          const t = createTask(team.id, SYNC_TITLE, 'Stående uppgift: håll Figma-biblioteket i takt med koden.');
          bus.emit({ type: 'task', task: t });
          return t;
        })();
      const brief = [
        'Synka Figma med koden. De här PR:erna är mergade och rör design-tokens, ikoner eller UI-komponenter:',
        '',
        ...relevant.map(({ pr, files }) => `- #${pr.number} ${pr.title} (${pr.url})\n  ${files.slice(0, 12).join(', ')}${files.length > 12 ? ' …' : ''}`),
        '',
        'Läs ändringarna, jämför med Figma-biblioteket och uppdatera Figma: variabler, ikoner och komponenter. Koden är källan; ändra aldrig koden. Rapportera vad du ändrade, med länkar till noderna.',
      ].join('\n');
      const card = createSubtask(task, designer.id, brief);
      bus.emit({ type: 'subtask', subtask: card });
      bus.emit({ type: 'event', event: addEvent(card.id, 'system', 'Skapat av synkvakten.') });
      onSyncCard();
    } catch {
      // gh offline: try again next round.
    }
  }
  writeFileSync(SYNC_FILE, JSON.stringify(state));
}

let onSyncCard = () => {};

export function startWatching(onCardCreated: () => void = () => {}) {
  onSyncCard = onCardCreated;
  setInterval(() => void checkFigmaSync(), 10 * 60 * 1000);
  void checkFigmaSync();
  for (const s of listSubtasks()) lastStatus.set(s.id, s.status);
  bus.on((m) => {
    if (m.type !== 'subtask') return;
    const s = m.subtask;
    const before = lastStatus.get(s.id);
    lastStatus.set(s.id, s.status);
    if (before !== s.status && WORTH_TELLING.includes(s.status) && parentShouldHear(s)) tellParent(s);
    // A plan is carried out when the lead it was handed to says its task is done.
    if (before !== 'done' && s.status === 'done' && s.parentId == null) {
      const plan = listPlans().find((p) => p.taskId === s.taskId && p.status === 'implementing');
      if (plan) bus.emit({ type: 'plan', plan: updatePlan(plan.id, { status: 'done' }) });
    }
  });
  setInterval(() => void checkPrs(), 3 * 60 * 1000);
  setInterval(standup, 30 * 60 * 1000);
  setInterval(() => void checkReviewRequests(), 10 * 60 * 1000);
  void checkPrs();
  void checkReviewRequests();
}
