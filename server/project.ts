import { execFileSync } from './proc.ts';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { APP_ROOT, TEAMS_DIR } from './config.ts';
import { cleanCap } from './limits.ts';
import { getAccount } from './accounts.ts';
import { listSubtasks } from './db.ts';
import { generateImage } from './images.ts';
import { cleanPeople, getTeam, parseRole, type DevApp, type InfraConfig, type InfraItem, type MonitorConfig, type Role } from './roles.ts';

/**
 * What a project is set up from: role templates and skills in library/, and
 * what can be changed on a project after it exists (agents, skills, logo,
 * account). Everything is written to the team's files, as by hand.
 */

const LIBRARY = join(APP_ROOT, 'library');
export const AVATARS_DIR = join(APP_ROOT, 'web/public/avatars');

// ---------------------------------------------------------------- role templates

export interface RoleTemplate extends Role {
  /** Signals from the repo scan it is suggested for: always, web, ios, small … */
  suggestWhen: string[];
}

export function listTemplates(): RoleTemplate[] {
  const dir = join(LIBRARY, 'roles');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const source = readFileSync(join(dir, f), 'utf8');
      const role = parseRole(f.slice(0, -3), source);
      const suggest = /^suggestWhen:\s*(.*)$/m.exec(source)?.[1] ?? '';
      return { ...role, suggestWhen: suggest.split(',').map((s) => s.trim()).filter(Boolean) };
    });
}

/** A role file from a template; the template's own front matter, minus what only the library uses. */
function roleSource(templateId: string, over: { name?: string; owns?: string[]; model?: string; mcp?: 'all' | string[]; repos?: string[] }): string {
  const source = readFileSync(join(LIBRARY, 'roles', `${templateId}.md`), 'utf8').replace(/\r\n/g, '\n');
  const parts = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  if (!parts) throw new Error(`Role template ${templateId}.md has no front matter (expected --- ... --- at the top)`);
  const [, head, body] = parts;
  const lines = head.split('\n').filter((l) => !l.startsWith('suggestWhen:'));
  const set = (key: string, value: string | null) => {
    const i = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (value == null || value === '') {
      if (i >= 0) lines.splice(i, 1);
    } else if (i >= 0) lines[i] = `${key}: ${value}`;
    else lines.push(`${key}: ${value}`);
  };
  if (over.name) set('name', over.name.replace(/[\r\n]+/g, ' ').trim());
  if (over.model) set('model', over.model);
  if (over.owns) set('owns', over.owns.join(', '));
  if (over.mcp) set('mcp', over.mcp === 'all' ? 'all' : over.mcp.join(', '));
  if (over.repos?.length) set('repo', over.repos.join(', '));
  return `---\n${lines.join('\n')}\n---\n${body.trim()}\n`;
}

/** A free id in the team: the template's, or with a number after. */
function freeRoleId(teamDir: string, base: string): string {
  let id = base;
  for (let n = 2; existsSync(join(teamDir, 'roles', `${id}.md`)); n++) id = `${base}-${n}`;
  return id;
}

/** The template's portrait, until one of its own is made with scripts/avatars.mjs. */
function copyAvatar(teamId: string, roleId: string, templateId: string) {
  const from = join(LIBRARY, 'avatars', `${templateId}.png`);
  const to = join(AVATARS_DIR, `${teamId}-${roleId}.png`);
  if (existsSync(from) && !existsSync(to)) cpSync(from, to);
}

export function addRoleFromTemplate(
  teamId: string,
  templateId: string,
  over: { id?: string; name?: string; owns?: string[]; model?: string; mcp?: 'all' | string[]; repos?: string[] } = {},
): string {
  const dir = join(TEAMS_DIR, teamId);
  if (!existsSync(join(dir, 'team.json'))) throw new Error('teamet finns inte');
  if (!/^[\w-]+$/.test(templateId) || !existsSync(join(LIBRARY, 'roles', `${templateId}.md`))) throw new Error(`mallen ${templateId} finns inte`);
  const id = freeRoleId(dir, (over.id ?? templateId).toLowerCase().replace(/[^\w-]+/g, '-'));
  mkdirSync(join(dir, 'roles'), { recursive: true });
  writeFileSync(join(dir, 'roles', `${id}.md`), roleSource(templateId, over));
  copyAvatar(teamId, id, templateId);
  return id;
}

