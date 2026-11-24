import { providerFor, type OwnPr, type PrFeedback } from './git.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { bus } from './bus.ts';
import { OWNER } from './owner.ts';
import {
  addEvent,
  addNotice,
  closeNotice,
  listNotices,
  createSubtask,
  createTask,
  getSubtask,
  listSubtasks,
  listPlans,
  listTasks,
  updatePlan,
  updateSubtask,
  type Notice,
  type PrReview,
  type Subtask,
  type SubtaskStatus,
} from './db.ts';
import { isRunning, startAgent } from './agent.ts';
import { getTeam, loadTeams, nameIn, peopleNames, repoFor, whoIn, type Team } from './roles.ts';


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
      return `- Kort #${s.id} (${whoIn(s.team, s.agent)}) ${STATUS_TEXT[s.status]}${s.prUrl ? `: ${s.prUrl}` : ''}.${said}`;
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
  const { state, mergeable, review } = await host.prState(s.prUrl, repo.path, { account: team.account, azureConfigDir: team.azureConfigDir });
  if (state === 'OPEN') noteReview(s, team, review);
  if (state === 'OPEN' && mergeable === 'CONFLICTING') {
    if (!conflicted.has(s.id)) {
      // Once per conflict: the agent that owns the PR brings main in and pushes, then it is mergeable again.
      conflicted.add(s.id);
      bus.emit({ type: 'event', event: addEvent(s.id, 'status', `PR #${s.prNumber} har merge-konflikter mot ${repo.baseBranch}. ${nameIn(s.team, s.agent)} löser dem.`) });
      void startAgent(
        s.id,
        `[Kontrollrummet] PR #${s.prNumber} har merge-konflikter mot ${repo.baseBranch}. Hämta origin/${repo.baseBranch}, merga in den i din branch, lös konflikterna så att båda ändringarna finns kvar, kör testerna och pusha. Rapportera pr-open igen när PR:en går att merga. Ligger konflikten i en annan agents område och kräver deras kunskap, delegera den med delegate i stället för att gissa. Är en konflikt ett beslut snarare än en sammanfogning: rapportera needs-you med valet som question och alternativen som options.`,
        { wake: true },
      ).catch(() => conflicted.delete(s.id));
    }
    return 'CONFLICTING';
  }
  if (mergeable === 'MERGEABLE') conflicted.delete(s.id);
  // A "approved, ready to merge" notice has done its job once the PR is merged or closed.
  if (state === 'MERGED' || state === 'CLOSED') closeNoticesWhere((urls) => urls.length === 1 && urls[0] === s.prUrl);
  if (state === 'MERGED') {
    bus.emit({ type: 'subtask', subtask: updateSubtask(s.id, { status: 'done' }) });
    bus.emit({ type: 'event', event: addEvent(s.id, 'status', `PR #${s.prNumber} är mergad. Kortet är klart.`) });
  } else if (state === 'CLOSED') {
    bus.emit({ type: 'subtask', subtask: updateSubtask(s.id, { status: 'failed' }) });
    bus.emit({ type: 'event', event: addEvent(s.id, 'status', `PR #${s.prNumber} stängdes utan merge.`) });
  }
  return state;
}

/** PR links in a notice's text, GitHub or Azure DevOps. */
const noticeUrls = (text: string) => text.match(/https:\/\/[^\s)]+\/(?:pull|pullrequest)\/\d+/g) ?? [];

/** Closes the open notices whose PR links satisfy `gone`, and tells the UI. */
function closeNoticesWhere(gone: (urls: string[], n: Notice) => boolean) {
  for (const n of listNotices()) {
    if (n.closedAt) continue;
    const urls = noticeUrls(n.text);
    if (!urls.length || !gone(urls, n)) continue;
    const closed = closeNotice(n.id);
    if (closed) bus.emit({ type: 'notice', notice: closed });
  }
}

