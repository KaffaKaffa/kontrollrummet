import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from './proc.ts';
import { basename, isAbsolute, join } from 'node:path';
import { APP_ROOT, TEAMS_DIR, expandHome } from './config.ts';
import { getAccount } from './accounts.ts';
import type { ReleaseConfig } from './releases.ts';
import type { VmConfig } from './vms.ts';

/**
 * What kind of teammate a role is decides which control-room tools it gets:
 * a lead plans and watches, bug triages, a tester verifies, an app agent builds.
 */
export type RoleKind = 'lead' | 'architect' | 'bug' | 'tester' | 'designer' | 'app';

export interface Role {
  id: string;
  kind: RoleKind;
  /** Short line in the office view: what this stereotype is like. */
  vibe: string;
  /** What the character looks like (age, hair, build, clothes), for the portrait and the 3D office. */
  look: string;
  /** The 3D character it is drawn as, from library/characters; empty: the template with the role's id. */
  character: string;
  name: string;
  /** What the agent is for, one line, shown on its section. */
  title: string;
  model: string;
  /**
   * A cheaper model for follow-up turns that only read a status message and
   * react: a lead woken by its cards, the board standup. Empty: same as model.
   */
  wakeModel: string;
  /**
   * Tokens the conversation may grow to before Claude summarises it and goes
   * on. Every step reads the whole conversation again, so this is what a long
   * card costs per step. 0: the team's default.
   */
  context: number;
  /** Effort level for the role's work (low, medium, high, xhigh). Empty: Claude Code's default. Wake-ups always run low. */
  effort: string;
  /**
   * The MCP servers the agent gets besides the control room's own, by id (see
   * mcp-servers.ts), or 'all': the account's whole set, claude.ai connectors
   * included. Every server's instructions are read again on every step, so
   * fewer is cheaper. Front matter: `mcp: figma, playwright` or `mcp: all`
   * (`true` is read as all).
   */
  mcp: 'all' | string[];
  /** Paths in the repo this agent owns. Shown to the agent and on its section. */
  owns: string[];
  /**
   * The team's repos this agent works in, by id; the first is where its cards
   * get their worktree unless a card names another. Empty: the team's first.
   */
  repos: string[];
  /** Whether a card for this agent gets a worktree and a branch. */
  worktree: boolean;
  /** Claude Code permission mode. auto by default; manual sends every prompt to the board. */
  permission: string;
  /** Appended to Claude Code's own system prompt. */
  prompt: string;
}

/** What a production error source is, for the bug agent's scheduled check. */
export type InfraMonitor =
  | { type: 'sentry'; org: string; project: string }
  | { type: 'appInsights'; appId: string; subscription: string; azureConfigDir?: string }
  | { type: 'googleLogging'; project: string; account?: string };

/**
 * One thing the project runs on or reads from: a Firebase project, an App
 * Insights resource, a Cloudflare account, a database. Found by an agent from
 * the repo, the project's memory and the signed-in CLIs, or described in a
 * prompt, and edited by hand; agents are told every one. This Mac's:
 * team.local.json "infraItems".
 */
export interface InfraItem {
  /** Short and stable: firebase, appinsights-prod. */
  id: string;
  title: string;
  /** What it is, loosely: azure, google, cloudflare, expo, sentry, appinsights, database … */
  kind: string;
  /** What an agent needs to know: project, account, subscription, resource names. */
  facts: Record<string, string>;
  /** Told to every agent as is: how to use it, which flags never to leave out. */
  notes?: string;
  /** Variables every agent gets; "secret:<service>" is read from the keychain at start. */
  env?: Record<string, string>;
  /** How the owner logs in, in a Terminal window opened by a button. */
  login?: { env?: Record<string, string>; steps?: string[][]; url?: string; secret?: string };
  /** A read-only command whose success means the login works (az account show, firebase projects:list …). */
  check?: { env?: Record<string, string>; command: string[] };
  /** Production errors read from it on a schedule. */
  monitor?: InfraMonitor;
  /** Where it was found or who added it. */
  source?: string;
  /** An agent's suggestion that waits for the owner: not told to agents until approved. */
  suggested?: boolean;
}

/**
 * The project's cloud, beside Azure (azureConfigDir): which project and which
 * login on each, so an agent never lands on a tool's default account or
 * project. This Mac's: team.local.json "infra".
 */
