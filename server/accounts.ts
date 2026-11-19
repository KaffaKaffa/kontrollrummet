import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DATA_DIR, expandHome } from './config.ts';

/**
 * A Claude account is a Claude Code profile: a config folder with its own
 * login, subscription, MCP servers and skills. The standard profile is
 * ~/.claude with its config in ~/.claude.json; any other is a folder named
 * by CLAUDE_CONFIG_DIR. Each project picks one, and so does each Gudfadern
 * conversation. Limits and quota are per account, since each is its own
 * subscription.
 */
export interface Account {
  id: string;
  name: string;
  /** The profile folder. ~/.claude is the standard profile and runs with no CLAUDE_CONFIG_DIR. */
  claudeConfigDir: string;
  /** gh's config for this account, or none: gh's own default. */
  ghConfigDir?: string;
  /** az's config for this account (AZURE_CONFIG_DIR), or none: ~/.azure. */
  azureConfigDir?: string;
}

export interface AccountStatus {
  loggedIn: boolean;
  email: string | null;
  organization: string | null;
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

const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

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
  try {
    const config = JSON.parse(readFileSync(configFile(a), 'utf8')) as {
      oauthAccount?: { emailAddress?: string; organizationName?: string };
    };
    const o = config.oauthAccount;
    return { loggedIn: Boolean(o?.emailAddress), email: o?.emailAddress ?? null, organization: o?.organizationName ?? null };
  } catch {
    return { loggedIn: false, email: null, organization: null };
  }
}

/**
 * The environment a process for this account runs with. The standard profile
 * must run without CLAUDE_CONFIG_DIR, or Claude Code looks for its login in
 * the wrong place.
 */
export function accountEnv(id: string | null | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const a = getAccount(id);
  const env = { ...base };
  if (isStandard(a)) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = expandHome(a.claudeConfigDir);
  if (a.ghConfigDir) env.GH_CONFIG_DIR = expandHome(a.ghConfigDir);
  else delete env.GH_CONFIG_DIR;
  if (a.azureConfigDir) env.AZURE_CONFIG_DIR = expandHome(a.azureConfigDir);
  else delete env.AZURE_CONFIG_DIR;
  return env;
}

/** For the board: every account and whether it is logged in. */
export function accountsView() {
  const file = load();
  return file.accounts.map((a) => ({ id: a.id, name: a.name, isDefault: a.id === file.default, ...accountStatus(a) }));
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
export function identityTerminal(who: Identity, what: string): { banner: string; env: Record<string, string | null> } {
  const w = typeof who === 'string' ? { account: who, azureConfigDir: null } : who;
  const a = getAccount(w.account);
  const st = accountStatus(a);
  const env = identityEnv(who, {});
  return {
    banner: `Kontrollrummet: ${what}. Claude-konto ${a.name}${st.email ? ` (${st.email})` : ''}${w.azureConfigDir ? `, az-profil ${w.azureConfigDir}` : ''}.`,
    env: Object.fromEntries(['CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR', 'AZURE_CONFIG_DIR'].map((k) => [k, env[k] ?? null])),
  };
}
