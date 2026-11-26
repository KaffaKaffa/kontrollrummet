import { execFileSync } from './proc.ts';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { APP_ROOT, expandHome } from './config.ts';
import { getAccount } from './accounts.ts';
import type { Role, Team } from './roles.ts';
import { readSecret } from './secrets.ts';

/**
 * The MCP servers a team's agents can be given, one by one. Each agent gets
 * only the ones it is given, under --strict-mcp-config, so it never reads the
 * instructions of servers it does not use. claude.ai connectors (the account's
 * Figma or Microsoft 365 connector) cannot be picked this way; they come with
 * "all", which is the account's whole set.
 */

export type McpSource = 'library' | 'account' | 'project' | 'repo' | 'team';

export interface McpServer {
  id: string;
  label: string;
  note: string;
  source: McpSource;
  /** oauth: logged in once with /mcp in claude. token: a secret in the keychain (team.local.json "secrets"). */
  auth: 'none' | 'oauth' | 'token';
  /** Role kinds or ids it is suggested for. */
  suggestWhen: string[];
  config: Record<string, unknown>;
}

const SOURCE_LABEL: Record<McpSource, string> = {
  library: 'Kontrollrummets bibliotek',
  account: 'Kontots egna',
  project: 'Kontots, för det här repot',
  repo: 'Repots .mcp.json',
  team: 'Teamets team.json',
};
export const sourceLabel = (s: McpSource) => SOURCE_LABEL[s];

/** JSON files read again only when they change; a profile's .claude.json can be large. */
const cache = new Map<string, { mtime: number; data: any }>();
function readJson(path: string): any {
  try {
    const mtime = statSync(path).mtimeMs;
    const hit = cache.get(path);
    if (hit && hit.mtime === mtime) return hit.data;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    cache.set(path, { mtime, data });
    return data;
  } catch {
    return null;
  }
}

/** The library: servers the control room knows and can suggest. */
export function libraryServers(): McpServer[] {
  const lib = readJson(join(APP_ROOT, 'library/mcp.json')) ?? {};
  return Object.entries(lib as Record<string, any>).map(([id, s]) => ({
    id,
    label: s.label ?? id,
    note: s.note ?? '',
    source: 'library' as const,
    auth: s.auth ?? 'none',
    suggestWhen: s.suggestWhen ?? [],
    config: s.config,
  }));
}

function plain(id: string, config: any, source: McpSource): McpServer {
  return { id, label: id, note: '', source, auth: config?.type === 'http' || config?.type === 'sse' ? 'oauth' : 'none', suggestWhen: [], config };
}

/** The profile's own config: ~/.claude.json for the standard profile. */
function profileConfig(accountId: string): any {
  const a = getAccount(accountId);
  const dir = expandHome(a.claudeConfigDir);
  const file = resolve(dir) === join(homedir(), '.claude') ? join(homedir(), '.claude.json') : join(dir, '.claude.json');
  return readJson(file);
}

/**
 * Everything the team can pick from, the more specific source winning on the
 * same id: library, the account's own, the account's for this repo, the repo's
 * .mcp.json, the team's team.json.
 */
export function availableServers(team: Pick<Team, 'repo' | 'account' | 'mcpServers'> & { repos?: { path: string }[] }): McpServer[] {
  const out = new Map<string, McpServer>();
  for (const s of libraryServers()) out.set(s.id, s);
  const profile = profileConfig(team.account) ?? {};
  for (const [id, c] of Object.entries((profile.mcpServers ?? {}) as Record<string, unknown>)) out.set(id, { ...(out.get(id) ?? plain(id, c, 'account')), source: 'account', config: c as Record<string, unknown> });
  // The project's folder and, with several repos, each of them.
  const dirs = [...new Set([team.repo, ...(team.repos ?? []).map((r) => r.path)])];
  for (const dir of dirs) {
    const local = profile.projects?.[dir]?.mcpServers ?? {};
    for (const [id, c] of Object.entries(local as Record<string, unknown>)) out.set(id, { ...(out.get(id) ?? plain(id, c, 'project')), source: 'project', config: c as Record<string, unknown> });
  }
  for (const dir of dirs) {
    const repo = existsSync(join(dir, '.mcp.json')) ? (readJson(join(dir, '.mcp.json'))?.mcpServers ?? {}) : {};
    for (const [id, c] of Object.entries(repo as Record<string, unknown>)) out.set(id, { ...(out.get(id) ?? plain(id, c, 'repo')), source: 'repo', config: c as Record<string, unknown> });
  }
  for (const [id, c] of Object.entries(team.mcpServers ?? {})) out.set(id, { ...(out.get(id) ?? plain(id, c, 'team')), source: 'team', config: c });
  return [...out.values()].sort((a, b) => a.label.localeCompare(b.label, 'sv'));
}

/**
 * Claude in Chrome: the owner's own Chrome, with their profile and logins. It
 * is no server to configure but built into Claude Code and turned on with
 * --chrome, so it sits in the library without config and serversFor skips it.
 */
export const CHROME = 'claude-in-chrome';
export const wantsChrome = (role: Pick<Role, 'mcp'>) => role.mcp === 'all' || role.mcp.includes(CHROME);

/** The servers to hand a role's process, besides the control room's own. */
export function serversFor(team: Team, role: Pick<Role, 'mcp'>): Record<string, Record<string, unknown>> {
  if (role.mcp === 'all') return {};
  const available = new Map(availableServers(team).map((s) => [s.id, s]));
  const out: Record<string, Record<string, unknown>> = {};
  for (const id of role.mcp) {
    const s = available.get(id);
    if (s?.config) out[id] = s.config;
  }
  return out;
}

/**
 * Secrets the team's MCP servers name as ${VAR}: read from the keychain at
 * launch (team.local.json "secrets": { "VAR": "keychain-service" }), never
 * written to a file.
 */
export function teamSecrets(team: Pick<Team, 'secrets'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, service] of Object.entries(team.secrets ?? {})) {
    // Missing: the server that needs it fails to start, and the check in the project settings says why.
    const value = readSecret(service);
    if (value) out[name] = value;
  }
  return out;
}