export interface InfraConfig {
  /** Firebase and Google Cloud: the projects, and the Google account firebase and gcloud use for them. */
  google?: { projects: string[]; account?: string };
  /** Cloudflare: the account, and an API token in the keychain (wrangler reads CLOUDFLARE_API_TOKEN). */
  cloudflare?: { accountId?: string; tokenKeychain?: string };
  /** Expo/EAS: the owner, and optionally an access token in the keychain (EXPO_TOKEN). */
  expo?: { owner?: string; tokenKeychain?: string };
}

export interface MonitorConfig {
  /** Sentry project, read with the signed-in sentry CLI. */
  sentry?: { org: string; project: string };
  /** Application Insights app id, queried with az's token for that subscription. */
  appInsights?: { appId: string; subscription: string; name?: string };
  /** Google Cloud Logging (Firebase Functions, Cloud Run): errors, read with gcloud as the project's Google account. */
  googleLogging?: { project: string };
  /** Minutes between checks. 30 by default. */
  everyMinutes?: number;
}

export interface HandoffConfig {
  /** The label on issues meant for this control room, e.g. kontrollrum:<name>. */
  label: string;
  /** How this control room signs its comments, e.g. the owner. */
  name: string;
  /** Other control rooms by name, and their labels. */
  peers: Record<string, string>;
}

/** One git checkout a team works in. */
export interface RepoInfo {
  /** Its name in the team: the folder name, unless team.local.json says otherwise. */
  id: string;
  path: string;
  /** Branch cards are cut from and PRs go to. */
  baseBranch: string;
}

/** Someone in the project, in team.json: shared with everyone who runs it. */
export interface Person {
  name: string;
  /** GitHub login or Azure DevOps e-mail, for review requests and mentions. */
  account?: string;
  /** What they do in the project, in a few words: "mergar PR:er, produktbeslut". */
  does?: string;
}

/** The az profile for portal resources: its own, else the DevOps one. */
export const portalAzureDir = (team: Pick<Team, 'azureConfigDir' | 'azurePortalConfigDir'>) => team.azurePortalConfigDir ?? team.azureConfigDir;

export function cleanPeople(input: unknown): Person[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object')
    .map((p) => ({
      name: String(p.name ?? '').trim().slice(0, 60),
      account: String(p.account ?? '').trim().slice(0, 100) || undefined,
      does: String(p.does ?? '').trim().slice(0, 200) || undefined,
    }))
    .filter((p) => p.name);
}

/** "Anna och Max", or the owner when the project lists nobody. */
export function peopleNames(team: Team, fallback: string): string {
  const names = team.people.map((p) => p.name);
  if (!names.length) return fallback;
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} och ${names[names.length - 1]}`;
}

/** The project's people, for the agents' prompt. */
export function peopleSection(team: Team): string {
  if (!team.people.length) return '';
  const lines = team.people.map((p) => `- ${p.name}${p.account ? ` (${p.account})` : ''}${p.does ? `: ${p.does}` : ''}`);
  return `## Människorna i projektet\n\n${lines.join('\n')}\n\nFrågor och beslut går till den som det gäller.`;
}

