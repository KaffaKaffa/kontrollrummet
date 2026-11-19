import { execFileSync } from './proc.ts';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { expandHome } from './config.ts';
import { librarySkills, listTemplates, repoSkills, type RepoSkill } from './project.ts';

/**
 * Reads a repo and says what the project looks like: where it is hosted, what
 * apps it has, what it already brings (CLAUDE.md, skills, .mcp.json), and from
 * that which agents, skills and checks to suggest. No model, no tokens: files
 * and git only.
 */

export type GitHost = 'github' | 'azure' | 'none';

export interface Scan {
  path: string;
  exists: boolean;
  isGit: boolean;
  /** Folder name, as a suggestion for the project's name. */
  name: string;
  remote: string | null;
  host: GitHost;
  baseBranch: string;
  /** What was found, in words, for the guide to show. */
  found: string[];
  /** web, backend, ios, android, mac, windows, infra, docs, tests, small: what the templates are suggested by. */
  signals: string[];
  /** Folders per signal, for the agents' `owns`. */
  owns: Record<string, string[]>;
  claudeMd: boolean;
  agentsMd: boolean;
  skills: RepoSkill[];
  /** Servers in the repo's .mcp.json. */
  mcpJson: string[];
  /** CLIs the stack needs, checked by checks.ts. */
  tools: string[];
  suggested: {
    /** repos: for a folder of several, the repo ids the agent works in, its own first. */
    roles: { template: string; owns: string[]; repos?: string[] }[];
    skills: string[];
  };
  /** A folder of several repos: each one, as read on its own. Empty for a single checkout. */
  repos: ScanRepo[];
  /** What the project already has: skills, commands and instruction files, in the folder and each repo. */
  existing: Existing;
  /** The az profile the project's own Claude settings already point at (env AZURE_CONFIG_DIR), if any. */
  azureConfigDir: string | null;
}

/** AZURE_CONFIG_DIR from a folder's .claude/settings(.local).json env. */
function azureDirIn(dir: string): string | null {
  for (const f of ['.claude/settings.local.json', '.claude/settings.json']) {
    try {
      const v = JSON.parse(readFileSync(join(dir, f), 'utf8'))?.env?.AZURE_CONFIG_DIR;
      if (typeof v === 'string' && v.trim()) return v.trim();
    } catch {
      // none
    }
  }
  return null;
}

export interface ExistingSkill {
  id: string;
  kind: 'skill' | 'command';
  /** The repo it is in; '' for the project's folder (or the single repo). */
  where: string;
  description: string;
  /** Checked in: every clone has it. Otherwise only on this Mac. */
  tracked: boolean;
}

export interface Instruction {
  file: string;
  where: string;
  /** What Claude Code does with it, in words. */
  note: string;
  tracked: boolean;
}

export interface Existing {
  skills: ExistingSkill[];
  instructions: Instruction[];
}

const INSTRUCTION_FILES: [string, string][] = [
  ['CLAUDE.md', 'Läses av varje agent'],
  ['.claude/CLAUDE.md', 'Läses av varje agent'],
  ['CLAUDE.local.md', 'Läses av varje agent, bara på den här Macen'],
  ['AGENTS.md', 'Läses inte av Claude Code av sig själv; peka på den från CLAUDE.md'],
  ['.claude/settings.json', 'Behörigheter och inställningar för repot'],
  ['.mcp.json', 'MCP-servrar som kan väljas per agent'],
];

/** Skills, commands and instruction files in one folder. */
export function existingIn(dir: string, where: string): Existing {
  const isTracked = (p: string) => git(dir, ['ls-files', p])?.length ? true : false;
  const skills: ExistingSkill[] = [];
  const skillDir = join(dir, '.claude/skills');
  if (existsSync(skillDir)) {
    for (const n of readdirSync(skillDir)) {
      const file = join(skillDir, n, 'SKILL.md');
      if (!existsSync(file)) continue;
      const desc = /^description:\s*(.*)$/m.exec(readFileSync(file, 'utf8'))?.[1]?.trim() ?? '';
      skills.push({ id: n, kind: 'skill', where, description: desc, tracked: isTracked(`.claude/skills/${n}`) });
    }
  }
  const cmdDir = join(dir, '.claude/commands');
  if (existsSync(cmdDir)) {
    for (const f of readdirSync(cmdDir).filter((x) => x.endsWith('.md'))) {
      const text = readFileSync(join(cmdDir, f), 'utf8');
      const desc = /^description:\s*(.*)$/m.exec(text)?.[1]?.trim() ?? text.replace(/^---[\s\S]*?---/, '').trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 140);
      skills.push({ id: f.slice(0, -3), kind: 'command', where, description: desc, tracked: isTracked(`.claude/commands/${f}`) });
    }
  }
  const instructions = INSTRUCTION_FILES.filter(([f]) => existsSync(join(dir, f))).map(([file, note]) => ({ file, where, note, tracked: isTracked(file) }));
  return { skills, instructions };
}

