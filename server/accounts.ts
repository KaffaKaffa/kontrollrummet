import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DATA_DIR, expandHome } from './config.ts';
import { accountCap } from './limits.ts';
import { IS_WINDOWS, execFile, execFileSync } from './proc.ts';
import { readSecret, secretFile } from './secrets.ts';

/**
 * A Claude account is a Claude Code profile: a config folder with its own
 * login, subscription, MCP servers and skills. The standard profile is
 * ~/.claude with its config in ~/.claude.json; any other is a folder named
 * by CLAUDE_CONFIG_DIR. Each project picks one, and so does each Gudfadern
 * conversation. Limits and quota are per account, since each is its own
 * subscription.
 */
export type AccountKind = 'claude' | 'foundry';

/** Model tiers Claude Code asks for by alias; a Foundry account maps each to a deployment name. */
export const TIERS = ['opus', 'sonnet', 'haiku'] as const;
export type Tier = (typeof TIERS)[number];

export interface FoundryConfig {
  /** The resource name, or a full base URL ending in /anthropic. One of the two. */
  resource?: string;
  baseUrl?: string;
  /** 'key': the API key from the keychain. 'entra': az login in the account's azureConfigDir. */
  auth: 'key' | 'entra';
  /** Deployment name per tier. At least one; a missing tier falls back to another (see tierDeployments). */
  deployments: Partial<Record<Tier, string>>;
  /** Optional az login --tenant, for an identity with several tenants. Not a secret. */
  tenant?: string;
}

export interface Account {
  id: string;
  name: string;
  /** Missing means 'claude', so an accounts.json from before Foundry keeps working. */
  kind?: AccountKind;
  /** Only when kind is 'foundry'. */
  foundry?: FoundryConfig;
  /** The profile folder. ~/.claude is the standard profile and runs with no CLAUDE_CONFIG_DIR. */
  claudeConfigDir: string;
  /** gh's config for this account, or none: gh's own default. */
  ghConfigDir?: string;
  /** az's config for this account (AZURE_CONFIG_DIR), or none: ~/.azure. */
  azureConfigDir?: string;
}

export interface AccountStatus {
  kind: AccountKind;
  /** Claude: logged in. Foundry: has its key, or is signed in to Azure. */
  loggedIn: boolean;
  ready: boolean;
  /** One line on how the account gets in, for lists. */
  detail: string;
  email: string | null;
  organization: string | null;
}

export const isFoundry = (a: Account) => a.kind === 'foundry' && Boolean(a.foundry);
/** Where the API key of a Foundry account lives (keychain service / DPAPI file name). */
export const foundryKeyService = (id: string) => `control-room-foundry-${id}`;
const PROFILES = join(DATA_DIR, 'profiles');

/** The deployment each tier runs: a missing tier uses a neighbour, so --model haiku and --model opus always resolve. */
export function tierDeployments(f: FoundryConfig): Record<Tier, string> {
  const d = f.deployments;
  const any = d.sonnet || d.opus || d.haiku || '';
  return { opus: d.opus || d.sonnet || d.haiku || any, sonnet: d.sonnet || d.opus || d.haiku || any, haiku: d.haiku || d.sonnet || d.opus || any };
}