export interface Team {
  id: string;
  name: string;
  /**
   * The project's folder: one checkout, or a folder holding several that go
   * together. Agents without a worktree (lead, architect, bug) work here.
   */
  repo: string;
  /** The checkouts: the folder itself when it is one, or those listed under "repos". */
  repos: RepoInfo[];
  /** The Claude account (profile) its agents run on; see accounts.ts. */
  account: string;
  /** Its own az profile (AZURE_CONFIG_DIR) for Azure DevOps, when the default az login is another tenant's. */
  azureConfigDir: string | null;
  /**
   * The az profile for the Azure portal (App Insights, databases, resources),
   * when it is another login than DevOps'. Null: the DevOps profile.
   */
  azurePortalConfigDir: string | null;
  /**
   * Who else the owner is on the git host, besides the signed-in account, for
   * finding PRs that wait for his review (GitHub logins or Azure DevOps e-mails).
   */
  reviewer: string[];
  /** Skills and commands in the repos that this project's agents must not use. */
  disabledSkills: string[];
  /** MCP servers defined for the team in team.json, by id. */
  mcpServers: Record<string, Record<string, unknown>>;
  /** Environment variables for MCP servers, read from these keychain services at launch. */
  secrets: Record<string, string>;
  /** Branch new cards are cut from and PRs go to. */
  baseBranch: string;
  /** The project's Claude Code memory index, which a worktree would not find on its own. */
  memory: string | null;
  /** Paths whose merged changes mean Figma must catch up. Empty: no sync watch. */
  figmaSync: string[];
  /** The team's store apps and where their keys are, for the Releases view. */
  releases: ReleaseConfig | null;
  /** Virtual machines agents may ask to start, keyed by resource name (e.g. parallels-vm). */
  vms: Record<string, VmConfig> | null;
  /** Error sources checked on a schedule; new errors become one card for the bug agent. */
  monitors: MonitorConfig | null;
  /** Firebase/Google Cloud, Cloudflare, Expo: projects and logins (the old form; read into infraItems). */
  infra: InfraConfig;
  /** Where the project runs and reads errors from: the list in Inställningar → Infrastruktur. */
  infraItems: InfraItem[];
  /** Talking to another control room through labelled GitHub issues in the repo. */
  handoff: HandoffConfig | null;
  /** The people in the project: who merges, decides, reviews. Agents are told, and ask the right one. */
  people: Person[];
  roles: Role[];
  /** shared.md for every team, then the team's own shared.md. */
  prompt: string;
  /** Just the team's own shared.md, for editing. */
  teamPrompt: string;
}

/**
 * roles/*.md: a small front matter of `key: value` lines, then the prompt.
 * Lists are comma separated. Kept deliberately dumber than YAML.
 */
