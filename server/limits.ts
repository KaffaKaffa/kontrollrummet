import { MAX_CONCURRENT } from './config.ts';
import { getMark, setMark } from './db.ts';

/**
 * How many agents may work at once. Two levels, both must have room:
 * - per Claude account (the subscription's limits are shared): a number, or
 *   none. Without a saved choice the default holds: CONTROL_ROOM_MAX_AGENTS, or 2.
 * - per project: a number, or none (the default). Kept in the project's own
 *   settings (roles.ts, team.local.json).
 * The account's choice is global, so it lives in the database, not under teams/.
 * Read on every check, so a change holds at once without a restart.
 */
const SCOPE = 'agent-cap';
const NONE = 'none';

/** A saved cap as a whole number of at least 1, or null for no limit. */
export function cleanCap(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || v === NONE) return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 99) : null;
}

/** The account's cap: a number, or null for no limit. */
export function accountCap(account: string): number | null {
  const saved = getMark(SCOPE, account);
  if (saved === undefined || saved === null) return cleanCap(MAX_CONCURRENT) ?? null;
  return cleanCap(saved);
}

/** What the account has without a saved choice. */
export const defaultAccountCap = (): number | null => cleanCap(MAX_CONCURRENT);

/** null: no limit. */
export function setAccountCap(account: string, cap: number | null) {
  setMark(SCOPE, account, cap === null ? NONE : String(cap));
}

/** Whether a count has room under a cap (null: always). */
export const hasRoomUnder = (count: number, cap: number | null) => cap === null || count < cap;
