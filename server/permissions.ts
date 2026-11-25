import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { neverRulesHit } from './grants.ts';

/**
 * What agents may run without asking, beyond the control room's own tools.
 * Three sources, all sent as --allowedTools: defaults for roles that change
 * code (routine work in the card's own worktree), rules the owner saved with
 * "Tillåt alltid" for a project, and the same for all projects. NEVER still
 * wins: in Claude Code a deny rule goes before any allow rule.
 */
export interface SavedRule {
  rule: string;
  at: string;
  /** Where it came from, for the list in settings. */
  from?: { card?: number; command?: string };
}

interface Store {
  global: SavedRule[];
  teams: Record<string, SavedRule[]>;
}

/** Local to this computer and outside git. */
const FILE = join(DATA_DIR, 'permissions.json');

function load(): Store {
  try {
    const raw = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as Partial<Store>) : {};
    return { global: raw.global ?? [], teams: raw.teams ?? {} };
  } catch {
    return { global: [], teams: {} };
  }
}

let store = load();

const save = () => writeFileSync(FILE, JSON.stringify(store, null, 2));

/** Routine in an agent's own worktree: build, test, git on its own branch, local services. */
export const DEFAULT_RULES: { group: string; rules: string[] }[] = [
  {
    group: 'Git i egen worktree',
    rules: ['Bash(git reset --hard:*)', 'Bash(git clean -fd:*)', 'Bash(git push --force-with-lease origin HEAD:*)', 'Bash(git commit:*)', 'Bash(git stash:*)'],
  },
  {
    group: 'Beroenden och bygge',
    rules: [
      'Bash(npm install:*)', 'Bash(npm ci:*)', 'Bash(npm run:*)', 'Bash(npx tsc:*)', 'Bash(pnpm install:*)', 'Bash(pnpm run:*)', 'Bash(yarn install:*)',
      'Bash(pod install:*)', 'Bash(dotnet restore:*)', 'Bash(dotnet build:*)', 'Bash(dotnet run:*)', 'Bash(xcodebuild:*)', 'Bash(./gradlew:*)',
    ],
  },
  {
    group: 'Tester',
    rules: ['Bash(npm test:*)', 'Bash(npx vitest:*)', 'Bash(npx jest:*)', 'Bash(npx playwright:*)', 'Bash(dotnet test:*)', 'Bash(swift test:*)', 'Bash(swift build:*)'],
  },
  {
    group: 'Lokala tjänster',
    rules: [
      'Bash(docker compose up:*)', 'Bash(docker compose start:*)', 'Bash(docker start:*)', 'Bash(open -a Docker:*)', 'Bash(xcrun simctl:*)', 'Bash(emulator:*)', 'Bash(adb:*)',
    ],
  },
  { group: 'Lokala dev-hemligheter', rules: ['Bash(dotnet user-secrets list:*)'] },
  { group: 'Städning av byggutdata', rules: ['Bash(rm -rf ~/Library/Developer/Xcode/DerivedData:*)'] },
];

const SHELLS = /^(bash|sh|zsh|fish|dash|ksh|node|deno|bun|python[\d.]*|ruby|perl|php|pwsh|powershell|eval|exec|sudo|xargs|env|osascript)$/;

/** Why a rule may not be saved as "always", or null when it is fine. */
export function isTooBroad(rule: string): string | null {
  const r = rule.trim();
  if (!r) return 'Regeln är tom.';
  if (r === 'Bash' || /^Bash\(\s*(\*|:\*)?\s*\)$/.test(r)) return 'Regeln tillåter alla kommandon.';
  const m = /^Bash\((.+)\)$/s.exec(r);
  if (!m) {
    // A tool rule: only the exact tool name of an MCP server, never a built-in that runs code.
    return /^mcp__[\w-]+(__[\w-]+)?$/.test(r) ? null : 'Använd Bash(kommando:*) eller mcp__server__verktyg.';
  }
  const prefix = m[1].replace(/:?\*$/, '').trim();
  if (!prefix) return 'Regeln tillåter alla kommandon.';
  const first = prefix.split(/\s+/)[0].replace(/^.*\//, '');
  if (SHELLS.test(first)) return `${first} kör vad som helst och kan inte tillåtas som regel.`;
  if (/^rm\s+-\w*[rf]\w*\s*$/.test(prefix) || /^rm\s+-\w*[rf]\w*\s+(-\w+\s*)*[/~*.]?\s*$/.test(prefix)) return 'rm -rf måste ange en sökväg.';
  if (/(curl|wget)\b.*\|\s*(ba|z)?sh/.test(prefix)) return 'Hämta och kör i ett steg kan inte tillåtas.';
  // A prefix rule matches every command that starts with it, so test what it can grow into too
  // ("npm run release" matches "npm run release:ios", which a NEVER glob catches).
  if ([prefix, `${prefix}:x`, `${prefix} x`].some((c) => neverRulesHit(c).length)) return 'Regeln träffar något som aldrig får tillåtas (release, deploy, merge).';
  return null;
}

export function addRule(scope: 'team' | 'global', team: string, rule: string, from?: SavedRule['from']): SavedRule {
  const why = isTooBroad(rule);
  if (why) throw new Error(why);
  const saved: SavedRule = { rule: rule.trim(), at: new Date().toISOString(), ...(from ? { from } : {}) };
  const keep = (list: SavedRule[]) => [...list.filter((s) => s.rule !== saved.rule), saved];
  if (scope === 'global') store.global = keep(store.global);
  else store.teams[team] = keep(store.teams[team] ?? []);
  save();
  return saved;
}

export function removeRule(scope: 'team' | 'global', team: string, rule: string): boolean {
  const list = scope === 'global' ? store.global : (store.teams[team] ?? []);
  const next = list.filter((s) => s.rule !== rule);
  if (next.length === list.length) return false;
  if (scope === 'global') store.global = next;
  else store.teams[team] = next;
  save();
  return true;
}

export function listRules(team: string) {
  return { defaults: DEFAULT_RULES, team: store.teams[team] ?? [], global: store.global };
}

/** The allow rules a role gets: planners only write plans and get none. */
export function rulesFor(team: string, planner: boolean): string[] {
  if (planner) return [];
  const all = [...DEFAULT_RULES.flatMap((g) => g.rules), ...store.global.map((s) => s.rule), ...(store.teams[team] ?? []).map((s) => s.rule)];
  return [...new Set(all)];
}

/** Rule proposals for a command that was asked about: one per part, command plus subcommand. */
export function suggestRules(command: string): string[] {
  const parts = command
    .split(/&&|\|\||;|\||\n/)
    .map((p) => p.trim().replace(/^cd\s+\S+\s*$/, '').replace(/^(?:\w+=\S*\s+)+/, ''))
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const words = p.split(/\s+/);
    // The command, then words up to the first flag or path, at most two more.
    const keep = [words[0]];
    for (const w of words.slice(1, 3)) {
      if (w.startsWith('-') && w !== '--hard' && w !== '--licenses') break;
      if (/[/.\\$]/.test(w) && !w.startsWith('FETCH')) break;
      keep.push(w);
    }
    const rule = `Bash(${keep.join(' ')}:*)`;
    if (!isTooBroad(rule) && !out.includes(rule)) out.push(rule);
  }
  return out;
}
