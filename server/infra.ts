import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { execFile, spawn } from './proc.ts';
import { identityEnv, identityTerminal } from './accounts.ts';
import { openTerminal } from './terminal.ts';
import { readSecret } from './secrets.ts';
import { CLAUDE_BIN, TEAMS_DIR, expandHome } from './config.ts';
import { claudeEnv } from './claude-run.ts';
import { cleanDevApps, getTeam } from './roles.ts';
import { saveTeamSettings } from './project.ts';
import { bus } from './bus.ts';
import type { InfraConfig, InfraItem, InfraMonitor, MonitorConfig, Team } from './roles.ts';

const run = promisify(execFile);

/**
 * Where a project runs, as a list (Inställningar → Infrastruktur): Firebase,
 * App Insights, Cloudflare, a database, whatever it is. An agent fills it from
 * the repo, the project's memory and the signed-in CLIs, or from what the
 * owner writes in a prompt; the owner edits it; agents suggest what they find
 * missing. Every agent is told each item, with its variables set. A tool's
 * default account or project never decides where a command lands.
 */

// ---------------------------------------------------------------- what an item may do

/** Variables an item may not set: they would change how every tool, or the agent itself, runs. */
const ENV_DENY = /^(PATH|HOME|USERPROFILE|SHELL|NODE_OPTIONS|NODE_PATH|PYTHONPATH|LD_\w*|DYLD_\w*|CLAUDE_\w*|ANTHROPIC_\w*|CONTROL_ROOM_\w*|MCP_\w*|GH_CONFIG_DIR|AZURE_CONFIG_DIR)$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
/** The CLIs a login or check may start. */
const CLIS = new Set(['az', 'firebase', 'gcloud', 'gsutil', 'eas', 'wrangler', 'sentry', 'sentry-cli', 'gh', 'aws', 'doctl', 'vercel', 'netlify', 'supabase', 'flyctl', 'heroku', 'stripe', 'psql', 'sqlcmd']);
/** A check runs on its own, without the owner: only commands that read. */
const READS = /(^|\s)(list|show|whoami|describe|status|verify|get-access-token|login:list|projects:list|apps:list|account|accounts|info|me|ping|version|--version)(\s|$)/;
const WRITES = /(^|\s)(delete|remove|rm|create|deploy|publish|set|update|add|purge|destroy|reset|logout|login(?!:list)|import|apply|run|exec|ssh|push|upload)(\s|$|:)/;

const cleanEnv = (env: unknown): Record<string, string> | undefined => {
  if (!env || typeof env !== 'object') return undefined;
  const out = Object.fromEntries(
    Object.entries(env as Record<string, unknown>)
      .filter(([k, v]) => ENV_NAME.test(k) && !ENV_DENY.test(k) && typeof v === 'string' && v.length < 2000)
      .map(([k, v]) => [k, String(v)]),
  );
  return Object.keys(out).length ? out : undefined;
};
/** AZURE_CONFIG_DIR is allowed for a login or a check: it points az at the item's own profile. */
const cleanStepEnv = (env: unknown): Record<string, string> | undefined => {
  if (!env || typeof env !== 'object') return undefined;
  const e = env as Record<string, unknown>;
  const out = { ...cleanEnv(env), ...(typeof e.AZURE_CONFIG_DIR === 'string' ? { AZURE_CONFIG_DIR: e.AZURE_CONFIG_DIR } : {}) };
  return Object.keys(out).length ? out : undefined;
};
const cleanCommand = (c: unknown): string[] | null =>
  Array.isArray(c) && c.length > 0 && c.length < 30 && c.every((x) => typeof x === 'string' && x.length < 500) && CLIS.has(String(c[0])) ? (c as string[]) : null;
const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'post';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,29}$/;

function cleanMonitor(m: unknown): InfraMonitor | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const r = m as Record<string, unknown>;
  const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string).trim() : '');
  if (r.type === 'sentry' && s('org') && s('project')) return { type: 'sentry', org: s('org'), project: s('project') };
  if (r.type === 'appInsights' && GUID.test(s('appId')) && GUID.test(s('subscription')))
    return { type: 'appInsights', appId: s('appId'), subscription: s('subscription'), ...(s('azureConfigDir') ? { azureConfigDir: s('azureConfigDir') } : {}) };
  if (r.type === 'googleLogging' && PROJECT_ID.test(s('project'))) return { type: 'googleLogging', project: s('project'), ...(s('account') ? { account: s('account') } : {}) };
  return undefined;
}