const resourceOf = (f: FoundryConfig) => f.resource || f.baseUrl?.replace(/^https:\/\//, '').split('.')[0] || '';

/** "Claude-kontot X (e-post)" or "Foundry-kontot X (resurs Y)", for every place that says who runs. */
export function accountLabel(a: Account, st: AccountStatus = accountStatus(a)): string {
  if (isFoundry(a)) return `Foundry-kontot ${a.name} (resurs ${resourceOf(a.foundry!)})`;
  return `Claude-kontot ${a.name}${st.email ? ` (${st.email})` : ''}`;
}

interface AccountsFile {
  default: string;
  accounts: Account[];
}

const FILE = join(DATA_DIR, 'accounts.json');
const STANDARD = join(homedir(), '.claude');

const isStandard = (a: Account) => expandHome(a.claudeConfigDir) === STANDARD;

/** Where the profile keeps its login and settings: ~/.claude.json for the standard one. */
function configFile(a: Account) {
  return isStandard(a) ? join(homedir(), '.claude.json') : join(expandHome(a.claudeConfigDir), '.claude.json');
}

const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length).replace(/\\/g, '/')}` : p);

/**
 * The first time: every ~/.claude* profile on this Mac, with the one the
 * server itself runs as (from ~/.control-room/env) as the default.
 */
function discover(): AccountsFile {
  const home = homedir();
  const dirs = readdirSync(home)
    .filter((n) => /^\.claude(-[\w.-]+)?$/.test(n))
    .map((n) => join(home, n))
    .filter((p) => statSync(p).isDirectory());
  const accounts: Account[] = dirs.map((dir) => {
    const suffix = basename(dir).replace(/^\.claude-?/, '');
    const id = suffix || 'standard';
    const gh = join(dir, 'gh');
    return {
      id,
      name: suffix ? suffix[0].toUpperCase() + suffix.slice(1) : 'Standard',
      claudeConfigDir: tilde(dir),
      ...(existsSync(gh) ? { ghConfigDir: tilde(gh) } : {}),
    };
  });
  const current = process.env.CLAUDE_CONFIG_DIR ? expandHome(process.env.CLAUDE_CONFIG_DIR) : STANDARD;
  const def = accounts.find((a) => expandHome(a.claudeConfigDir) === current) ?? accounts[0];
  // A named organisation reads better than a folder suffix.
  for (const a of accounts) {
    const org = accountStatus(a).organization;
    if (org && a.id === 'standard') a.name = org;
  }
  return { default: def?.id ?? 'standard', accounts };
}

function load(): AccountsFile {
  if (existsSync(FILE)) {
    try {
      return JSON.parse(readFileSync(FILE, 'utf8')) as AccountsFile;
    } catch {
      // A broken file is found again below rather than stopping every agent.
    }
  }
  const found = discover();
  try {
    writeFileSync(FILE, `${JSON.stringify(found, null, 2)}\n`);
  } catch {
    // Read-only data folder: still works, found again next time.
  }
  return found;
}

export function listAccounts(): Account[] {
  return load().accounts;
}

export const defaultAccountId = () => load().default;

/** The account by id; an unknown or missing id is the default. */
export function getAccount(id?: string | null): Account {
  const file = load();
  const account = file.accounts.find((a) => a.id === id) ?? file.accounts.find((a) => a.id === file.default) ?? file.accounts[0];
  if (!account) throw new Error('inga Claude-konton hittades i ~/.claude*');
  return account;
}

/** Who the profile is logged in as, from its own config. Runs no model. */
export function accountStatus(a: Account): AccountStatus {
  if (isFoundry(a)) {
    const f = a.foundry!;
    const key = f.auth === 'key';
    const ready = key ? readSecret(foundryKeyService(a.id)) !== null : entraReady(a);
    return {
      kind: 'foundry',
      loggedIn: ready,
      ready,
      detail: `${key ? 'API-nyckel' : 'Entra ID'}, resurs ${resourceOf(f)}`,
      email: null,
      organization: null,
    };
  }
  try {
    const config = JSON.parse(readFileSync(configFile(a), 'utf8')) as {
      oauthAccount?: { emailAddress?: string; organizationName?: string };
    };
    const o = config.oauthAccount;
    const loggedIn = Boolean(o?.emailAddress);
    return { kind: 'claude', loggedIn, ready: loggedIn, detail: o?.emailAddress ?? '', email: o?.emailAddress ?? null, organization: o?.organizationName ?? null };
  } catch {
    return { kind: 'claude', loggedIn: false, ready: false, detail: '', email: null, organization: null };
  }
}

/** `az account show` is slow (1-3 s): asked in the background, remembered for five minutes. */
const entra = new Map<string, { at: number; ok: boolean; busy: boolean }>();
function entraReady(a: Account): boolean {
  const seen = entra.get(a.id);
  if (!seen || (Date.now() - seen.at > 5 * 60_000 && !seen.busy)) {
    entra.set(a.id, { at: seen?.at ?? 0, ok: seen?.ok ?? false, busy: true });
    execFile('az', ['account', 'show'], { env: accountEnv(a.id) }, (err) => entra.set(a.id, { at: Date.now(), ok: !err, busy: false }));
  }
  return entra.get(a.id)?.ok ?? false;
}
/** Forget the cached answer, e.g. after a login. */
export const forgetEntra = (id: string) => entra.delete(id);

/** Variables that would send Claude Code to another provider than the account says. */
const PROVIDER_VARS = [
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
];

/** The non-secret Foundry variables of an account. */
function foundryVars(f: FoundryConfig): Record<string, string> {
  const d = tierDeployments(f);
  return {
    CLAUDE_CODE_USE_FOUNDRY: '1',
    ...(f.baseUrl ? { ANTHROPIC_FOUNDRY_BASE_URL: f.baseUrl } : { ANTHROPIC_FOUNDRY_RESOURCE: f.resource ?? '' }),
    ANTHROPIC_DEFAULT_OPUS_MODEL: d.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: d.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: d.haiku,
  };
}

/**
 * The environment a process for this account runs with. The standard profile
 * must run without CLAUDE_CONFIG_DIR, or Claude Code looks for its login in
 * the wrong place.
 */
export function accountEnv(id: string | null | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const a = getAccount(id);
  const env = { ...base };
  // A Claude account must not inherit Foundry from the server's own environment, nor the reverse.
  for (const k of PROVIDER_VARS) delete env[k];
  if (isStandard(a)) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = expandHome(a.claudeConfigDir);
  if (a.ghConfigDir) env.GH_CONFIG_DIR = expandHome(a.ghConfigDir);
  else delete env.GH_CONFIG_DIR;
  if (a.azureConfigDir) env.AZURE_CONFIG_DIR = expandHome(a.azureConfigDir);
  else delete env.AZURE_CONFIG_DIR;
  if (isFoundry(a)) {
    Object.assign(env, foundryVars(a.foundry!));
    if (a.foundry!.auth === 'key') {
      const key = readSecret(foundryKeyService(a.id));
      if (key) env.ANTHROPIC_FOUNDRY_API_KEY = key;
      // Keeps the key from the agent's Bash, hooks and MCP servers.
      env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
    }
  }
  return env;
}

/** For the board: every account and whether it is logged in. */
export function accountsView() {
  const file = load();
  return file.accounts.map((a) => ({ id: a.id, name: a.name, isDefault: a.id === file.default, maxAgents: accountCap(a.id), ...accountStatus(a), ...(isFoundry(a) ? { models: tierDeployments(a.foundry!), explicit: a.foundry!.deployments, auth: a.foundry!.auth, resource: a.foundry!.resource ?? null, baseUrl: a.foundry!.baseUrl ?? null, tenant: a.foundry!.tenant ?? null } : {}) }));
}

/**
 * Who a command runs as: a Claude account, and for Azure DevOps optionally a
 * project's own az profile (AZURE_CONFIG_DIR), since az has one active login
 * per profile and a customer's DevOps often needs another than the default.
 */
export type Identity = string | { account: string; azureConfigDir?: string | null };

export function identityEnv(who: Identity, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const w = typeof who === 'string' ? { account: who } : who;
  const env = accountEnv(w.account, base);
  if (w.azureConfigDir) env.AZURE_CONFIG_DIR = expandHome(w.azureConfigDir);
  return env;
}

/**
 * A Terminal window as this identity: the line it prints first (which account
 * and profile), and its variables. Always explicit: whatever the shell has set
 * is cleared first, so the standard profile (no variables) really is the
 * standard profile. Spread into a TerminalJob.
 */
export function identityTerminal(who: Identity, what: string): { banner: string; env: Record<string, string | null>; secretEnv?: Record<string, string> } {
  const w = typeof who === 'string' ? { account: who, azureConfigDir: null } : who;
  const a = getAccount(w.account);
  const st = accountStatus(a);
  const env = identityEnv(who, {});
  // The key is read where the command runs (secretEnv), never put on the command line.
  delete env.ANTHROPIC_FOUNDRY_API_KEY;
  const keys = ['CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR', 'AZURE_CONFIG_DIR', ...PROVIDER_VARS.filter((k) => k !== 'ANTHROPIC_FOUNDRY_API_KEY')];
  return {
    banner: `Kontrollrummet: ${what}. ${accountLabel(a, st)}${w.azureConfigDir ? `, az-profil ${w.azureConfigDir}` : ''}.`,
    env: Object.fromEntries(keys.map((k) => [k, env[k] ?? null])),
    ...(isFoundry(a) && a.foundry!.auth === 'key' ? { secretEnv: { ANTHROPIC_FOUNDRY_API_KEY: foundryKeyService(a.id) } } : {}),
  };
}

// ---- Foundry accounts: added, edited and removed from the settings ----

export interface FoundryInput {
  name?: unknown;
  resource?: unknown;
  auth?: unknown;
  tenant?: unknown;
  deployments?: unknown;
}

/** A resource name, or an endpoint (https://<name>.services.ai.azure.com[/anthropic]), as the config fields. */
export function parseResource(raw: string): { resource?: string; baseUrl?: string } {
  const v = raw.trim().replace(/\/+$/, '');
  if (/^[a-z0-9][a-z0-9-]{0,62}$/i.test(v)) return { resource: v };
  const m = /^https:\/\/([a-z0-9][a-z0-9-]{0,62})\.(services\.ai\.azure\.com|cognitiveservices\.azure\.com)(\/anthropic)?$/i.exec(v);
  if (m) return { baseUrl: `https://${m[1]}.${m[2]}/anthropic` };
  throw new Error('Resursen ska vara ett resursnamn (till exempel min-resurs) eller en adress som https://min-resurs.services.ai.azure.com/anthropic');
}