/** Cards that still need the role: it cannot go while they are open. */
const OPEN = new Set(['queued', 'running', 'watching', 'quota', 'needs-you', 'pr-open', 'testing']);

/**
 * Takes an agent off the team. Its file goes to roles/.removed/, so it can be
 * brought back; its notes stay.
 */
export function removeRole(teamId: string, roleId: string) {
  const team = getTeam(teamId);
  const role = team?.roles.find((r) => r.id === roleId);
  if (!team || !role) throw new Error('rollen finns inte');
  if (role.kind === 'lead' && team.roles.filter((r) => r.kind === 'lead').length === 1) throw new Error('teamet behöver en teamleader');
  const open = listSubtasks().filter((s) => s.team === teamId && s.agent === roleId && OPEN.has(s.status));
  if (open.length) throw new Error(`${role.name} har ${open.length} kort som inte är klara (${open.map((s) => `#${s.id}`).join(', ')}). Avsluta dem först.`);
  const removed = join(TEAMS_DIR, teamId, 'roles', '.removed');
  mkdirSync(removed, { recursive: true });
  renameSync(join(TEAMS_DIR, teamId, 'roles', `${roleId}.md`), join(removed, `${roleId}-${Date.now()}.md`));
}

// ---------------------------------------------------------------- skills

export interface LibrarySkill {
  id: string;
  label: string;
  description: string;
  suggestWhen: string[];
}

const frontValue = (source: string, key: string) => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(source)?.[1]?.trim() ?? '';

export function librarySkills(): LibrarySkill[] {
  const dir = join(LIBRARY, 'skills');
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Record<string, { label?: string; suggestWhen?: string[] }>;
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')))
    .map((d) => {
      const source = readFileSync(join(dir, d.name, 'SKILL.md'), 'utf8');
      return {
        id: d.name,
        label: index[d.name]?.label ?? d.name,
        description: frontValue(source, 'description'),
        suggestWhen: index[d.name]?.suggestWhen ?? [],
      };
    });
}

export interface RepoSkill {
  id: string;
  description: string;
  /** Checked in: every clone and worktree has it. Otherwise local to this Mac. */
  tracked: boolean;
  /** Copied from the control room's library. */
  fromLibrary: boolean;
}

function tracked(repo: string, path: string): boolean {
  try {
    return execFileSync('git', ['ls-files', path], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
  } catch {
    return false;
  }
}

/** The skills the repo has in .claude/skills, checked in or only here. */
export function repoSkills(repo: string): RepoSkill[] {
  const dir = join(repo, '.claude/skills');
  if (!existsSync(dir)) return [];
  const lib = new Set(librarySkills().map((s) => s.id));
  return readdirSync(dir)
    .filter((n) => existsSync(join(dir, n, 'SKILL.md')))
    .map((n) => ({
      id: n,
      description: frontValue(readFileSync(join(dir, n, 'SKILL.md'), 'utf8'), 'description'),
      tracked: tracked(repo, `.claude/skills/${n}`),
      fromLibrary: lib.has(n),
    }));
}

/** The repo's own ignore list that is never committed: .git/info/exclude, shared by its worktrees. */
function excludeFile(repo: string): string {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();
  return join(isAbsolute(common) ? common : join(repo, common), 'info', 'exclude');
}

export function setExcluded(repo: string, line: string, on: boolean) {
  // A folder holding several repos is not one itself: nothing to keep out of git there.
  if (!existsSync(join(repo, '.git'))) return;
  const file = excludeFile(repo);
  mkdirSync(join(file, '..'), { recursive: true });
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  const has = lines.includes(line);
  if (on && !has) writeFileSync(file, `${[...lines.filter((l, i) => l || i < lines.length - 1), line].join('\n')}\n`);
  if (!on && has) writeFileSync(file, `${lines.filter((l) => l !== line).join('\n').replace(/\n+$/, '')}\n`);
}

/**
 * A library skill for this Mac only: copied into the repo's .claude/skills and
 * kept out of git with .git/info/exclude. Worktrees get it through a link
 * (worktree.ts), since an untracked folder is not in them.
 */
export function installLocalSkill(repo: string, skillId: string) {
  if (!/^[\w-]+$/.test(skillId) || !existsSync(join(LIBRARY, 'skills', skillId, 'SKILL.md'))) throw new Error(`skillen ${skillId} finns inte i biblioteket`);
  const target = join(repo, '.claude/skills', skillId);
  if (existsSync(target)) throw new Error(`repot har redan en skill som heter ${skillId}`);
  mkdirSync(join(repo, '.claude/skills'), { recursive: true });
  cpSync(join(LIBRARY, 'skills', skillId), target, { recursive: true });
  setExcluded(repo, `/.claude/skills/${skillId}`, true);
}

/** Only a local skill: a checked-in one is removed in a PR, like any other file. */
export function removeLocalSkill(repo: string, skillId: string) {
  if (!/^[\w-]+$/.test(skillId)) throw new Error('ogiltigt namn');
  if (tracked(repo, `.claude/skills/${skillId}`)) throw new Error('skillen är incheckad; ta bort den i en PR');
  rmSync(join(repo, '.claude/skills', skillId), { recursive: true, force: true });
  setExcluded(repo, `/.claude/skills/${skillId}`, false);
}

/** Where a library skill is, for an agent asked to check it in. */
export const librarySkillPath = (skillId: string) => join(LIBRARY, 'skills', skillId);

// ---------------------------------------------------------------- logo

const LOGO_TYPES: Record<string, string> = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

export function logoPath(teamId: string): string | null {
  const dir = join(TEAMS_DIR, teamId);
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => f.startsWith('logo.') && LOGO_TYPES[extname(f)]);
  return file ? join(dir, file) : null;
}

export const logoType = (path: string) => LOGO_TYPES[extname(path)] ?? 'application/octet-stream';

export function saveLogo(teamId: string, name: string, base64: string) {
  const ext = extname(name).toLowerCase();
  if (!LOGO_TYPES[ext]) throw new Error('loggan måste vara png, svg, jpg eller webp');
  const data = Buffer.from(base64, 'base64');
  if (data.length > 2 * 1024 * 1024) throw new Error('loggan får vara högst 2 MB');
  const old = logoPath(teamId);
  if (old) rmSync(old);
  writeFileSync(join(TEAMS_DIR, teamId, `logo${ext === '.jpeg' ? '.jpg' : ext}`), data);
}

export function removeLogo(teamId: string) {
  const old = logoPath(teamId);
  if (old) rmSync(old);
}

/** A logo from a short description, with OpenAI (no project or personal details go in the prompt). */
export async function generateLogo(teamId: string, description: string) {
  const image = await generateImage({
    team: teamId,
    name: 'logo',
    prompt: `A simple, modern app icon logo: ${description}. Flat, bold shapes, centered on a plain background, no text, no letters.`,
  });
  const old = logoPath(teamId);
  if (old) rmSync(old);
  cpSync(image.path, join(TEAMS_DIR, teamId, 'logo.png'));
}

// ---------------------------------------------------------------- team settings

function readJsonFile(path: string): Record<string, any> {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

const writeJsonFile = (path: string, data: unknown) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);

/**
 * The project's own settings: shared ones in team.json, this Mac's in
 * team.local.json (account, repo).
 */
export function saveTeamSettings(
  teamId: string,
  input: {
    name?: string;
    /** #rrggbb; empty: one made from the id. */
    color?: string;
    baseBranch?: string;
    account?: string;
    azureConfigDir?: string | null;
    azurePortalConfigDir?: string | null;
    infra?: unknown;
    monitors?: unknown;
    /** The infrastructure list, already checked (infra.ts cleanItems). It replaces the old forms. */
    infraItems?: InfraItem[];
    monitorEveryMinutes?: number;
    disabledSkills?: string[];
    /** Most agents at once for this project; null or 0: no limit. */
    maxAgents?: number | null;
    people?: unknown;
    /** The local development environments, already checked (roles.ts cleanDevApps). */
    devApps?: DevApp[];
  },
) {
  const dir = join(TEAMS_DIR, teamId);
  if (!existsSync(join(dir, 'team.json'))) throw new Error('teamet finns inte');
  const shared = readJsonFile(join(dir, 'team.json'));
  const local = readJsonFile(join(dir, 'team.local.json'));
  if (typeof input.name === 'string' && input.name.trim()) shared.name = input.name.trim();
  if (typeof input.color === 'string') {
    if (/^#[0-9a-f]{6}$/i.test(input.color)) shared.color = input.color.toLowerCase();
    else delete shared.color;
  }
  if (typeof input.baseBranch === 'string' && /^[\w./-]+$/.test(input.baseBranch.trim())) shared.baseBranch = input.baseBranch.trim();
  if (typeof input.account === 'string') {
    const account = getAccount(input.account);
    if (account.id !== input.account) throw new Error('kontot finns inte');
    local.account = account.id;
  }
  if (Array.isArray(input.disabledSkills)) {
    const list = [...new Set(input.disabledSkills.filter((x) => typeof x === 'string' && /^[\w.-]+$/.test(x)))];
    if (list.length) shared.disabledSkills = list;
    else delete shared.disabledSkills;
  }
  if (input.maxAgents !== undefined) {
    const cap = cleanCap(input.maxAgents);
    if (cap !== null) local.maxAgents = cap;
    else delete local.maxAgents;
  }
  // The people in the project are everyone's: team.json.
  if (input.people !== undefined) {
    const people = cleanPeople(input.people);
    if (people.length) shared.people = people;
    else delete shared.people;
  }
  if (input.azureConfigDir !== undefined) {
    const v = input.azureConfigDir?.trim();
    if (v) local.azureConfigDir = v;
    else delete local.azureConfigDir;
  }
  if (input.azurePortalConfigDir !== undefined) {
    const v = input.azurePortalConfigDir?.trim();
    if (v) local.azurePortalConfigDir = v;
    else delete local.azurePortalConfigDir;
  }
  // Infrastructure and monitors are this Mac's logins and ids: team.local.json.
  if (input.infra !== undefined) {
    const infra = cleanInfra(input.infra);
    if (Object.keys(infra).length) local.infra = infra;
    else delete local.infra;
  }
  if (input.monitors !== undefined) {
    const monitors = cleanMonitors(input.monitors);
    if (Object.keys(monitors).length) local.monitors = monitors;
    else delete local.monitors;
  }
  if (input.infraItems !== undefined) {
    local.infraItems = input.infraItems;
    // The list holds what the old forms did: they go, the check interval stays.
    delete local.infra;
    delete local.azurePortalConfigDir;
    const every = (local.monitors as MonitorConfig | undefined)?.everyMinutes;
    if (every) local.monitors = { everyMinutes: every };
    else delete local.monitors;
  }
  if (input.monitorEveryMinutes !== undefined) {
    const every = Math.round(Number(input.monitorEveryMinutes));
    const monitors = (local.monitors ?? {}) as Record<string, unknown>;
    if (Number.isFinite(every) && every >= 5 && every !== 30) monitors.everyMinutes = every;
    else delete monitors.everyMinutes;
    if (Object.keys(monitors).length) local.monitors = monitors;
    else delete local.monitors;
  }
  // How the apps start is this Mac's: paths, ports, scripts in run/.
  if (input.devApps !== undefined) {
    if (input.devApps.length) local.devApps = input.devApps;
    else delete local.devApps;
  }
  writeJsonFile(join(dir, 'team.json'), shared);
  writeJsonFile(join(dir, 'team.local.json'), local);
}

export { readJsonFile, writeJsonFile };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Infra as the settings page sends it: empty fields dropped, ids checked. */
function cleanInfra(raw: unknown): InfraConfig {
  const r = (raw ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const out: InfraConfig = {};
  const projects = (Array.isArray(r.google?.projects) ? r.google!.projects : []).map(str).filter(Boolean);
  if (projects.some((p) => !/^[a-z][a-z0-9-]{4,29}$/.test(p))) throw new Error('Ett Firebase/Google-projekt-id är 6–30 tecken: små bokstäver, siffror och bindestreck');
  if (projects.length) out.google = { projects, ...(str(r.google?.account) ? { account: str(r.google?.account) } : {}) };
  const cfAccount = str(r.cloudflare?.accountId);
  const cfToken = str(r.cloudflare?.tokenKeychain);
  if (cfAccount && !/^[0-9a-f]{32}$/i.test(cfAccount)) throw new Error('Cloudflares konto-id är 32 hextecken (står i dashboardens sidopanel)');
  if (cfAccount || cfToken) out.cloudflare = { ...(cfAccount ? { accountId: cfAccount } : {}), ...(cfToken ? { tokenKeychain: cfToken } : {}) };
  const owner = str(r.expo?.owner);
  const exToken = str(r.expo?.tokenKeychain);
  if (r.expo && (owner || exToken || r.expo.on)) out.expo = { ...(owner ? { owner } : {}), ...(exToken ? { tokenKeychain: exToken } : {}) };
  return out;
}

/** Monitors as the settings page sends them. */
function cleanMonitors(raw: unknown): MonitorConfig {
  const r = (raw ?? {}) as Record<string, Record<string, unknown> | number | undefined>;
  const out: MonitorConfig = {};
  const s = r.sentry as Record<string, unknown> | undefined;
  if (str(s?.org) || str(s?.project)) {
    if (!str(s?.org) || !str(s?.project)) throw new Error('Sentry behöver både organisation och projekt');
    out.sentry = { org: str(s?.org), project: str(s?.project) };
  }
  const ai = r.appInsights as Record<string, unknown> | undefined;
  if (str(ai?.appId) || str(ai?.subscription)) {
    if (!GUID.test(str(ai?.appId))) throw new Error('App Insights app-id ska vara ett GUID (API Access i Azure-portalen)');
    if (!GUID.test(str(ai?.subscription))) throw new Error('Prenumerationen ska vara ett GUID');
    out.appInsights = { appId: str(ai?.appId), subscription: str(ai?.subscription), ...(str(ai?.name) ? { name: str(ai?.name) } : {}) };
  }
  const gl = r.googleLogging as Record<string, unknown> | undefined;
  if (str(gl?.project)) out.googleLogging = { project: str(gl?.project) };
  const every = Number(r.everyMinutes);
  if (Number.isFinite(every) && every >= 5 && every !== 30) out.everyMinutes = Math.round(every);
  return out;
}

// ---------------------------------------------------------------- a new project

export type RepoSource =
  | { kind: 'existing'; path: string }
  | { kind: 'clone'; url: string; into: string }
  | { kind: 'new'; host: 'github' | 'azure'; owner: string; project?: string; name: string; private: boolean; into: string };

export interface NewProject {
  name: string;
  source: RepoSource;
  account: string;
  baseBranch?: string;
  roles: { template: string; name?: string; owns?: string[]; mcp?: 'all' | string[]; repos?: string[] }[];
  /** A folder of several repos: the ones that belong to the project, by id (path under the folder). */
  repos?: string[];
  /** Base branch per repo id, where the guide changed it. */
  baseBranches?: Record<string, string>;
  skills: { id: string; mode: 'local' | 'commit' }[];
  teamPrompt?: string;
  logo?: { name: string; data: string } | { generate: string };
  /** A first card that writes CLAUDE.md and checks in the chosen skills. */
  onboarding: boolean;
  /** Its own az profile for Azure DevOps (AZURE_CONFIG_DIR). */
  azureConfigDir?: string | null;
  /** Skills and commands the repos already have that the agents should not use. */
  disabledSkills?: string[];
}

const slugId = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30) || 'projekt';

/** Where the repo ends up: as it is, cloned, or created on GitHub or Azure DevOps and cloned. */
async function prepareRepo(source: RepoSource, account: string): Promise<string> {
  const { expandHome } = await import('./config.ts');
  const { accountEnv } = await import('./accounts.ts');
  const { provider } = await import('./git.ts');
  const env = accountEnv(account);
  if (source.kind === 'existing') {
    const path = expandHome(source.path.trim());
    if (!existsSync(path)) throw new Error(`${path} finns inte`);
    return path;
  }
  let url: string;
  let folder: string;
  if (source.kind === 'clone') {
    url = source.url.trim();
    folder = (/([^/:]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? 'repo').replace(/[^\w.-]+/g, '-');
  } else {
    const host = provider(source.host)!;
    url = await host.createRepo({ name: source.name, owner: source.owner, project: source.project, private: source.private }, account);
    folder = source.name;
  }
  const into = expandHome(source.into.trim() || '~/Dev');
  mkdirSync(into, { recursive: true });
  const path = join(into, folder);
  if (existsSync(path)) throw new Error(`${path} finns redan`);
  execFileSync('git', ['clone', url, path], { env, stdio: 'ignore' });
  // A just-created repo may have no commits on the base branch locally; fetch what there is.
  execFileSync('git', ['fetch', 'origin', '--quiet'], { cwd: path, env, stdio: 'ignore' });
  return path;
}

export async function createProject(input: NewProject): Promise<{ teamId: string; repo: string; card: number | null }> {
  const name = input.name?.trim();
  if (!name) throw new Error('ge projektet ett namn');
  if (!input.roles.some((r) => r.template === 'teamleader')) throw new Error('teamet behöver en teamleader');
  const account = getAccount(input.account).id;
  let id = slugId(name);
  for (let n = 2; existsSync(join(TEAMS_DIR, id)); n++) id = `${slugId(name)}-${n}`;

  const repo = await prepareRepo(input.source, account);
  const { scanRepo } = await import('./scan.ts');
  const scan = scanRepo(repo);
  // A folder of several: the chosen repos (all but second clones, unless told).
  const many = !scan.isGit && scan.repos.length > 0;
  const chosen = many ? scan.repos.filter((r) => (input.repos ? input.repos.includes(r.id) : !r.duplicateOf)) : [];
  if (!scan.isGit && !chosen.length) throw new Error(`${repo} är inget git-repo och har inga repon under sig`);

  const dir = join(TEAMS_DIR, id);
  mkdirSync(join(dir, 'roles'), { recursive: true });
  try {
    const disabled = (input.disabledSkills ?? []).filter((x) => /^[\w.-]+$/.test(x));
    writeJsonFile(join(dir, 'team.json'), { name, baseBranch: input.baseBranch?.trim() || scan.baseBranch, ...(disabled.length ? { disabledSkills: disabled } : {}) });
    const az = input.azureConfigDir?.trim() ? { azureConfigDir: input.azureConfigDir.trim() } : {};
    // Each repo's base branch written out, so a later change of origin/HEAD does not move it.
    const bases = Object.fromEntries(chosen.map((r) => [r.id, input.baseBranches?.[r.id]?.trim() || r.baseBranch]));
    writeJsonFile(
      join(dir, 'team.local.json'),
      many ? { repo, repos: Object.fromEntries(chosen.map((r) => [r.id, r.id])), baseBranches: bases, account, ...az } : { repo, account, ...az },
    );
    writeFileSync(join(dir, 'shared.md'), `${(input.teamPrompt ?? `## ${name}\n`).trim()}\n`);
    const ids = new Set(chosen.map((r) => r.id));
    for (const r of input.roles) addRoleFromTemplate(id, r.template, { name: r.name, owns: r.owns, mcp: r.mcp, repos: many ? (r.repos ?? []).filter((x) => ids.has(x)) : undefined });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  // Worktrees stay out of each repo's git status.
  for (const r of many ? chosen.map((c) => c.path) : [repo]) setExcluded(r, '/.claude/worktrees/', true);
  // Local skills go in the project's folder: worktrees in each repo link them (worktree.ts).
  for (const s of input.skills.filter((s) => s.mode === 'local')) {
    try {
      installLocalSkill(repo, s.id);
    } catch {
      // Already there: nothing to add.
    }
  }
  if (input.logo) {
    if ('generate' in input.logo) await generateLogo(id, input.logo.generate).catch(() => undefined);
    else saveLogo(id, input.logo.name, input.logo.data);
  }

  const committed = input.skills.filter((s) => s.mode === 'commit').map((s) => s.id);
  let card: number | null = null;
  if (input.onboarding && (!scan.claudeMd || committed.length)) {
    const { submitTask } = await import('./actions.ts');
    const text = [
      `Läs in er på ${name}: ett nytt projekt i kontrollrummet. Gör det som ett enda kort till den agent som äger mest av repot (eller dokumentationsagenten om teamet har en), och avsluta med en PR.`,
      many
        ? `Projektet är flera repon i ${repo}: ${chosen.map((c) => c.id).join(', ')}. Varje ändring görs i sitt repo, en PR per repo.`
        : '',
      !scan.claudeMd
        ? `- Skriv \`CLAUDE.md\` ${many ? 'i varje repo som saknar en' : 'i roten'}: vad det är, hur det byggs, testas och körs lokalt (kommandon som faktiskt fungerar), var saker ligger, och regler som inte syns i koden. Kort: den läses av varje agent vid varje kort.`
        : '',
      ...committed.map((s) => `- Lägg in skillen \`${s}\`${many ? ' i varje repo' : ''}: kopiera mappen ${librarySkillPath(s)} till \`.claude/skills/${s}/\`.`),
      '- Spara det varje roll behöver veta om repot (byggkommandon, fallgropar) med save_note.',
    ]
      .filter(Boolean)
      .join('\n');
    card = submitTask(id, text).subtask.id;
  }
  return { teamId: id, repo, card };
}