/** An item as it may be saved: what an agent or the page sends is checked here, never trusted. */
export function cleanItem(raw: unknown, taken = new Set<string>()): InfraItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === 'string' ? r.title.trim().slice(0, 120) : '';
  if (!title) return null;
  let id = slug(typeof r.id === 'string' && r.id ? r.id : title);
  for (let n = 2; taken.has(id); n++) id = `${slug(typeof r.id === 'string' && r.id ? r.id : title)}-${n}`;
  taken.add(id);
  const facts = Object.fromEntries(
    Object.entries((r.facts && typeof r.facts === 'object' ? r.facts : {}) as Record<string, unknown>)
      .filter(([k, v]) => k.trim() && (typeof v === 'string' || typeof v === 'number'))
      .slice(0, 30)
      .map(([k, v]) => [k.trim().slice(0, 60), String(v).trim().slice(0, 500)]),
  );
  const l = (r.login && typeof r.login === 'object' ? r.login : null) as Record<string, unknown> | null;
  const steps = Array.isArray(l?.steps) ? (l!.steps as unknown[]).map(cleanCommand).filter((x): x is string[] => x !== null) : [];
  const url = typeof l?.url === 'string' && /^https:\/\//.test(l.url) ? l.url : undefined;
  const secret = typeof l?.secret === 'string' && /^[\w.-]{3,80}$/.test(l.secret) ? l.secret : undefined;
  const login = steps.length || url || secret ? { ...(cleanStepEnv(l?.env) ? { env: cleanStepEnv(l?.env) } : {}), ...(steps.length ? { steps } : {}), ...(url ? { url } : {}), ...(secret ? { secret } : {}) } : undefined;
  const c = (r.check && typeof r.check === 'object' ? r.check : null) as Record<string, unknown> | null;
  const command = cleanCommand(c?.command);
  const reads = command && READS.test(command.slice(1).join(' ')) && !WRITES.test(command.slice(1).join(' '));
  const check = command && reads ? { ...(cleanStepEnv(c?.env) ? { env: cleanStepEnv(c?.env) } : {}), command } : undefined;
  const env = cleanEnv(r.env);
  const monitor = cleanMonitor(r.monitor);
  return {
    id,
    title,
    kind: typeof r.kind === 'string' && r.kind.trim() ? slug(r.kind) : 'annat',
    facts,
    ...(typeof r.notes === 'string' && r.notes.trim() ? { notes: r.notes.trim().slice(0, 2000) } : {}),
    ...(env ? { env } : {}),
    ...(login ? { login } : {}),
    ...(check ? { check } : {}),
    ...(monitor ? { monitor } : {}),
    ...(typeof r.source === 'string' && r.source.trim() ? { source: r.source.trim().slice(0, 300) } : {}),
    ...(r.suggested === true ? { suggested: true } : {}),
  };
}

export function cleanItems(raw: unknown): InfraItem[] {
  const taken = new Set<string>();
  return (Array.isArray(raw) ? raw : []).map((x) => cleanItem(x, taken)).filter((x): x is InfraItem => x !== null).slice(0, 60);
}

const live = (team: Team) => team.infraItems.filter((i) => !i.suggested);
const expand = (v: string) => (v.startsWith('~') ? expandHome(v.replace(/^~(?=[\\/]|$)/, '~/').replace('~//', '~/')) : v);
const resolveEnv = (env: Record<string, string> | undefined) =>
  Object.fromEntries(
    Object.entries(env ?? {})
      .map(([k, v]) => [k, v.startsWith('secret:') ? readSecret(v.slice(7)) : expand(v)] as const)
      .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''),
  );

// ---------------------------------------------------------------- what agents get

/** Every item's variables, secrets read from the keychain. */
export function infraEnv(team: Team): Record<string, string> {
  return Object.assign({}, ...live(team).map((i) => resolveEnv(i.env)));
}

/** The agent's prompt: each item, and what to do when something is missing. */
export function infraSection(team: Team): string {
  const lines = live(team).map((i) => {
    const facts = Object.entries(i.facts).map(([k, v]) => `${k}: ${v}`).join(', ');
    const env = Object.keys(i.env ?? {});
    return `- **${i.title}**${facts ? ` (${facts})` : ''}.${i.notes ? ` ${i.notes}` : ''}${env.length ? ` Satt för dig: ${env.join(', ')}.` : ''}${i.login ? ` Utloggad: report needs-you med login { what: "${i.title}", fix: "infra:${i.id}" }.` : ''}`;
  });
  const azure = team.azureConfigDir ? `- az kör i projektets egen profil ${team.azureConfigDir} (AZURE_CONFIG_DIR är satt): Azure DevOps.` : '';
  return `## Infrastruktur

${[azure, ...lines].filter(Boolean).join('\n') || 'Inget registrerat än.'}

Saknar du uppgifter om var något körs eller loggar (en molnresurs, ett konto, en databas, Sentry, App Insights, gcloud-projekt), eller är något här fel: föreslå det med suggest_infra i stället för att gissa. ${'{{owner}}'} godkänner, och nästa kort får det.`;
}