export interface ScanRepo {
  id: string;
  path: string;
  remote: string | null;
  host: GitHost;
  baseBranch: string;
  signals: string[];
  found: string[];
  /** Another checkout of the same remote (a second clone): left out unless chosen. */
  duplicateOf: string | null;
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'Pods', 'DerivedData', '.next', '.expo', 'vendor', 'bin', 'obj', '.claude', 'coverage', 'target', '.venv', 'venv']);

/** Files down to a few levels, skipping build output and dependencies. */
function walk(root: string, depth = 3): string[] {
  const out: string[] = [];
  const go = (dir: string, d: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.github' && e.name !== '.mcp.json')) continue;
      const p = join(dir, e.name);
      out.push(e.isDirectory() ? `${p}/` : p);
      if (e.isDirectory() && d > 0) go(p, d - 1);
    }
  };
  go(root, depth);
  return out;
}

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function hostOf(remote: string | null): GitHost {
  if (!remote) return 'none';
  if (/github\.com[:/]/.test(remote)) return 'github';
  if (/dev\.azure\.com|visualstudio\.com|ssh\.dev\.azure\.com/.test(remote)) return 'azure';
  return 'none';
}

/** Git checkouts directly under a folder (and one level further), by folder. */
function childRepos(root: string): string[] {
  const out: string[] = [];
  const look = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (existsSync(join(p, '.git'))) out.push(p);
      else if (depth > 0) look(p, depth - 1);
    }
  };
  look(root, 1);
  return out.sort();
}

/**
 * Reads a checkout, or a folder that holds several that go together (one
 * product in many repos). For the latter each repo is read on its own, second
 * clones of the same remote are marked, and the agents are suggested per repo.
 */
export function scanRepo(input: string): Scan {
  const path = resolve(expandHome(input.trim()));
  const single = scanSingle(path);
  if (!single.exists || single.isGit) return single;
  const children = childRepos(path);
  if (!children.length) return single;

  const scans = children.map((p) => scanSingle(p));
  // The checkout named like its remote's repo wins over other clones of it.
  const remoteName = (r: string | null) => (r ? (/([^/:]+?)(?:\.git)?\/?$/.exec(r)?.[1] ?? '').toLowerCase() : '');
  const byRemote = new Map<string, Scan>();
  for (const sc of [...scans].sort((a, b) => Number(basename(b.path).toLowerCase() === remoteName(b.remote)) - Number(basename(a.path).toLowerCase() === remoteName(a.remote)) || a.path.length - b.path.length)) {
    if (sc.remote && !byRemote.has(sc.remote)) byRemote.set(sc.remote, sc);
  }
  const repos: ScanRepo[] = scans.map((sc) => {
    const keeper = sc.remote ? byRemote.get(sc.remote) : sc;
    return {
      id: relative(path, sc.path),
      path: sc.path,
      remote: sc.remote,
      host: sc.host,
      baseBranch: sc.baseBranch,
      signals: sc.signals.filter((x) => x !== 'small'),
      found: sc.found,
      duplicateOf: keeper && keeper !== sc ? relative(path, keeper.path) : null,
    };
  });
  const kept = repos.filter((r) => !r.duplicateOf);
  const keptScans = scans.filter((sc) => kept.some((r) => r.path === sc.path));
  const hosts = [...new Set(kept.map((r) => r.host))];
  let mcpJson: string[] = [];
  try {
    mcpJson = Object.keys(JSON.parse(readFileSync(join(path, '.mcp.json'), 'utf8')).mcpServers ?? {});
  } catch {
    // none
  }
  const rootSkills = repoSkills(path);
  return {
    ...single,
    host: hosts.length === 1 ? hosts[0] : hosts.includes('azure') ? 'azure' : hosts.includes('github') ? 'github' : 'none',
    remote: null,
    baseBranch: kept[0]?.baseBranch ?? 'main',
    found: kept.map((r) => `${r.id}: ${r.found.join(', ') || 'inget särskilt'}`),
    signals: [...new Set(kept.flatMap((r) => r.signals))],
    owns: {},
    claudeMd: existsSync(join(path, 'CLAUDE.md')) || existsSync(join(path, '.claude/CLAUDE.md')),
    agentsMd: existsSync(join(path, 'AGENTS.md')),
    skills: rootSkills,
    mcpJson,
    tools: [...new Set(keptScans.flatMap((sc) => sc.tools))],
    suggested: suggestForRepos(kept, rootSkills.map((x) => x.id)),
    repos,
    // The folder's own, then each repo's.
    existing: [existingIn(path, ''), ...kept.map((r) => existingIn(r.path, r.id))].reduce(
      (all, e) => ({ skills: [...all.skills, ...e.skills], instructions: [...all.instructions, ...e.instructions] }),
      { skills: [], instructions: [] } as Existing,
    ),
    azureConfigDir: azureDirIn(path) ?? kept.map((r) => azureDirIn(r.path)).find(Boolean) ?? null,
  };
}

