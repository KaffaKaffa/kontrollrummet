import { MAX_CONCURRENT } from './config.ts';
import { bus } from './bus.ts';
import { addEvent, listSubtasks, updateSubtask } from './db.ts';
import { accountOfCard, isRunning, onQuotaPause, onSlotFreed, runningCount, startAgent, takeWake } from './agent.ts';
import { nextResume, pauseLeft } from './usage.ts';
import { onCardsCreated, onMessageCard } from './mcp.ts';
import { startWatching } from './watch.ts';
import { startMonitors } from './monitors.ts';
import { startHandoff } from './handoff.ts';

/**
 * Starts queued cards whose dependencies are done, up to the concurrency cap.
 * Called after anything that could free a slot or unblock a card.
 */
let resumeTimer: NodeJS.Timeout | undefined;

export function tick() {
  // An account out of quota starts nothing; look again when the first one resets.
  const wait = nextResume();
  clearTimeout(resumeTimer);
  if (wait > 0) resumeTimer = setTimeout(tick, wait + 1000);
  const all = listSubtasks();
  const done = new Set(all.filter((s) => s.status === 'done').map((s) => s.id));
  for (const s of all) {
    if ((s.status !== 'queued' && s.status !== 'quota') || isRunning(s.id)) continue;
    // Each account is its own subscription, with its own cap and quota.
    const account = accountOfCard(s.id);
    if (pauseLeft(account) > 0 || runningCount(account) >= MAX_CONCURRENT) continue;
    if (!s.dependsOn.every((d) => done.has(d))) continue;
    // A queued card with a session has been started before: it continues, it does not start over.
    // A wake-up that waited for its slot is delivered now, as the wake-up it was.
    const wake = takeWake(s.id);
    const start = wake
      ? startAgent(s.id, wake, { wake: true, fresh: true })
      : startAgent(s.id, s.sessionId ? RESUME : undefined, { fresh: true });
    void start.catch((err: Error) => {
      bus.emit({ type: 'event', event: addEvent(s.id, 'error', err.message) });
      bus.emit({ type: 'subtask', subtask: updateSubtask(s.id, { status: 'failed' }) });
    });
  }
}

const RESUME =
  '[Kontrollrummet] Kortet startas igen: servern startades om medan du arbetade, kvoten tog slut och har återställts, eller så köades kortet om. Fortsätt där du var. Kontrollera läget i din worktree först (teamleader och bug: läs boarden med list_board), gör inte om det som redan är klart, och avsluta med report.';

/**
 * Cards that were running when the server stopped are queued again and pick up
 * where they were: the session resumes with --resume and the worktree still
 * holds their changes. They go through the queue, so the cap still holds.
 */
export function recover() {
  for (const s of listSubtasks()) {
    if (s.status !== 'running') continue;
    updateSubtask(s.id, { status: 'queued' });
    addEvent(s.id, 'status', 'Servern startades om mitt i arbetet. Kortet fortsätter där det var när det får plats i kön.');
  }
}

export function startScheduler() {
  recover();
  onSlotFreed(tick);
  onQuotaPause(tick);
  onCardsCreated(tick);
  onMessageCard((id, text) => startAgent(id, text));
  startWatching(tick);
  startMonitors();
  startHandoff();
  bus.on((m) => {
    if (m.type === 'subtask' && m.subtask.status !== 'running') tick();
  });
  tick();
}