// ---------------------------------------------------------------- status and login

export interface ItemStatus {
  ok: boolean;
  detail: string;
}

/** Each item's check, run now: whether its login works. Items without a check are left out. */
export async function infraStatus(team: Team): Promise<Record<string, ItemStatus>> {
  const base = identityEnv({ account: team.account, azureConfigDir: team.azureConfigDir });
  const entries = await Promise.all(
    live(team)
      .filter((i) => i.check)
      .map(async (i) => {
        const env = { ...base, ...infraEnv(team), ...resolveEnv(i.check!.env), CI: '1' };
        try {
          const { stdout } = await run(i.check!.command[0], i.check!.command.slice(1), { env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
          // A short answer (who is logged in) is worth showing; JSON or a table is not.
          const out = stdout.trim();
          const line = out.split('\n')[0]?.trim() ?? '';
          const short = out && !/^[[{]/.test(out) && !out.includes('\n') && line.length <= 80;
          return [i.id, { ok: true, detail: short ? `Inloggad: ${line}` : 'Inloggad.' }] as const;
        } catch (err) {
          return [i.id, { ok: false, detail: firstLine(err) }] as const;
        }
      }),
  );
  return Object.fromEntries(entries);
}

/** The item's login in a Terminal window that says first which project and account it is for. */
export function infraLogin(team: Team, itemId: string): string {
  const item = live(team).find((i) => i.id === itemId);
  if (!item?.login) throw new Error('posten har ingen inloggning');
  const who = identityTerminal({ account: team.account, azureConfigDir: team.azureConfigDir }, `logga in ${item.title} för ${team.name}`);
  openTerminal({
    ...who,
    env: { ...who.env, ...resolveEnv(item.login.env) },
    cwd: existsSync(team.repo) ? team.repo : undefined,
    ...(item.login.url ? { url: item.login.url } : {}),
    ...(item.login.secret ? { secret: { service: item.login.secret, prompt: `Klistra in token för ${item.title}:` } } : {}),
    steps: item.login.steps ?? [],
  });
  return item.login.secret ? `Klistra in token i Terminal (sparas som ${item.login.secret}) och tryck Kolla igen.` : 'Logga in i Terminal-fönstret och tryck sedan Kolla igen.';
}

/** An agent's suggestion: saved for the owner to approve, never told to agents before that. */
export function suggestInfra(team: Team, raw: unknown, from: string): InfraItem {
  const item = cleanItem({ ...(raw as object), suggested: true, source: from }, new Set(team.infraItems.map((i) => i.id)));
  if (!item) throw new Error('förslaget behöver minst en titel');
  saveTeamSettings(team.id, { infraItems: [...team.infraItems, item] });
  bus.emit({ type: 'teams' });
  return item;
}

const firstLine = (err: unknown) =>
  String((err as { stderr?: string }).stderr || (err as Error).message)
    .split('\n')
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .find(Boolean)
    ?.slice(0, 300) ?? 'okänt fel';


// ---------------------------------------------------------------- identify

export interface Identified {
  infra: InfraConfig;
  monitors: MonitorConfig;
  /** What was found where, one line each, for the owner to see why. */
  found: string[];
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.expo', '.next', '.turbo', 'Pods', 'bin', 'obj', 'android', 'ios']);

/** Files by name, a few levels down: config sits at the root or in a package. */
function findFiles(root: string, names: (n: string) => boolean, depth = 3): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && d < depth && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), d + 1);
      else if (e.isFile() && names(e.name)) out.push(join(dir, e.name));
    }
  };
  walk(root, 0);
  return out;
}

/** JSON with comments and trailing commas (wrangler.jsonc, tsconfig-style). */
function readLooseJson(file: string): Record<string, any> | null {
  try {
    const text = readFileSync(file, 'utf8')
      .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, str) => str ?? '')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return null;
  }
}

const rel = (root: string, file: string) => file.slice(root.length + 1) || basename(file);

/**
 * What the repos say about where the project runs: .firebaserc, wrangler,
 * eas.json and app.json, sentry.properties, Application Insights settings.
 * Then which signed-in account reaches the Firebase projects.
 */