/** "Kim" for kim.svensson when the project lists them; the account otherwise. */
function personFor(team: Team, account: string): string {
  const a = account.toLowerCase();
  return team.people.find((p) => p.account?.toLowerCase() === a || p.name.toLowerCase() === a)?.name ?? account.replace(/@.*/, '');
}

const names = (list: string[]) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} och ${list.at(-1)}`);

/**
 * Keeps the card's view of its PR's reviewers. A PR waiting for someone else's
 * approval is nothing for the owner to merge yet and nothing for the agent to
 * do; once it is approved the owner hears it is ready, once.
 */
function noteReview(s: Subtask, team: Team, raw: PrReview) {
  const review: PrReview = { state: raw.state, who: raw.who.map((w) => personFor(team, w)) };
  const before = s.review;
  if (before && before.state === review.state && before.who.join() === review.who.join()) return;
  bus.emit({ type: 'subtask', subtask: updateSubtask(s.id, { review }) });
  // Several cards can share a PR (the author's and a tester's): the first tells.
  const first = !listSubtasks().some((o) => o.id < s.id && o.status === 'pr-open' && o.prUrl === s.prUrl);
  if (!first) return;
  const pr = `PR #${s.prNumber}`;
  if (review.state === 'waiting') {
    bus.emit({ type: 'event', event: addEvent(s.id, 'status', `${pr} väntar på godkännande${review.who.length ? ` från ${names(review.who)}` : ''}.`) });
  } else if (review.state === 'approved' && before?.state && before.state !== 'approved' && before.state !== 'none') {
    bus.emit({ type: 'event', event: addEvent(s.id, 'status', `${pr} är godkänd${review.who.length ? ` av ${names(review.who)}` : ''}. Redo att merga.`) });
    const notice = addNotice(team.id, s.id, `${pr} är godkänd${review.who.length ? ` av ${names(review.who)}` : ''} och kan mergas: ${s.prUrl}`);
    bus.emit({ type: 'notice', notice });
  } else if (review.state === 'changes') {
    bus.emit({ type: 'event', event: addEvent(s.id, 'status', `${names(review.who) || 'En granskare'} vill ha ändringar i ${pr}. ${nameIn(s.team, s.agent)} får kommentarerna.`) });
  }
}

async function checkPrs() {
  for (const s of listSubtasks()) {
    if (s.status !== 'pr-open' || !s.prUrl || isRunning(s.id)) continue;
    // gh offline or rate limited: try again next round.
    await settlePr(s).catch(() => undefined);
  }
  await checkFeedback().catch(() => undefined);
  closeIdleWatchers();
}

// ---------------------------------------------------------------- reviews on our PRs

const FEEDBACK_FILE = join(DATA_DIR, 'pr-feedback.json');
/** Older than this the first time a PR is looked at: from before the watch, already seen to. */
const BACKFILL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Per PR: the feedback already handed to its agent, and when the agent was
 * last woken for it, so its own replies (as the same account) are not new feedback.
 */
interface FeedbackState {
  seen: string[];
  wokeAt?: string;
}

function feedbackState(): Record<string, FeedbackState> {
  try {
    return existsSync(FEEDBACK_FILE) ? (JSON.parse(readFileSync(FEEDBACK_FILE, 'utf8')) as Record<string, FeedbackState>) : {};
  } catch {
    return {};
  }
}

function feedbackLine(f: PrFeedback): string {
  const head = [f.author, f.state && f.state !== 'COMMENTED' ? f.state : '', f.where, f.reply ? 'svar i tråd' : ''].filter(Boolean).join(', ');
  const body = f.body.trim().length > 1500 ? `${f.body.trim().slice(0, 1500)} …` : f.body.trim();
  return `- ${head}:\n  ${body.replaceAll('\n', '\n  ')}`;
}

/**
 * Reviews and comments on the cards' open PRs, from people or bots such as
 * Copilot: what is new goes to the agent that owns the PR, as one wake-up per
 * PR, to fix what is right, answer what is not and push.
 */
