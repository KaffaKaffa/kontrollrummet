import { execFile } from './proc.ts';
import { promisify } from 'node:util';
import { submitTask } from './actions.ts';
import { countMarks, getMark, setMark } from './db.ts';
import { loadTeams, type InfraMonitor, type Team } from './roles.ts';
import { expandHome } from './config.ts';
import { identityEnv } from './accounts.ts';
import { OWNER } from './owner.ts';

const run = promisify(execFile);

/**
 * Production errors, checked on a schedule: Sentry for the apps, Application
 * Insights for the backend. Only what is new since the last check becomes a
 * card, one for the bug agent per round, never one per error. A check costs no
 * tokens; an agent starts only when there is something to look at. The first
 * check of a source only remembers what is there already.
 */

interface Finding {
  source: 'Sentry' | 'App Insights' | 'Cloud Logging';
  key: string;
  title: string;
  detail: string;
  link: string | null;
}

async function sentry(cfg: Extract<InfraMonitor, { type: 'sentry' }>): Promise<Finding[]> {
  const { stdout } = await run(
    'sentry',
    ['issue', 'list', `${cfg.org}/${cfg.project}`, '--period', '24h', '--query', 'is:unresolved', '--json', '--limit', '50'],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as unknown;
  const wrapped = parsed as { data?: unknown[]; issues?: unknown[] };
  const issues = (Array.isArray(parsed) ? parsed : (wrapped.data ?? wrapped.issues ?? [])) as Record<string, any>[];
  return issues.map((i) => ({
    source: 'Sentry',
    key: String(i.id),
    title: String(i.title ?? i.shortId),
    detail: `${i.shortId} · ${i.count} händelser · ${i.userCount ?? 0} användare · senast ${i.lastSeen}`,
    link: i.permalink ? String(i.permalink) : null,
  }));
}

async function appInsights(team: Team, cfg: Extract<InfraMonitor, { type: 'appInsights' }>): Promise<Finding[]> {
  // The project's own az profile, as the agents have it.
  const dir = cfg.azureConfigDir ?? team.azureConfigDir;
  const env = identityEnv({ account: team.account, azureConfigDir: dir ? expandHome(dir) : null });
  const { stdout: token } = await run(
    'az',
    ['account', 'get-access-token', '--subscription', cfg.subscription, '--resource', 'https://api.applicationinsights.io', '--query', 'accessToken', '-o', 'tsv'],
    { env },
  );
  // Exceptions by problem, and server errors by operation: what a person would have run into.
  const query = `union
  (exceptions | where timestamp > ago(24h) | summarize n = count(), lastSeen = max(timestamp), msg = take_any(outerMessage) by key = problemId),
  (requests | where timestamp > ago(24h) and toint(resultCode) >= 500 | summarize n = count(), lastSeen = max(timestamp), msg = take_any(resultCode) by key = strcat(operation_Name, ' → ', resultCode))
| top 50 by n`;
  const url = `https://api.applicationinsights.io/v1/apps/${cfg.appId}/query?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token.trim()}` } });
  const body = (await res.json()) as { tables?: { rows: unknown[][] }[]; error?: { message?: string } };
  if (!res.ok || !body.tables) throw new Error(`App Insights: ${body.error?.message ?? res.status}`);
  return body.tables[0].rows.map(([key, n, lastSeen, msg]) => ({
    source: 'App Insights',
    key: String(key),
    title: String(key),
    detail: `${n} gånger senaste dygnet · senast ${lastSeen}${msg ? ` · ${String(msg).slice(0, 200)}` : ''}`,
    link: null,
  }));
}