export async function identifyInfra(team: Team): Promise<Identified> {
  const infra: InfraConfig = {};
  const monitors: MonitorConfig = {};
  const found: string[] = [];
  const projects = new Set<string>();
  let functions = false;

  for (const repo of team.repos) {
    const root = repo.path;
    const tag = (file: string) => (team.repos.length > 1 ? `${repo.id}/${rel(root, file)}` : rel(root, file));

    for (const f of findFiles(root, (n) => n === '.firebaserc')) {
      const rc = readLooseJson(f);
      const ids = Object.values((rc?.projects ?? {}) as Record<string, string>).filter((x) => typeof x === 'string');
      ids.forEach((x) => projects.add(x));
      if (ids.length) found.push(`Firebase-projekt ${ids.join(', ')} (${tag(f)})`);
    }
    for (const f of findFiles(root, (n) => n === 'firebase.json')) {
      const fb = readLooseJson(f);
      const parts = ['hosting', 'functions', 'firestore', 'storage', 'database', 'emulators'].filter((k) => fb?.[k]);
      if (fb?.functions) functions = true;
      if (parts.length) found.push(`Firebase: ${parts.join(', ')} (${tag(f)})`);
    }
    // A Firebase project named only in code or config (a web app's config, a worker's vars).
    for (const f of findFiles(root, (n) => /^(wrangler\.(jsonc?|toml)|\.env(\..+)?\.example|app\.json)$/.test(n))) {
      const m = /FIREBASE_PROJECT_ID["'\s:=]+["']?([a-z0-9-]{6,30})/i.exec(readFileSync(f, 'utf8'));
      if (m && !projects.has(m[1])) {
        projects.add(m[1]);
        found.push(`Firebase-projekt ${m[1]} (${tag(f)})`);
      }
    }

    for (const f of findFiles(root, (n) => /^wrangler\.(jsonc?|toml)$/.test(n))) {
      const text = readFileSync(f, 'utf8');
      const w = f.endsWith('.toml') ? null : readLooseJson(f);
      const name = w?.name ?? /^name\s*=\s*"([^"]+)"/m.exec(text)?.[1];
      const account = w?.account_id ?? /^account_id\s*=\s*"([^"]+)"/m.exec(text)?.[1];
      const bindings = [
        ...(w?.d1_databases ?? []).map((d: any) => `D1 ${d.database_name}`),
        ...(w?.kv_namespaces ?? []).map((k: any) => `KV ${k.binding}`),
        ...(w?.r2_buckets ?? []).map((r: any) => `R2 ${r.bucket_name}`),
      ];
      infra.cloudflare = { ...infra.cloudflare, ...(account ? { accountId: String(account) } : {}), tokenKeychain: `control-room-${team.id}-cloudflare` };
      found.push(`Cloudflare Worker ${name ?? '?'}${bindings.length ? ` med ${bindings.join(', ')}` : ''}${account ? `, konto ${account}` : ''} (${tag(f)})`);
    }

    const eas = findFiles(root, (n) => n === 'eas.json', 1);
    for (const f of eas) {
      const app = readLooseJson(join(f, '..', 'app.json'))?.expo;
      const profiles = Object.keys(readLooseJson(f)?.build ?? {});
      if (app?.owner) infra.expo = { ...infra.expo, owner: String(app.owner) };
      else infra.expo = { ...infra.expo };
      found.push(`Expo/EAS${app?.owner ? `, ägare ${app.owner}` : ''}${app?.slug ? `, ${app.slug}` : ''}${profiles.length ? `, profiler ${profiles.join(', ')}` : ''} (${tag(f)})`);
    }

    for (const f of findFiles(root, (n) => n === 'sentry.properties' || n === '.sentryclirc')) {
      const text = readFileSync(f, 'utf8');
      const org = /^\s*(?:defaults\.)?org\s*=\s*(\S+)/m.exec(text)?.[1];
      const project = /^\s*(?:defaults\.)?project\s*=\s*(\S+)/m.exec(text)?.[1];
      if (org && project) monitors.sentry = { org, project };
      found.push(`Sentry${org ? ` ${org}/${project ?? '?'}` : ''} (${tag(f)})`);
    }
    if (!monitors.sentry) {
      const pkgs = findFiles(root, (n) => n === 'package.json', 2).filter((f) => /"@sentry\//.test(readFileSync(f, 'utf8')));
      if (pkgs.length) found.push(`Sentry-SDK i ${pkgs.map(tag).join(', ')}: ange org och projekt under Loggning`);
    }
    const ai = findFiles(root, (n) => /^appsettings(\.\w+)?\.json$/.test(n) || /\.bicep$/.test(n), 4).filter((f) =>
      /ApplicationInsights|APPLICATIONINSIGHTS_CONNECTION_STRING|Microsoft\.Insights\/components/i.test(readFileSync(f, 'utf8')),
    );
    if (ai.length) found.push(`Application Insights nämns i ${ai.slice(0, 3).map(tag).join(', ')}: app-id och prenumeration finns under API Access i portalen`);
    const pipes = findFiles(root, (n) => /^azure-pipelines.*\.ya?ml$/.test(n), 2);
    if (pipes.length) found.push(`Azure Pipelines (${pipes.map(tag).join(', ')})`);
  }

  if (projects.size) {
    infra.google = { projects: [...projects], ...(team.infra.google?.account ? { account: team.infra.google.account } : {}) };
    if (functions) monitors.googleLogging = { project: [...projects][0] };
    // Which signed-in Google account reaches the projects, when none is chosen.
    if (!infra.google.account) {
      try {
        const { stdout } = await run('firebase', ['login:list', '--json'], { timeout: 20_000 });
        const accounts = ((JSON.parse(stdout) as { result?: { user?: { email?: string } }[] }).result ?? []).map((r) => r.user?.email).filter(Boolean) as string[];
        for (const a of accounts) {
          const { stdout: list } = await run('firebase', ['projects:list', '--json', '--account', a], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }).catch(() => ({ stdout: '{}' }));
          const ids = new Set(((JSON.parse(list) as { result?: { projectId: string }[] }).result ?? []).map((p) => p.projectId));
          if ([...projects].every((p) => ids.has(p))) {
            infra.google.account = a;
            found.push(`${a} når ${[...projects].join(', ')} i Firebase`);
            break;
          }
        }
      } catch {
        // firebase missing or logged out: the account stays to choose.
      }
    }
  }
  if (!found.length) found.push('Hittade ingen Firebase, Cloudflare, Expo, Sentry eller Application Insights i repot.');
  return { infra, monitors, found };
}