/** Agents for several repos: each app agent gets the repos whose contents match it. */
export function suggestForRepos(repos: Pick<ScanRepo, 'id' | 'signals'>[], existingSkills: string[] = []): Scan['suggested'] {
  const all = new Set(repos.flatMap((r) => r.signals));
  const base = suggest(all, {}, existingSkills);
  const ui = ['web', 'ios', 'android', 'mac', 'windows'];
  const templates = new Map(listTemplates().map((t) => [t.id, t]));
  const roles = base.roles.map((r) => {
    const t = templates.get(r.template)!;
    if (t.kind === 'lead' || t.kind === 'architect' || t.kind === 'bug') return { ...r, owns: [], repos: [] };
    const want = t.kind === 'designer' || t.kind === 'tester' ? ui : t.id === 'fullstack' ? [...ui, 'backend'] : t.suggestWhen;
    const mine = repos.filter((x) => x.signals.some((sig) => want.includes(sig))).map((x) => x.id);
    return { ...r, owns: [], repos: mine.length ? mine : repos.map((x) => x.id) };
  });
  return { roles, skills: base.skills };
}

function scanSingle(path: string): Scan {
  const empty: Scan = {
    path,
    exists: false,
    isGit: false,
    name: basename(path),
    remote: null,
    host: 'none',
    baseBranch: 'main',
    found: [],
    signals: [],
    owns: {},
    claudeMd: false,
    agentsMd: false,
    skills: [],
    mcpJson: [],
    tools: [],
    suggested: { roles: [], skills: [] },
    repos: [],
    existing: { skills: [], instructions: [] },
    azureConfigDir: null,
  };
  if (!existsSync(path) || !statSync(path).isDirectory()) return empty;
  const isGit = git(path, ['rev-parse', '--is-inside-work-tree']) === 'true';
  const remote = isGit ? git(path, ['remote', 'get-url', 'origin']) : null;
  const head = isGit ? git(path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']) : null;
  // GitFlow: work is cut from and merged into develop, whatever origin/HEAD says.
  const develop = isGit && git(path, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/develop']);
  const baseBranch = develop ? 'develop' : head?.replace(/^origin\//, '') || (isGit ? git(path, ['branch', '--show-current']) : null) || 'main';

  const files = walk(path);
  const rel = (p: string) => relative(path, p).replace(/\/$/, '');
  const dirOf = (p: string) => {
    const d = rel(join(p, '..'));
    return d ? `${d}/` : '';
  };
  const signals = new Set<string>();
  const owns: Record<string, Set<string>> = {};
  const found: string[] = [];
  const tools = new Set<string>(['git']);
  const add = (signal: string, dir: string | null, what: string) => {
    signals.add(signal);
    if (dir != null) (owns[signal] ??= new Set()).add(dir);
    if (!found.includes(what)) found.push(what);
  };

  for (const f of files) {
    const name = basename(f.replace(/\/$/, ''));
    // Tests, samples and scripts belong to what they test or serve, not an agent of their own.
    if (/(^|\/)(tests?|samples?|examples?|scripts|tools|mock[\w-]*)\//i.test(rel(f)) || /tests?\.csproj$/i.test(name)) {
      if (/test/i.test(rel(f))) signals.add('tests');
      continue;
    }
    if (name === 'package.json') {
      tools.add('node');
      let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } = {};
      try {
        pkg = JSON.parse(readFileSync(f, 'utf8'));
      } catch {
        continue;
      }
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const has = (...names: string[]) => names.some((n) => n in deps);
      const dir = dirOf(f);
      if (has('react-native', 'expo')) {
        add('ios', dir, `React Native/Expo i ${dir || 'roten'}`);
        add('android', dir, `React Native/Expo i ${dir || 'roten'}`);
      } else if (has('react', 'vue', 'svelte', '@angular/core', 'next', 'vite', 'solid-js', 'astro')) {
        add('web', dir, `Webbapp i ${dir || 'roten'}`);
      }
      if (has('express', 'fastify', '@nestjs/core', 'koa', 'hono', '@hapi/hapi')) add('backend', dir, `Node-backend i ${dir || 'roten'}`);
      if (has('electron', '@tauri-apps/api')) {
        add('mac', dir, `Desktopapp i ${dir || 'roten'}`);
        add('windows', dir, `Desktopapp i ${dir || 'roten'}`);
      }
      if (pkg.scripts?.test || has('vitest', 'jest', '@playwright/test', 'mocha')) signals.add('tests');
    } else if (name.endsWith('.xcodeproj/') || name === 'Package.swift' || name === 'project.yml') {
      tools.add('xcodebuild');
      const dir = dirOf(f);
      const mac = /mac|desktop|osx/i.test(rel(f));
      add(mac ? 'mac' : 'ios', dir, `${mac ? 'Mac' : 'iOS'}-projekt i ${dir || 'roten'}`);
    } else if (name === 'build.gradle' || name === 'build.gradle.kts') {
      if (/android/i.test(rel(f)) || existsSync(join(f, '..', 'src/main/AndroidManifest.xml')) || existsSync(join(f, '..', 'app'))) {
        tools.add('java');
        const dir = dirOf(f);
        add('android', dir, `Android-projekt i ${dir || 'roten'}`);
      }
    } else if (name.endsWith('.csproj')) {
      tools.add('dotnet');
      const dir = dirOf(f);
      const source = readFileSync(f, 'utf8');
      if (/WindowsAppSDK|UseWinUI|UseWPF|UseWindowsForms/.test(source)) add('windows', dir, `Windows-app i ${dir || 'roten'}`);
      else if (/Microsoft\.NET\.Sdk\.Web|AspNetCore/.test(source)) add('backend', dir, `.NET-API i ${dir || 'roten'}`);
      if (/Test/i.test(name)) signals.add('tests');
    } else if (name === 'go.mod') {
      tools.add('go');
      add('backend', dirOf(f), `Go i ${dirOf(f) || 'roten'}`);
    } else if (name === 'pyproject.toml' || name === 'requirements.txt') {
      tools.add('python3');
      add('backend', dirOf(f), `Python i ${dirOf(f) || 'roten'}`);
    } else if (name === 'Cargo.toml') {
      tools.add('cargo');
      add('backend', dirOf(f), `Rust i ${dirOf(f) || 'roten'}`);
    } else if (name === 'pom.xml') {
      tools.add('java');
      add('backend', dirOf(f), `Java i ${dirOf(f) || 'roten'}`);
    } else if (name === 'Dockerfile') {
      tools.add('docker');
      add('infra', `${rel(f)}`, 'Dockerfile');
    } else if (name.endsWith('.bicep') || name.endsWith('.tf')) {
      add('infra', dirOf(f), name.endsWith('.tf') ? 'Terraform' : 'Bicep');
    } else if (f.endsWith('.github/workflows/') || name === 'azure-pipelines.yml') {
      add('infra', rel(f).endsWith('/') ? rel(f) : `${rel(f)}`, name === 'azure-pipelines.yml' ? 'Azure Pipelines' : 'GitHub Actions');
    } else if (f === join(path, 'docs/')) {
      add('docs', 'docs/', 'Dokumentation i docs/');
    }
  }

  // Owned folders as short as they can be: the top folder, or two levels where apps share it (desktop/macos, desktop/windows).
  const top = (d: string) => d.split('/').filter(Boolean)[0] ?? '';
  const topUsers = new Map<string, Set<string>>();
  for (const [signal, dirs] of Object.entries(owns)) for (const d of dirs) topUsers.set(top(d), new Set([...(topUsers.get(top(d)) ?? []), signal]));
  for (const [signal, dirs] of Object.entries(owns)) {
    owns[signal] = new Set(
      [...dirs].map((d) => {
        if (!d.endsWith('/')) return d;
        const parts = d.split('/').filter(Boolean);
        if (!parts.length) return '';
        const shared = (topUsers.get(parts[0])?.size ?? 0) > 1 && !['ios', 'android'].every((k) => topUsers.get(parts[0])?.has(k) && topUsers.get(parts[0])!.size === 2);
        return `${parts.slice(0, shared ? 2 : 1).join('/')}/`;
      }),
    );
  }

  const appKinds = ['web', 'backend', 'ios', 'android', 'mac', 'windows'].filter((s) => signals.has(s));
  // One app, or a web app with its own small backend: one developer is enough to start with.
  if (appKinds.length <= 1 || (appKinds.length === 2 && signals.has('web') && signals.has('backend') && owns.web && owns.backend && [...owns.web].some((d) => owns.backend!.has(d)))) signals.add('small');

  const claudeMd = existsSync(join(path, 'CLAUDE.md')) || existsSync(join(path, '.claude/CLAUDE.md'));
  const agentsMd = existsSync(join(path, 'AGENTS.md'));
  let mcpJson: string[] = [];
  try {
    mcpJson = Object.keys(JSON.parse(readFileSync(join(path, '.mcp.json'), 'utf8')).mcpServers ?? {});
  } catch {
    // none
  }
  const host = hostOf(remote);
  if (host === 'github') tools.add('gh');
  if (host === 'azure') tools.add('az');

  const suggested = suggest(signals, owns, isGit ? existingIn(path, '').skills.map((x) => x.id) : []);

  return {
    path,
    exists: true,
    isGit,
    name: basename(path),
    remote,
    host,
    baseBranch,
    found,
    signals: [...signals],
    owns: Object.fromEntries(Object.entries(owns).map(([k, v]) => [k, [...v]])),
    claudeMd,
    agentsMd,
    skills: isGit ? repoSkills(path) : [],
    mcpJson,
    tools: [...tools],
    suggested,
    repos: [],
    existing: existingIn(path, ''),
    azureConfigDir: azureDirIn(path),
  };
}

/**
 * Which agents and skills to suggest for what the repo has: planners always,
 * an agent per app (or one developer for a small repo), designer and tester
 * when there is UI. Also used for a repo that does not exist yet, from what
 * the owner says it will hold.
 */
export function suggest(given: Set<string>, owns: Record<string, Set<string> | string[]>, existingSkills: string[] = []): Scan['suggested'] {
  const signals = new Set(given);
  const appKinds = ['web', 'backend', 'ios', 'android', 'mac', 'windows'].filter((s) => signals.has(s));
  if (appKinds.length <= 1) signals.add('small');
  // Agents: the templates whose signals match; planners always; designer and tester when there is UI.
  const ui = ['web', 'ios', 'android', 'mac', 'windows'].some((s) => signals.has(s));
  const roles: { template: string; owns: string[] }[] = [];
  for (const t of listTemplates()) {
    const when = t.suggestWhen;
    let match = when.includes('always');
    if (t.id === 'fullstack') match = signals.has('small') && appKinds.length > 0;
    else if (t.kind === 'designer' || t.kind === 'tester') match = ui;
    else if (signals.has('small') && t.kind === 'app' && ['web', 'backend'].some((s) => when.includes(s))) match = false;
    else if (when.some((w) => signals.has(w) && w !== 'small')) match = true;
    if (!match) continue;
    const dirs = when.flatMap((w) => [...(owns[w] ?? [])]).filter((d) => d);
    roles.push({ template: t.id, owns: t.kind === 'app' && t.id !== 'fullstack' && t.id !== 'docs' ? [...new Set(dirs)] : t.owns });
  }
  // An empty repo still needs someone to build.
  if (!roles.some((r) => listTemplates().find((t) => t.id === r.template)?.kind === 'app')) roles.push({ template: 'fullstack', owns: [] });

  const skills = librarySkills()
    .filter((s) => s.suggestWhen.includes('always') || s.suggestWhen.some((w) => signals.has(w)))
    .map((s) => s.id);

  return { roles, skills: skills.filter((id) => !existingSkills.includes(id)) };
}

/** The host of a checkout's origin, remembered per path (the board asks often). */
const hostCache = new Map<string, GitHost>();
export function hostOfRepo(path: string): GitHost {
  if (!hostCache.has(path)) hostCache.set(path, hostOf(git(path, ['remote', 'get-url', 'origin'])));
  return hostCache.get(path)!;
}