/** Errors in Google Cloud Logging (Firebase Functions, Cloud Run), as the project's Google account. */
async function googleLogging(cfg: Extract<InfraMonitor, { type: 'googleLogging' }>): Promise<Finding[]> {
  const account = cfg.account;
  const { stdout } = await run(
    'gcloud',
    ['logging', 'read', 'severity>=ERROR', '--project', cfg.project, '--freshness', '1d', '--limit', '200', '--format', 'json', ...(account ? ['--account', account] : [])],
    { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
  );
  const entries = JSON.parse(stdout || '[]') as Record<string, any>[];
  const by = new Map<string, { n: number; last: string; where: string; msg: string }>();
  for (const e of entries) {
    const where = e.resource?.labels?.function_name ?? e.resource?.labels?.service_name ?? e.resource?.type ?? '?';
    const msg = String(e.textPayload ?? e.jsonPayload?.message ?? e.protoPayload?.status?.message ?? '').split('\n')[0].slice(0, 160);
    // Ids, numbers and quoted values vary between occurrences of the same error.
    const key = `${where}: ${msg.replace(/[0-9a-f]{8,}|\d+|"[^"]*"/gi, '#')}`;
    const seen = by.get(key);
    if (seen) seen.n++;
    else by.set(key, { n: 1, last: String(e.timestamp ?? ''), where, msg });
  }
  return [...by.entries()].map(([key, v]) => ({
    source: 'Cloud Logging' as const,
    key,
    title: `${v.where}: ${v.msg || '(tomt meddelande)'}`,
    detail: `${v.n} gånger senaste dygnet · senast ${v.last}`,
    link: `https://console.cloud.google.com/logs/query;query=severity%3E%3DERROR?project=${cfg.project}`,
  }));
}

/** The list's error sources: [key for the marks, label, read]. The key is the item's, so each keeps its own memory. */
function sourcesOf(team: Team): [string, string, () => Promise<Finding[]>][] {
  return team.infraItems
    .filter((i) => i.monitor && !i.suggested)
    .map((i) => {
      const m = i.monitor!;
      const read =
        m.type === 'sentry' ? () => sentry(m) : m.type === 'appInsights' ? () => appInsights(team, m) : () => googleLogging(m);
      // The keys from before the list, so a source moved into it does not report everything again.
      const key = m.type === 'sentry' ? 'sentry' : m.type === 'appInsights' ? 'appinsights' : 'googlelogging';
      const taken = team.infraItems.filter((x) => x.monitor?.type === m.type).length > 1;
      return [taken ? `${key}:${i.id}` : key, i.title, read] as [string, string, () => Promise<Finding[]>];
    });
}

/** Each source read once, now: whether it answers, and how much it holds. */
export async function testMonitors(team: Team) {
  return Promise.all(
    sourcesOf(team).map(async ([, label, read]) => {
      try {
        const found = await read();
        return { source: label, ok: true, detail: found.length ? `${found.length} olika fel senaste dygnet.` : 'Svarar. Inga fel senaste dygnet.' };
      } catch (err) {
        const e = err as { stderr?: string; message: string };
        return { source: label, ok: false, detail: String(e.stderr || e.message).split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 300) ?? 'okänt fel' };
      }
    }),
  );
}

async function checkTeam(team: Team) {
  const sources = sourcesOf(team).map(([name, , read]) => [name, read] as const);
  if (!sources.length) return;

  const fresh: Finding[] = [];
  for (const [name, read] of sources) {
    const scope = `monitor:${team.id}:${name}`;
    let found: Finding[];
    try {
      found = await read();
    } catch (err) {
      console.warn(`[monitors] ${team.id} ${name}: ${(err as Error).message}`);
      continue;
    }
    const first = countMarks(scope) === 0;
    for (const f of found) {
      if (getMark(scope, f.key) !== undefined) continue;
      setMark(scope, f.key, f.title);
      if (!first) fresh.push(f);
    }
    // An empty first check still counts as checked.
    if (first) setMark(scope, '__baseline__');
  }
  if (!fresh.length) return;

  const bug = team.roles.find((r) => r.kind === 'bug');
  const lines = fresh.map((f) => `- [${f.source}] ${f.title}\n  ${f.detail}${f.link ? `\n  ${f.link}` : ''}`);
  const text = `Nya fel i prod: ${fresh.length} st (${[...new Set(fresh.map((f) => f.source))].join(', ')})

Hittade av kontrollrummets felkoll. Triagera: läs detaljerna (sentry issue view <id> --json, Application Insights, eller gcloud logging read), slå ihop det som hör ihop, skapa kort för det som behöver rättas och säg vilka som är kända eller ofarliga. Det du inte kan avgöra går till ${OWNER} som needs-you.

${lines.join('\n')}`;
  submitTask(team.id, text, bug?.id);
}

export function startMonitors() {
  const round = () => {
    for (const team of loadTeams()) void checkTeam(team).catch((err) => console.warn(`[monitors] ${(err as Error).message}`));
  };
  const minutes = Math.min(...loadTeams().map((t) => t.monitors?.everyMinutes ?? 30), 30);
  setTimeout(round, 30_000);
  setInterval(round, minutes * 60_000);
}
