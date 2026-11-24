/**
 * Which cards and PRs a notice talks about, read from its text ("#108",
 * "kort #109", "PR #397", a PR link), and whether they have moved on since. The
 * server closes a notice when everything it names is settled; the Inbox strikes
 * out each line that is. Pure: imported by the server and the web app alike.
 */

export interface RefCard {
  id: number;
  status: string;
  prNumber: number | null;
  prUrl: string | null;
  updatedAt: string;
}

export interface Ref {
  kind: 'card' | 'pr';
  n: number;
}

const settledStatus = (s: string) => s === 'done' || s === 'failed';

/** "#108" and "kort #109" are cards; "PR #397", "PR 397" and …/pull/397 are PRs. */
export function refsIn(text: string): Ref[] {
  const refs: Ref[] = [];
  const seen = new Set<string>();
  const add = (kind: Ref['kind'], n: number) => {
    const key = `${kind}${n}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ kind, n });
    }
  };
  for (const m of text.matchAll(/\bPR\s?#?(\d+)|\/(?:pull|pullrequest)\/(\d+)/gi)) add('pr', Number(m[1] ?? m[2]));
  // A # not right after "PR" (or "PR "), and not part of a link or a word.
  for (const m of text.matchAll(/(?<![\w/]|PR\s?|PR)#(\d+)\b/gi)) add('card', Number(m[1]));
  return refs;
}

/**
 * Settled: the card is done or failed, or every card holding the PR is, and it
 * happened after the notice was written. A card that was already done when the
 * notice spoke of it ("#126 är klart, lös testfelet i Sentry") does not close it.
 * Unknown: a number that is no card or PR the project knows.
 */
export function refState(ref: Ref, cards: RefCard[], since: string): 'settled' | 'open' | 'unknown' {
  // For a PR, the cards that hold it as theirs (pr-open, done, failed); a lead that only mentions it does not count.
  const matching = ref.kind === 'card' ? cards.filter((c) => c.id === ref.n) : cards.filter((c) => c.prNumber === ref.n && (c.status === 'pr-open' || settledStatus(c.status)));
  if (!matching.length) return 'unknown';
  if (!matching.every((c) => settledStatus(c.status))) return 'open';
  return matching.some((c) => c.updatedAt > since) ? 'settled' : 'open';
}

/**
 * A line is done when what it is about is settled. A line that names cards is
 * about them, and a PR beside them is context ("#123 (testning av PR #400) kan
 * inte testa iOS" is done when #123 is, whatever PR #400 does). A line with only
 * PRs is about the PRs.
 */
export function lineSettled(line: string, cards: RefCard[], since: string): boolean {
  const known = refsIn(line)
    .map((r) => ({ kind: r.kind, state: refState(r, cards, since) }))
    .filter((r) => r.state !== 'unknown');
  const about = known.some((r) => r.kind === 'card') ? known.filter((r) => r.kind === 'card') : known;
  return about.length > 0 && about.every((r) => r.state === 'settled');
}

/**
 * The whole notice is done when every line that names a card or PR is. Lines
 * that name nothing ("Tre saker väntar på dig:") do not count; a notice that
 * names nothing is never closed this way.
 */
export function noticeSettled(text: string, cards: RefCard[], since: string): boolean {
  const named = text.split('\n').filter((l) => refsIn(l).some((r) => refState(r, cards, since) !== 'unknown'));
  return named.length > 0 && named.every((l) => lineSettled(l, cards, since));
}