/**
 * What the signed-in CLIs say, asked here with timeouts rather than by the
 * agent (firebase and gcloud can sit on a prompt forever without a terminal).
 */
async function cliFacts(team: Team): Promise<string> {
  const q = async (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => {
    try {
      const { stdout } = await run(cmd, args, { timeout: 45_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...env, CI: '1' } });
      return stdout.trim();
    } catch (err) {
      return `(fel: ${firstLine(err)})`;
    }
  };
  const lines: string[] = [];
  const fbAccounts = await q('firebase', ['login:list', '--json', '--non-interactive']).then((o) => {
    try {
      return ((JSON.parse(o) as { result?: { user?: { email?: string } }[] }).result ?? []).map((r) => r.user?.email).filter(Boolean) as string[];
    } catch {
      return [];
    }
  });
  const [fbProjects, gcloud, eas, azure] = await Promise.all([
    Promise.all(
      fbAccounts.map(async (a) => {
        const o = await q('firebase', ['projects:list', '--json', '--non-interactive', '--account', a]);
        try {
          const ps = (JSON.parse(o) as { result?: { projectId: string; displayName?: string }[] }).result ?? [];
          return `firebase som ${a}: ${ps.map((p) => `${p.projectId}${p.displayName && p.displayName !== p.projectId ? ` (${p.displayName})` : ''}`).join(', ') || 'inga projekt'}`;
        } catch {
          return `firebase som ${a}: ${o.slice(0, 200)}`;
        }
      }),
    ),
    q('gcloud', ['auth', 'list', '--format=value(account)']),
    q('eas', ['whoami'], identityEnv(team.account)),
    Promise.all(
      readdirSync(homedir())
        .filter((n) => /^\.azure(-[\w.-]+)?$/.test(n))
        .map(async (n) => {
          const o = await q('az', ['account', 'list', '--all', '--query', '[].{name:name, id:id, user:user.name, tenant:tenantId}', '-o', 'json'], { AZURE_CONFIG_DIR: join(homedir(), n) });
          return `az i ~/${n}: ${o.replace(/\s+/g, ' ').slice(0, 1500)}`;
        }),
    ),
  ]);
  lines.push(`firebase-konton: ${fbAccounts.join(', ') || 'inga'}`, ...fbProjects);
  lines.push(`gcloud-konton: ${gcloud.split('\n').join(', ') || 'inga'}`);
  lines.push(`eas whoami: ${eas.split('\n').find((l) => l && !/available|upgrade|npm|★/i.test(l)) ?? eas}`);
  lines.push(...azure);
  return lines.join('\n');
}

// ---------------------------------------------------------------- the agent that fills the list

const STR_MAP = { type: 'object', additionalProperties: { type: 'string' } };
const COMMAND = { type: 'array', items: { type: 'string' } };
const ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    kind: { type: 'string' },
    facts: STR_MAP,
    notes: { type: 'string' },
    env: STR_MAP,
    login: { type: 'object', additionalProperties: false, properties: { env: STR_MAP, steps: { type: 'array', items: COMMAND }, url: { type: 'string' }, secret: { type: 'string' } } },
    check: { type: 'object', additionalProperties: false, properties: { env: STR_MAP, command: COMMAND }, required: ['command'] },
    monitor: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: ['sentry', 'appInsights', 'googleLogging'] },
        org: { type: 'string' },
        project: { type: 'string' },
        appId: { type: 'string' },
        subscription: { type: 'string' },
        azureConfigDir: { type: 'string' },
        account: { type: 'string' },
      },
      required: ['type'],
    },
    source: { type: 'string' },
  },
  required: ['id', 'title', 'kind', 'facts'],
};
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: ITEM },
    summary: { type: 'string', description: 'En eller två meningar på svenska: vad du lade till, ändrade eller tog bort, och vad som fortfarande saknas.' },
  },
  required: ['items', 'summary'],
};

