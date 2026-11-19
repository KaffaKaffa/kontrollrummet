import { execFile } from './proc.ts';
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RepoInfo, Team } from './roles.ts';
import { setExcluded } from './project.ts';

const run = promisify(execFile);

/** "Lägg till en rad i loggen" → "lagg-till-en-rad-i-loggen", capped. */
export function slug(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'uppgift'
  );
}

/**
 * Skills that are only on this Mac (in the checkout's .claude/skills but not
 * in git) are not in a new worktree; a link makes the agent find them.
 */
export function linkLocalSkills(repo: string, worktree: string) {
  // Commands that are only on this Mac (the folder of several repos has them) come along too.
  const commands = join(repo, '.claude/commands');
  if (existsSync(commands)) {
    for (const name of readdirSync(commands).filter((f) => f.endsWith('.md'))) {
      const to = join(worktree, '.claude/commands', name);
      if (existsSync(to)) continue;
      try {
        mkdirSync(join(worktree, '.claude/commands'), { recursive: true });
        symlinkSync(join(commands, name), to);
        setExcluded(worktree, `/.claude/commands/${name}`, true);
      } catch {
        // Only missing; the card still runs.
      }
    }
  }
  const from = join(repo, '.claude/skills');
  if (!existsSync(from)) return;
  for (const name of readdirSync(from)) {
    const to = join(worktree, '.claude/skills', name);
    if (existsSync(to)) continue;
    try {
      mkdirSync(join(worktree, '.claude/skills'), { recursive: true });
      symlinkSync(join(from, name), to);
      // The link is this Mac's, never the repo's: kept out of git (info/exclude is shared by the worktrees).
      setExcluded(worktree, `/.claude/skills/${name}`, true);
    } catch {
      // A skill that cannot be linked is only missing; the card still runs.
    }
  }
}

export interface Worktree {
  path: string;
  branch: string;
}

/**
 * One worktree and one branch per card, cut from the team's base branch on
 * origin, so two cards never share a working copy. An existing worktree for the
 * card is reused: a card resumed after a restart picks up where it was.
 */
export async function ensureWorktree(team: Team, repo: RepoInfo, subtaskId: number, agent: string, title: string): Promise<Worktree> {
  const name = `cr-${subtaskId}-${agent}-${slug(title)}`.slice(0, 60).replace(/-+$/g, '');
  const path = join(repo.path, '.claude/worktrees', name);
  const branch = `feature/${name}`;
  if (existsSync(path)) return { path, branch };

  await run('git', ['fetch', 'origin', repo.baseBranch, '--quiet'], { cwd: repo.path });
  // --no-track: the branch must not track the base, or a bare `git push` would aim at it.
  // Worktrees never show up as changes in the checkout: kept out through the
  // repo's own, never committed ignore list (.git/info/exclude), not .gitignore.
  setExcluded(repo.path, '/.claude/worktrees/', true);
  await run('git', ['worktree', 'add', '--no-track', '-b', branch, path, `origin/${repo.baseBranch}`], {
    cwd: repo.path,
  });
  linkLocalSkills(repo.path, path);
  // Several repos under one folder: the folder's own local skills too.
  if (team.repo !== repo.path) linkLocalSkills(team.repo, path);
  return { path, branch };
}