async function checkFeedback() {
  const state = feedbackState();
  const open = listSubtasks().filter((s) => s.status === 'pr-open' && s.prUrl);
  const byPr = new Map<string, Subtask[]>();
  for (const s of open) byPr.set(s.prUrl!, [...(byPr.get(s.prUrl!) ?? []), s]);
  const next: Record<string, FeedbackState> = {};
  for (const [url, cards] of byPr) {
    next[url] = state[url] ?? { seen: [] };
    // Someone is at work on the PR: their replies are not done yet, look next round.
    if (cards.some((c) => isRunning(c.id))) continue;
    const owner = cards.reduce((a, b) => (b.id < a.id ? b : a));
    const team = getTeam(owner.team);
    if (!team) continue;
    const repo = repoFor(team, team.roles.find((r) => r.id === owner.agent), owner);
    const host = await providerFor(repo.path);
    if (!host) continue;
    const account = { account: team.account, azureConfigDir: team.azureConfigDir };
    let all: PrFeedback[];
    try {
      all = await host.prFeedback(url, repo.path, account);
    } catch {
      continue;
    }
    const me = (await host.whoami(account))?.toLowerCase() ?? '';
    const before = state[url];
    const seen = new Set(before?.seen ?? []);
    const fresh = all.filter((f) => {
      if (seen.has(f.id)) return false;
      // An approval without words asks for nothing.
      if (!f.body.trim()) return false;
      if (f.author.toLowerCase() === me) {
        // The agents write as the same account: first look, and after a wake-up, that is them.
        if (!before) return false;
        if (before.wokeAt && f.at >= before.wokeAt) return false;
      }
      if (!before && Date.now() - Date.parse(f.at) > BACKFILL_MS) return false;
      return true;
    });
    next[url] = { seen: all.map((f) => f.id), wokeAt: before?.wokeAt };
    if (!fresh.length) continue;
    next[url].wokeAt = new Date().toISOString();
    const who = [...new Set(fresh.map((f) => f.author))].join(', ');
    bus.emit({
      type: 'event',
      event: addEvent(owner.id, 'status', `${who} har granskat PR #${owner.prNumber}: ${fresh.length === 1 ? 'en ny kommentar' : `${fresh.length} nya kommentarer`}. ${nameIn(owner.team, owner.agent)} går igenom dem.`),
    });
    void startAgent(
      owner.id,
      [
        `[Kontrollrummet] Ny granskning på din PR #${owner.prNumber} (${url}):`,
        '',
        ...fresh.map(feedbackLine),
        '',
        `Gå igenom varje punkt i din worktree. Åtgärda det som stämmer, kör testerna och pusha. Stämmer något inte, eller är det redan löst, svara kort i tråden varför (gh pr comment, eller svar på kommentaren med gh api; az devops invoke på Azure DevOps). Granskning från bottar som Copilot kan ha fel: bedöm själv. Är en punkt ett beslut som är ${OWNER}s, rapportera needs-you med frågan och alternativen. Annars avsluta med report pr-open och en kort sammanfattning av vad du ändrade.`,
      ].join('\n'),
      { wake: true },
    ).catch((err: Error) => {
      bus.emit({ type: 'event', event: addEvent(owner.id, 'error', `Kunde inte väcka för granskningen: ${err.message}`) });
    });
  }
  writeFileSync(FEEDBACK_FILE, JSON.stringify(next));
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
    // Every PR still waiting for the owner in this team; only trusted when every repo answered.
    const pending = new Set<string>();
    let complete = true;
    for (const repo of team.repos) {
      const host = await providerFor(repo.path);
      if (!host) continue;
      const key = `${host.id}:${repo.path}`;
      if (key in next) continue;
      try {
        // A card's own PR is on the board already, under Att merga.
        const cards = new Set(
          listSubtasks()
            .filter((s) => s.team === team.id && s.prUrl && s.status !== 'done' && s.status !== 'failed')
            .map((s) => s.prNumber),
        );
        const prs = (await host.reviewRequests(repo.path, { account: team.account, azureConfigDir: team.azureConfigDir }, team.reviewer)).filter(
          (p) => !cards.has(p.number),
        );
        next[key] = prs.map((p) => p.url);
        for (const p of prs) pending.add(p.url);
        for (const p of prs) {
          if (state[key]?.includes(p.url) || seen.has(p.url)) continue;
          seen.add(p.url);
          fresh.push(`- ${repo.id} #${p.number} ${p.title} (${p.author}): ${p.url}`);
        }
      } catch {
        // Offline or signed out: keep what was told, try again next round.
        next[key] = state[key] ?? [];
        complete = false;
      }
    }
    // A review notice goes when none of its PRs wait any more: merged, abandoned or voted on.
    // (Card PRs are left out of `pending` on purpose; their review notices are not sent either.)
    if (complete) closeNoticesWhere((urls, n) => n.team === team.id && /väntar på din granskning/.test(n.text) && urls.every((u) => !pending.has(u)));
    if (!fresh.length) continue;
    const notice = addNotice(team.id, null, [fresh.length === 1 ? 'En PR väntar på din granskning:' : `${fresh.length} PR:er väntar på din granskning:`, ...fresh].join('\n'));
    bus.emit({ type: 'notice', notice });
  }
  writeFileSync(REVIEW_FILE, JSON.stringify(next));
}