export interface InfraAnswer {
  /** What changed, by title. */
  added: string[];
  changed: string[];
  removed: string[];
  summary: string;
  /** Whether the agent answered; without it the list is untouched. */
  ok: boolean;
}

/**
 * An agent reads what a person would (repos, CLAUDE.md, the project's Claude
 * memory, its roles' notes) and what the signed-in CLIs say, and returns the
 * list. With no instruction it only adds what is missing; with one, it does
 * what the owner wrote. Suggestions from agents are left for the owner.
 */
export async function askInfra(team: Team, instruction: string): Promise<InfraAnswer> {
  const notesDir = join(TEAMS_DIR, team.id, 'notes');
  const memoryDir = team.memory ? dirname(team.memory) : null;
  const [scanned, facts] = await Promise.all([identifyInfra(team), cliFacts(team)]);
  const current = team.infraItems.filter((i) => !i.suggested);
  const prompt = `Du håller listan över var projektet ${team.name} körs och loggar: molnprojekt, konton, resurser, felkällor. Läs med Read, Glob och Grep; ändra inga filer och kör inga kommandon.

${instruction.trim() ? `Ägaren skriver:\n"""\n${instruction.trim()}\n"""\nGör det. Lämna resten av listan som den är.` : 'Identifiera det som saknas i listan och lägg till det. Ändra inte det som redan finns, om det inte är fel enligt en källa.'}

Listan nu (JSON):
${JSON.stringify(current, null, 1)}

Källor:
- Repo${team.repos.length > 1 ? 'na' : 't'}: ${team.repos.map((r) => r.path).join(', ')}. Börja med infrastruktur som kod (bicep, terraform, firebase.json, wrangler, eas.json, CI-workflows i .github och azure-pipelines), sedan CLAUDE.md, README och docs.
${memoryDir ? `- Projektets Claude-minne: ${memoryDir} (MEMORY.md först; de filer som rör moln, konton, push, release, loggning).\n` : ''}- Rollernas anteckningar: ${notesDir}
- Filskanningen hittade:
${scanned.found.map((f) => `  - ${f}`).join('\n')}
- De inloggade CLI:erna på den här datorn säger:
${facts.split('\n').map((l) => `  ${l}`).join('\n')}

En post per sak projektet använder i dag (inte avvecklat), med:
- title, kind (google, azure, cloudflare, expo, sentry, appinsights, database …), facts: det en agent behöver veta (projekt-id, konto, prenumeration, resursnamn), source: var du hittade det.
- notes: hur en agent använder det rätt, t.ex. vilka flaggor som aldrig får utelämnas (--project, --account, --subscription), eftersom verktygens standardkonto ofta är ett annat.
- env: variabler agenterna ska få (t.ex. CLOUDSDK_CORE_ACCOUNT, CLOUDSDK_CORE_PROJECT, CLOUDFLARE_ACCOUNT_ID; en token som "secret:control-room-${team.id}-<namn>"). Sätt aldrig PATH, AZURE_CONFIG_DIR eller GH_CONFIG_DIR här; en annan az-profil för portalen blir AZURE_PORTAL_CONFIG_DIR.
- login: hur ägaren loggar in (steps som argumentlistor, t.ex. [["firebase","login:add","<konto>"]]; env med AZURE_CONFIG_DIR för en egen az-profil; url + secret för en token som klistras in).
- check: ett kommando som bara läser och lyckas när inloggningen fungerar (az account show, firebase projects:list --json --account <konto>, gcloud auth print-access-token är INTE tillåtet; använd list/show/whoami).
- monitor: för felkällor: sentry (org, project), appInsights (appId = Application ID under API Access, subscription; azureConfigDir om portalen har en egen az-profil), googleLogging (project, account).
Använd en egen az-profil per projekt (~/.azure-<projekt>), aldrig den delade ~/.azure. Gissa aldrig ett id: saknas det, skriv det i summary.`;
  const args = [
    '-p',
    '--model', 'sonnet',
    '--effort', 'low',
    '--max-turns', '30',
    '--output-format', process.env.INFRA_DEBUG ? 'stream-json' : 'json',
    ...(process.env.INFRA_DEBUG ? ['--verbose'] : []),
    '--json-schema', JSON.stringify(SCHEMA),
    '--strict-mcp-config',
    '--allowedTools', 'Read', 'Glob', 'Grep',
    '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent',
    '--add-dir', ...team.repos.map((r) => r.path), notesDir, ...(memoryDir ? [memoryDir] : []),
  ];
  const answer = await askReader<{ items: unknown[]; summary: string }>(team, prompt, args);
  if (!answer) return { added: [], changed: [], removed: [], summary: 'Agenten gav inget svar. Listan är oförändrad.', ok: false };

  const proposed = cleanItems(answer.items);
  const before = new Map(current.map((i) => [i.id, i]));
  // No instruction: only additions; what is there stays as the owner left it.
  const next = instruction.trim() ? proposed : [...current, ...proposed.filter((i) => !before.has(i.id))];
  const after = new Map(next.map((i) => [i.id, i]));
  const added = next.filter((i) => !before.has(i.id)).map((i) => i.title);
  const changed = next.filter((i) => before.has(i.id) && JSON.stringify(before.get(i.id)) !== JSON.stringify(i)).map((i) => i.title);
  const removed = current.filter((i) => !after.has(i.id)).map((i) => i.title);
  if (added.length || changed.length || removed.length) {
    saveTeamSettings(team.id, { infraItems: [...next, ...team.infraItems.filter((i) => i.suggested)] });
  }
  return { added, changed, removed, summary: answer.summary, ok: true };
}

