import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';

export interface UsageWindow {
  /** 0–1 of the subscription's limit in this window. */
  utilization: number;
  /** When the window resets, ISO. */
  resetsAt: string | null;
  status: string;
}

export interface Usage {
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  /** When an agent last reported it. The figure only moves when an agent runs. */
  seenAt: string;
}

/** Each account is its own subscription, with its own windows. */
const FILE = join(DATA_DIR, 'usage.json');

const current: Record<string, Usage> = (() => {
  try {
    const data = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, unknown>) : {};
    // The file from before accounts held one Usage; it is dropped, the next agent reads it again.
    return 'seenAt' in data ? {} : (data as Record<string, Usage>);
  } catch {
    return {};
  }
})();

export const getUsage = () => current;

const toWindow = (w: Record<string, unknown> | undefined): UsageWindow | null =>
  w && typeof w.utilization === 'number'
    ? {
        utilization: w.utilization,
        resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : null,
        status: String(w.status ?? ''),
      }
    : null;

/**
 * Claude Code's stream carries a rate_limit_event on every turn, with the
 * subscription's five-hour and seven-day windows. That is the usage figure.
 */
export function readRateLimitEvent(account: string, msg: Record<string, any>): Usage | null {
  const windows = msg.rate_limit_info?.unifiedWindows;
  if (!windows) return null;
  const before = current[account];
  current[account] = {
    fiveHour: toWindow(windows.five_hour) ?? before?.fiveHour ?? null,
    weekly: toWindow(windows.seven_day) ?? before?.weekly ?? null,
    seenAt: new Date().toISOString(),
  };
  try {
    writeFileSync(FILE, JSON.stringify(current));
  } catch {
    // Only a convenience across restarts.
  }
  return current[account];
}

/**
 * When an account's limit is hit, nothing new starts on it until it resets:
 * cards that were cut off are queued again and resume on their own then.
 * Other accounts go on.
 */
const pausedUntil = new Map<string, number>();

export function pauseUntil(account: string, at: number) {
  pausedUntil.set(account, Math.max(pausedUntil.get(account) ?? 0, at));
}

/** Milliseconds left of the account's pause, or 0. */
export function pauseLeft(account: string): number {
  return Math.max(0, (pausedUntil.get(account) ?? 0) - Date.now());
}

/** Paused accounts and when they resume, ISO. */
export function pausedUntilIso(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [account, at] of pausedUntil) if (at > Date.now()) out[account] = new Date(at).toISOString();
  return out;
}

/** The soonest a paused account resumes, ms from now, or 0 when none is paused. */
export function nextResume(): number {
  const left = [...pausedUntil.keys()].map(pauseLeft).filter((n) => n > 0);
  return left.length ? Math.min(...left) : 0;
}