// ---------------------------------------------------------------- the owner's own PRs

/** Per team: the owner's open PRs that no card holds, with who they wait for. */
const own = new Map<string, (OwnPr & { repo: string })[]>();
export const ownPrs = () => Object.fromEntries(own);

/**
 * PRs the owner opened by hand (or a pipeline in their name) belong under Att
 * merga too. Left out: cards' PRs, and those waiting for the owner's own vote,
 * which come as a review notice.
 */
async function checkOwnPrs() {
  const asked = new Set(Object.values(reviewState()).flat());
  for (const team of loadTeams()) {
    const cards = new Set(listSubtasks().filter((s) => s.team === team.id && s.prUrl).map((s) => s.prNumber));
    const list: (OwnPr & { repo: string })[] = [];
    let failed = false;
    for (const repo of team.repos) {
      const host = await providerFor(repo.path);
      if (!host) continue;
      try {
        for (const p of await host.ownPrs(repo.path, { account: team.account, azureConfigDir: team.azureConfigDir })) {
          if (cards.has(p.number) || asked.has(p.url)) continue;
          list.push({ ...p, repo: repo.id, review: { state: p.review.state, who: p.review.who.map((w) => personFor(team, w)) } });
        }
      } catch {
        failed = true;
      }
    }
    // Offline or signed out: keep what was shown.
    if (failed && !list.length) continue;
    const before = JSON.stringify(own.get(team.id) ?? []);
    own.set(team.id, list);
    if (JSON.stringify(list) !== before) bus.emit({ type: 'own-prs', team: team.id, prs: list });
  }
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
      return `- #${s.id} ${whoIn(s.team, s.agent)} [${s.status}] ${age} min sedan senaste ändring${stale}: ${s.brief.split('\n')[0].slice(0, 100)}`;
    });
    void startAgent(
      card.id,
      [
        '[Kontrollrummet] Standup. Det här är aktivt:',
        ...lines,
        '',
        `Kontrollera öppna PR:er (gh pr view på GitHub; az repos pr show på Azure DevOps) (${peopleNames(team, OWNER)} mergar mellan varven). Nya granskningar och kommentarer på korts PR:er skickar kontrollrummet själv till kortets agent; följ bara upp sådana som blivit liggande, och det som står still. Säg till med notify_user bara om något kräver ${OWNER}, samlat i en notis. Avsluta med report status watching.`,
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
  setInterval(() => void checkOwnPrs(), 3 * 60 * 1000);
  void checkPrs();
  void checkReviewRequests().then(checkOwnPrs);
}