/** One read-only Claude run with a JSON answer: the prompt on stdin, the structured output back. */
function askReader<T>(team: Team, prompt: string, args: string[]): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const child = spawn(CLAUDE_BIN, args, { cwd: team.repo, env: claudeEnv(team.account, 0), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString();
      if (process.env.INFRA_DEBUG) process.stderr.write(c);
    });
    const timer = setTimeout(() => child.kill(), 6 * 60_000);
    child.on('error', () => resolve(null));
    child.on('close', () => {
      clearTimeout(timer);
      try {
        // stream-json when debugging: the result is the last line.
        const last = out.trim().split('\n').filter((l) => l.includes('"type":"result"')).at(-1) ?? out;
        const msg = JSON.parse(last) as { structured_output?: T; result?: string; is_error?: boolean };
        if (msg.is_error) return resolve(null);
        resolve(msg.structured_output ?? (JSON.parse(String(msg.result)) as T));
      } catch {
        resolve(null);
      }
    });
    child.stdin.end(prompt);
  });
}

// ---------------------------------------------------------------- local apps

const APP = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: 'Kort id, gemener, t.ex. portal, web, api.' },
    label: { type: 'string', description: 'Appens namn som folk säger det, t.ex. "Portal Internal".' },
    repo: { type: 'string', description: 'Repots id.' },
    dir: { type: 'string', description: 'Mappen i repot där kommandot körs; tom sträng för roten.' },
    command: { type: 'string', description: 'Startar appen i förgrunden tills den stoppas, som projektets folk gör det.' },
    url: { type: 'string', description: 'Adressen man öppnar, t.ex. https://localhost:2222.' },
    ports: { type: 'array', items: { type: 'number' } },
    notes: { type: 'string', description: 'För agenterna: inloggning, testanvändare, vad som krävs (Docker, en databas).' },
    source: { type: 'string' },
  },
  required: ['id', 'label', 'repo', 'dir', 'command', 'url', 'ports', 'notes'],
};
const APPS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    apps: { type: 'array', items: APP },
    summary: { type: 'string', description: 'En eller två meningar på svenska: vilka appar du hittade och vad som är osäkert.' },
  },
  required: ['apps', 'summary'],
};

/**
 * An agent reads the repos the way a new developer would (README, package.json
 * scripts, launchSettings, docker-compose, the project's memory) and lists the
 * apps people start locally while they work, with the command they use. With
 * an instruction it does what the owner wrote; without one it only adds.
 */