function cleanFoundry(input: FoundryInput): { name: string; foundry: FoundryConfig } {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('Kontot behöver ett namn');
  const auth = input.auth === 'key' ? 'key' : input.auth === 'entra' ? 'entra' : null;
  if (!auth) throw new Error('Välj autentisering: Entra ID eller API-nyckel');
  const dep = (input.deployments ?? {}) as Record<string, unknown>;
  const deployments: Partial<Record<Tier, string>> = {};
  for (const t of TIERS) {
    const v = String(dep[t] ?? '').trim();
    if (!v) continue;
    if (!/^[\w.:-]{1,64}$/.test(v)) throw new Error(`Deployment-namnet för ${t} får bara ha bokstäver, siffror, punkt, kolon, understreck och bindestreck`);
    deployments[t] = v;
  }
  if (!Object.keys(deployments).length) throw new Error('Ange minst en deployment (Opus, Sonnet eller Haiku)');
  const tenant = String(input.tenant ?? '').trim();
  if (tenant && !/^[\w.-]{1,100}$/.test(tenant)) throw new Error('Tenant ser fel ut');
  return { name, foundry: { ...parseResource(String(input.resource ?? '')), auth, deployments, ...(tenant ? { tenant } : {}) } };
}

function save(file: AccountsFile) {
  writeFileSync(FILE, `${JSON.stringify(file, null, 2)}\n`);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'foundry';

export function addFoundryAccount(input: FoundryInput): Account {
  const { name, foundry } = cleanFoundry(input);
  const file = load();
  let id = `foundry-${slug(name)}`;
  for (let n = 2; file.accounts.some((a) => a.id === id); n++) id = `foundry-${slug(name)}-${n}`;
  const dir = join(PROFILES, id);
  mkdirSync(join(dir, 'azure'), { recursive: true });
  const account: Account = {
    id,
    name,
    kind: 'foundry',
    claudeConfigDir: tilde(dir),
    azureConfigDir: tilde(join(dir, 'azure')),
    foundry,
  };
  file.accounts.push(account);
  save(file);
  return account;
}

export function updateFoundryAccount(id: string, input: FoundryInput): Account {
  const file = load();
  const a = file.accounts.find((x) => x.id === id);
  if (!a || !isFoundry(a)) throw new Error('Foundry-kontot finns inte');
  const { name, foundry } = cleanFoundry(input);
  a.name = name;
  a.foundry = foundry;
  save(file);
  forgetEntra(id);
  return a;
}

/** Removes the account and its key; the profile folder stays, and its path is returned. */
export function removeFoundryAccount(id: string): string {
  const file = load();
  const a = file.accounts.find((x) => x.id === id);
  if (!a || !isFoundry(a)) throw new Error('Foundry-kontot finns inte');
  if (file.default === id) throw new Error('Standardkontot kan inte tas bort. Gör först ett annat konto till standard.');
  file.accounts = file.accounts.filter((x) => x.id !== id);
  save(file);
  deleteSecret(foundryKeyService(id));
  return expandHome(a.claudeConfigDir);
}

function deleteSecret(service: string) {
  try {
    if (IS_WINDOWS) execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Remove-Item -LiteralPath '${secretFile(service).replaceAll("'", "''")}' -ErrorAction SilentlyContinue`], { stdio: 'ignore' });
    else execFileSync('security', ['delete-generic-password', '-s', service], { stdio: 'ignore' });
  } catch {
    // No key saved: nothing to remove.
  }
}