export function parseRole(id: string, source: string): Role {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error(`roles/${id}.md has no front matter`);
  const meta = new Map<string, string>();
  for (const line of match[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const list = (key: string) =>
    (meta.get(key) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    id,
    name: meta.get('name') ?? id,
    kind: (meta.get('kind') as RoleKind | undefined) ?? 'app',
    vibe: meta.get('vibe') ?? '',
    look: meta.get('look') ?? '',
    character: meta.get('character') ?? '',
    title: meta.get('title') ?? '',
    model: meta.get('model') ?? 'opus',
    wakeModel: meta.get('wakeModel') ?? '',
    context: Number(meta.get('context') ?? 0) || 0,
    effort: meta.get('effort') ?? '',
    mcp: meta.get('mcp') === 'true' || meta.get('mcp') === 'all' ? 'all' : list('mcp'),
    owns: list('owns'),
    repos: list('repo'),
    worktree: meta.get('worktree') !== 'false',
    permission: meta.get('permission') ?? 'auto',
    prompt: match[2].trim(),
  };
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : '');

/** Objects merge key by key; anything else in the override wins. */
function merge(base: any, over: any): any {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v);
  return out;
}

function loadTeam(id: string): Team {
  const dir = join(TEAMS_DIR, id);
  // team.json is shared in the repo; team.local.json holds this Mac's paths and keys.
  const local = join(dir, 'team.local.json');
  const config = merge(
    JSON.parse(readFileSync(join(dir, 'team.json'), 'utf8')),
    existsSync(local) ? JSON.parse(readFileSync(local, 'utf8')) : {},
  ) as {
    name?: string;
    repo: string;
    /** Several checkouts under repo: { "<id>": "<path, relative to repo or absolute>" }. */
    repos?: Record<string, string>;
    /** Base branch per repo id, where it is not baseBranch. */
    baseBranches?: Record<string, string>;
    account?: string;
    azureConfigDir?: string;
    azurePortalConfigDir?: string;
    reviewer?: string | string[];
    disabledSkills?: string[];
    mcp?: Record<string, Record<string, unknown>>;
    secrets?: Record<string, string>;
    baseBranch?: string;
    memory?: string;
    figmaSync?: string[];
    releases?: ReleaseConfig;
    vms?: Record<string, VmConfig>;
    monitors?: MonitorConfig;
    infra?: InfraConfig;
    infraItems?: InfraItem[];
    handoff?: HandoffConfig;
    people?: Person[];
  };
  const rolesDir = join(dir, 'roles');
  const roles = existsSync(rolesDir)
    ? readdirSync(rolesDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((f) => parseRole(f.slice(0, -3), readFileSync(join(rolesDir, f), 'utf8')))
    : [];
  const root = expandHome(config.repo);
  const baseBranch = config.baseBranch ?? 'main';
  const repos: RepoInfo[] =
    config.repos && Object.keys(config.repos).length
      ? Object.entries(config.repos).map(([rid, p]) => {
          const path = isAbsolute(expandHome(p)) ? expandHome(p) : join(root, p);
          return { id: rid, path, baseBranch: config.baseBranches?.[rid] ?? detectBase(path) ?? baseBranch };
        })
      : [{ id: basename(root), path: root, baseBranch }];
  return {
    id,
    name: config.name ?? id,
    repo: root,
    repos,
    account: getAccount(config.account).id,
    azureConfigDir: config.azureConfigDir ? expandHome(config.azureConfigDir) : null,
    azurePortalConfigDir: config.azurePortalConfigDir ? expandHome(config.azurePortalConfigDir) : null,
    reviewer: [config.reviewer ?? []].flat(),
    disabledSkills: config.disabledSkills ?? [],
    mcpServers: config.mcp ?? {},
    secrets: config.secrets ?? {},
    baseBranch: config.baseBranch ?? 'main',
    memory: config.memory ? expandHome(config.memory) : null,
    figmaSync: config.figmaSync ?? [],
    releases: config.releases ?? null,
    vms: config.vms ?? null,
    monitors: config.monitors ?? null,
    infra: config.infra ?? {},
    infraItems: config.infraItems ?? legacyInfraItems(config),
    handoff: config.handoff ?? null,
    people: cleanPeople(config.people),
    roles,
    prompt: [read(join(APP_ROOT, 'shared.md')), read(join(dir, 'shared.md'))].filter(Boolean).join('\n\n'),
    teamPrompt: read(join(dir, 'shared.md')),
  };
}

/** origin/HEAD of a checkout, looked up once per path. */
const bases = new Map<string, string | null>();
function detectBase(path: string): string | null {
  if (!bases.has(path)) {
    try {
      const git = (args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      // GitFlow: develop when there is one, as in scan.ts.
      let develop = false;
      try {
        develop = Boolean(git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/develop']));
      } catch {
        develop = false;
      }
      bases.set(path, develop ? 'develop' : git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '') || null);
    } catch {
      bases.set(path, null);
    }
  }
  return bases.get(path)!;
}

/**
 * The checkout a card works in: the one the card names, else its agent's
 * first, else the team's first.
 */
export function repoFor(team: Team, role: Pick<Role, 'repos'> | undefined, subtask?: { repo?: string | null }): RepoInfo {
  const want = subtask?.repo ?? role?.repos[0];
  return team.repos.find((r) => r.id === want) ?? team.repos[0];
}

/** Read fresh on every call: editing a role or adding a team needs no restart. */
export function loadTeams(): Team[] {
  if (!existsSync(TEAMS_DIR)) return [];
  return readdirSync(TEAMS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(TEAMS_DIR, d.name, 'team.json')))
    .map((d) => d.name)
    .sort()
    .map(loadTeam);
}

export function getTeam(id: string): Team | undefined {
  return loadTeams().find((t) => t.id === id);
}

const KINDS: RoleKind[] = ['lead', 'architect', 'bug', 'tester', 'designer', 'app'];
const PERMISSIONS = ['auto', 'manual', 'acceptEdits', 'default'];

/** Edited from the office: writes the role file back, front matter and prompt. */
export function saveRole(teamId: string, roleId: string, input: Partial<Role>): Role {
  const team = getTeam(teamId);
  const current = team?.roles.find((r) => r.id === roleId);
  if (!team || !current) throw new Error('rollen finns inte');
  const next: Role = { ...current, ...input, id: current.id };
  next.repos = Array.isArray(next.repos) ? next.repos.filter((r) => team.repos.some((x) => x.id === r)) : current.repos;
  next.mcp = next.mcp === 'all' ? 'all' : Array.isArray(next.mcp) ? next.mcp.filter((m) => typeof m === 'string' && /^[\w.-]+$/.test(m)) : [];
  if (!KINDS.includes(next.kind)) throw new Error(`okänd kind ${next.kind}`);
  if (!PERMISSIONS.includes(next.permission)) throw new Error(`okänd permission ${next.permission}`);
  const clean = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();
  if (!clean(next.name) || !clean(next.model)) throw new Error('namn och modell krävs');
  const lines = [
    `name: ${clean(next.name)}`,
    `kind: ${next.kind}`,
    next.vibe ? `vibe: ${clean(next.vibe)}` : '',
    next.look ? `look: ${clean(next.look)}` : '',
    next.character ? `character: ${clean(next.character)}` : '',
    `title: ${clean(next.title)}`,
    `model: ${clean(next.model)}`,
    next.wakeModel ? `wakeModel: ${clean(next.wakeModel)}` : '',
    next.context ? `context: ${next.context}` : '',
    next.effort ? `effort: ${clean(next.effort)}` : '',
    next.mcp === 'all' ? 'mcp: all' : next.mcp.length ? `mcp: ${next.mcp.map(clean).filter(Boolean).join(', ')}` : '',
    next.owns.length ? `owns: ${next.owns.map(clean).filter(Boolean).join(', ')}` : '',
    next.repos.length ? `repo: ${next.repos.map(clean).filter(Boolean).join(', ')}` : '',
    `worktree: ${next.worktree ? 'true' : 'false'}`,
    next.permission !== 'auto' ? `permission: ${next.permission}` : '',
  ].filter(Boolean);
  writeFileSync(join(TEAMS_DIR, teamId, 'roles', `${roleId}.md`), `---\n${lines.join('\n')}\n---\n${next.prompt.trim()}\n`);
  return getTeam(teamId)!.roles.find((r) => r.id === roleId)!;
}

export function saveTeamPrompt(teamId: string, text: string) {
  if (!getTeam(teamId)) throw new Error('teamet finns inte');
  writeFileSync(join(TEAMS_DIR, teamId, 'shared.md'), `${text.trim()}\n`);
}

// ---------------------------------------------------------------- notes

/**
 * What a role has learned in this repo: build commands, pitfalls, where things
 * are. Put in every new card's prompt, so a card does not start from nothing.
 * teams/<id>/notes/<role>.md; agents add to it with save_note.
 */
const NOTES_MAX = 6000;

export function notesPath(teamId: string, roleId: string) {
  return join(TEAMS_DIR, teamId, 'notes', `${roleId}.md`);
}

export function readNotes(teamId: string, roleId: string): string {
  const text = read(notesPath(teamId, roleId));
  // The newest lines matter most; an overgrown file is cut from the top.
  return text.length > NOTES_MAX ? `…\n${text.slice(-NOTES_MAX)}` : text;
}

/** The whole notes file, to read and edit in the agent's settings. */
export function rawNotes(teamId: string, roleId: string): string {
  return read(notesPath(teamId, roleId));
}

/** Notes as edited by hand: empty removes the file. */
export function saveNotes(teamId: string, roleId: string, text: string) {
  if (!/^[\w-]+$/.test(teamId) || !/^[\w-]+$/.test(roleId) || !existsSync(join(TEAMS_DIR, teamId, 'roles', `${roleId}.md`))) throw new Error('rollen finns inte');
  const path = notesPath(teamId, roleId);
  const clean = text.trim();
  if (!clean) {
    if (existsSync(path)) rmSync(path);
    return;
  }
  mkdirSync(join(TEAMS_DIR, teamId, 'notes'), { recursive: true });
  writeFileSync(path, `${clean}\n`);
}

export function appendNote(teamId: string, roleId: string, note: string, cardId: number) {
  const path = notesPath(teamId, roleId);
  mkdirSync(join(TEAMS_DIR, teamId, 'notes'), { recursive: true });
  const line = `- ${note.replace(/\s*\n\s*/g, ' ').trim()} (kort ${cardId}, ${new Date().toISOString().slice(0, 10)})\n`;
  writeFileSync(path, (existsSync(path) ? readFileSync(path, 'utf8') : `# Anteckningar för ${roleId}\n\n`) + line);
}

/**
 * The settings from before the list (fixed forms for Google, Cloudflare, Expo,
 * the Azure portal and the monitors), read as items until the list is saved.
 */
function legacyInfraItems(config: { infra?: InfraConfig; monitors?: MonitorConfig; azurePortalConfigDir?: string; azureConfigDir?: string }): InfraItem[] {
  const items: InfraItem[] = [];
  const { google, cloudflare, expo } = config.infra ?? {};
  const m = config.monitors ?? {};
  const portal = config.azurePortalConfigDir;
  if (google?.projects?.length) {
    const acct = google.account ? ['--account', google.account] : [];
    items.push({
      id: 'google',
      title: 'Firebase / Google Cloud',
      kind: 'google',
      facts: { projekt: google.projects.join(', '), ...(google.account ? { konto: google.account } : {}) },
      notes: `Ange alltid projekt och konto: firebase${google.account ? ` --account ${google.account}` : ''} --project ${google.projects[0]} …`,
      env: { ...(google.account ? { CLOUDSDK_CORE_ACCOUNT: google.account } : {}), CLOUDSDK_CORE_PROJECT: google.projects[0] },
      login: { steps: [['firebase', 'login:add', ...(google.account ? [google.account] : [])], ['gcloud', 'auth', 'login', ...(google.account ? [google.account] : [])]] },
      check: { command: ['firebase', 'projects:list', '--json', ...acct] },
    });
  }
  if (cloudflare && (cloudflare.accountId || cloudflare.tokenKeychain)) {
    items.push({
      id: 'cloudflare',
      title: 'Cloudflare',
      kind: 'cloudflare',
      facts: cloudflare.accountId ? { konto: cloudflare.accountId } : {},
      notes: 'wrangler läser kontot och token ur miljön; kör inte wrangler login.',
      env: { ...(cloudflare.accountId ? { CLOUDFLARE_ACCOUNT_ID: cloudflare.accountId } : {}), ...(cloudflare.tokenKeychain ? { CLOUDFLARE_API_TOKEN: `secret:${cloudflare.tokenKeychain}` } : {}) },
      login: cloudflare.tokenKeychain ? { url: 'https://dash.cloudflare.com/profile/api-tokens', secret: cloudflare.tokenKeychain } : undefined,
    });
  }
  if (expo) {
    items.push({
      id: 'expo',
      title: 'Expo / EAS',
      kind: 'expo',
      facts: expo.owner ? { ägare: expo.owner } : {},
      env: expo.tokenKeychain ? { EXPO_TOKEN: `secret:${expo.tokenKeychain}` } : undefined,
      login: expo.tokenKeychain ? { url: 'https://expo.dev/settings/access-tokens', secret: expo.tokenKeychain } : { steps: [['eas', 'login']] },
      check: { command: ['eas', 'whoami'] },
    });
  }
  if (portal) {
    items.push({
      id: 'azure-portal',
      title: 'Azure-portalen',
      kind: 'azure',
      facts: { 'az-profil': portal },
      notes: 'Portalens resurser (App Insights, databaser) är en annan inloggning än DevOps: kör de kommandona med AZURE_CONFIG_DIR="$AZURE_PORTAL_CONFIG_DIR" az …',
      env: { AZURE_PORTAL_CONFIG_DIR: portal },
      login: { env: { AZURE_CONFIG_DIR: portal }, steps: [['az', 'login']] },
      check: { env: { AZURE_CONFIG_DIR: portal }, command: ['az', 'account', 'show'] },
    });
  }
  if (m.sentry) items.push({ id: 'sentry', title: 'Sentry', kind: 'sentry', facts: { organisation: m.sentry.org, projekt: m.sentry.project }, monitor: { type: 'sentry', ...m.sentry } });
  if (m.appInsights) {
    const ai = m.appInsights;
    items.push({
      id: 'appinsights',
      title: `Application Insights${ai.name ? ` ${ai.name}` : ''}`,
      kind: 'appinsights',
      facts: { 'app-id': ai.appId, prenumeration: ai.subscription, ...(ai.name ? { namn: ai.name } : {}) },
      notes: `az:s standardprenumeration är inte den: ange alltid --subscription ${ai.subscription}, t.ex. az monitor app-insights query --app ${ai.appId} --subscription ${ai.subscription} --analytics-query '<KQL>'.`,
      monitor: { type: 'appInsights', appId: ai.appId, subscription: ai.subscription, ...(portal ?? config.azureConfigDir ? { azureConfigDir: portal ?? config.azureConfigDir } : {}) },
    });
  }
  if (m.googleLogging) items.push({ id: 'cloud-logging', title: 'Google Cloud Logging', kind: 'google', facts: { projekt: m.googleLogging.project }, monitor: { type: 'googleLogging', project: m.googleLogging.project, ...(google?.account ? { account: google.account } : {}) } });
  return items;
}