export async function askDevApps(team: Team, instruction: string): Promise<InfraAnswer> {
  const notesDir = join(TEAMS_DIR, team.id, 'notes');
  const runDir = join(TEAMS_DIR, team.id, 'run');
  const memoryDir = team.memory ? dirname(team.memory) : null;
  const current = team.devApps;
  const prompt = `Du tar reda på hur projektet ${team.name} körs lokalt när man utvecklar: de appar man startar på sin dator (en webbapp, en backend, ett API, en dev-server) och exakt hur projektets folk startar dem. Läs med Read, Glob och Grep; ändra inga filer och kör inga kommandon.

${instruction.trim() ? `Ägaren skriver:\n"""\n${instruction.trim()}\n"""\nGör det. Lämna resten av listan som den är.` : 'Lägg till de appar som saknas i listan. Ändra inte det som redan finns, om det inte är fel enligt en källa.'}

Listan nu (JSON):
${JSON.stringify(current, null, 1)}

Källor:
- Repo${team.repos.length > 1 ? 'na' : 't'} (id: sökväg): ${team.repos.map((r) => `${r.id}: ${r.path}`).join(', ')}. Läs README, CLAUDE.md, docs, package.json-skript (dev, start, serve), Properties/launchSettings.json, docker-compose, Procfile, Makefile, .vscode/launch.json.
${memoryDir ? `- Projektets Claude-minne: ${memoryDir} (MEMORY.md först).\n` : ''}- Rollernas anteckningar: ${notesDir}
- Startskript ägaren redan har: ${runDir} (finns de, använd dem: command blir t.ex. "\$CR_RUN/portal.sh serve").

En post per app som man kör lokalt och tittar på eller anropar, inte byggsteg, tester eller bibliotek:
- command: det man skriver i terminalen för att starta den, i förgrunden (t.ex. "pnpm run dev", "dotnet watch run --launch-profile dev", "npm start"). Det körs med zsh i dir och stoppas med SIGTERM. Startar ett kommando flera delar (backend och frontend samtidigt), är det en app. Miljövariabler som finns: CR_ROOT (checkouten den körs från, ägarens eller ett korts worktree), CR_CARD (kortets nummer, tomt för ägaren), CR_RUN (${runDir}).
- url: adressen man öppnar i webbläsaren eller anropar; ports: alla portar den lyssnar på (från launchSettings, vite.config, .env).
- notes: det en agent behöver för att använda den: inloggning (t.ex. Entra/SSO i webbläsaren), testanvändare, vad som måste vara igång (Docker, SQL Server, Azurite).
Gissa aldrig en port eller ett kommando: står det inte i en källa, skriv det i summary.`;
  const args = [
    '-p',
    '--model', 'sonnet',
    '--effort', 'low',
    '--max-turns', '30',
    '--output-format', process.env.INFRA_DEBUG ? 'stream-json' : 'json',
    ...(process.env.INFRA_DEBUG ? ['--verbose'] : []),
    '--json-schema', JSON.stringify(APPS_SCHEMA),
    '--strict-mcp-config',
    '--allowedTools', 'Read', 'Glob', 'Grep',
    '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent',
    '--add-dir', ...team.repos.map((r) => r.path), notesDir, ...(existsSync(runDir) ? [runDir] : []), ...(memoryDir ? [memoryDir] : []),
  ];
  const answer = await askReader<{ apps: unknown[]; summary: string }>(team, prompt, args);
  if (!answer) return { added: [], changed: [], removed: [], summary: 'Agenten gav inget svar. Listan är oförändrad.', ok: false };
  const repoIds = new Set(team.repos.map((r) => r.id));
  const proposed = cleanDevApps(answer.apps).map((a) => ({ ...a, repo: repoIds.has(a.repo) ? a.repo : team.repos[0].id }));
  const before = new Map(current.map((a) => [a.id, a]));
  // keepRunning is the owner's choice: an agent's list never changes it.
  const next = (instruction.trim() ? proposed : [...current, ...proposed.filter((a) => !before.has(a.id))]).map((a) => ({ ...a, keepRunning: before.get(a.id)?.keepRunning ?? false }));
  const after = new Map(next.map((a) => [a.id, a]));
  const added = next.filter((a) => !before.has(a.id)).map((a) => a.label);
  const changed = next.filter((a) => before.has(a.id) && JSON.stringify(before.get(a.id)) !== JSON.stringify(a)).map((a) => a.label);
  const removed = current.filter((a) => !after.has(a.id)).map((a) => a.label);
  if (added.length || changed.length || removed.length) saveTeamSettings(team.id, { devApps: next });
  return { added, changed, removed, summary: answer.summary, ok: true };
}

/** A new project: its list filled in the background, and the board told when it is done. */
export function setUpNewProject(teamId: string) {
  const team = getTeam(teamId);
  if (!team) return;
  void askInfra(team, '')
    .then((r) => {
      console.log(`[infra] ${teamId}: ${r.added.join(' · ') || r.summary}`);
      bus.emit({ type: 'teams' });
    })
    .catch((err) => console.warn(`[infra] ${teamId}: ${(err as Error).message}`));
  // How it runs locally: a button per app on the board.
  void askDevApps(team, '')
    .then((r) => {
      console.log(`[appar] ${teamId}: ${r.added.join(' · ') || r.summary}`);
      bus.emit({ type: 'teams' });
    })
    .catch((err) => console.warn(`[appar] ${teamId}: ${(err as Error).message}`));
}
