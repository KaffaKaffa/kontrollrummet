import { execFile } from './proc.ts';
import { promisify } from 'node:util';
import { identityEnv } from './accounts.ts';
import type { Person, Team } from './roles.ts';
import { hostOfRepo } from './scan.ts';

const run = promisify(execFile);

/**
 * Who works in the project, read from where the work happens: merged PRs on
 * GitHub or Azure DevOps (who opened, reviewed and merged them) and the
 * commits of the last half year. Suggestions only: the settings page shows
 * them to edit, remove or keep. No AI: the git host already knows.
 */

export interface Suggestion extends Person {
  /** What it is based on, in a few words. */
  evidence: string;
}

interface Tally {
  name: string;
  account?: string;
  emails: Set<string>;
  merged: number;
  reviewed: number;
  opened: number;
  commits: number;
}

const BOT = /\[bot\]|\bbot\b|copilot|dependabot|renovate|github-actions|azure pipelines|build service|project collection|anthropic|^claude$/i;

async function out(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  try {
    return (await run(cmd, args, { cwd, env, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 })).stdout;
  } catch {
    return '';
  }
}

export async function suggestPeople(team: Team): Promise<Suggestion[]> {
  const tallies = new Map<string, Tally>();
  const env = identityEnv({ account: team.account, azureConfigDir: team.azureConfigDir });
  /** One person per account (login or e-mail), else per name. */
  const get = (name: string, account?: string, email?: string): Tally | null => {
    if (!name || BOT.test(name) || (account && BOT.test(account)) || (email && BOT.test(email))) return null;
    const key = (account ?? email ?? name).toLowerCase();
    let t = tallies.get(key) ?? [...tallies.values()].find((x) => (email && x.emails.has(email.toLowerCase())) || x.name.toLowerCase() === name.toLowerCase());
    if (!t) {
      t = { name, account, emails: new Set(), merged: 0, reviewed: 0, opened: 0, commits: 0 };
      tallies.set(key, t);
    }
    if (account && !t.account) t.account = account;
    if (email) t.emails.add(email.toLowerCase());
    return t;
  };

  /** GitHub: which login a commit e-mail belongs to, from the latest commits. */
  const loginOf = new Map<string, string>();
  for (const repo of team.repos) {
    const host = hostOfRepo(repo.path);
    if (host === 'github') {
      const pairs = await out('gh', ['api', 'repos/{owner}/{repo}/commits?per_page=100', '--jq', '.[] | [.author.login // "", .commit.author.email] | @tsv'], env, repo.path);
      for (const line of pairs.split('\n').filter(Boolean)) {
        const [login, email] = line.split('\t');
        if (login && email) loginOf.set(email.toLowerCase(), login);
      }
      const json = await out('gh', ['pr', 'list', '--state', 'merged', '--limit', '60', '--json', 'author,mergedBy,reviews'], env, repo.path);
      const prs = (json ? JSON.parse(json) : []) as { author?: { login: string; name?: string }; mergedBy?: { login: string; name?: string }; reviews?: { author?: { login: string } }[] }[];
      for (const pr of prs) {
        const a = pr.author && get(pr.author.name || pr.author.login, pr.author.login);
        if (a) a.opened++;
        const m = pr.mergedBy && get(pr.mergedBy.name || pr.mergedBy.login, pr.mergedBy.login);
        if (m) m.merged++;
        for (const login of new Set((pr.reviews ?? []).map((r) => r.author?.login).filter(Boolean) as string[])) {
          const r = get(login, login);
          if (r) r.reviewed++;
        }
      }
    } else if (host === 'azure') {
      const remote = (await out('git', ['remote', 'get-url', 'origin'], env, repo.path)).trim();
      const m = /dev\.azure\.com[/:](?:v3\/)?([^/]+)\/([^/]+)\/(?:_git\/)?([^/?#]+)/.exec(remote) ?? /([\w-]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/.exec(remote);
      if (m) {
        const org = m[1].replace(/^[^@]+@/, '');
        const json = await out(
          'az',
          ['repos', 'pr', 'list', '--status', 'completed', '--top', '60', '--org', `https://dev.azure.com/${org}`, '--project', decodeURIComponent(m[2]), '--repository', decodeURIComponent(m[3]), '-o', 'json'],
          env,
          repo.path,
        );
        type Who = { displayName: string; uniqueName: string; vote?: number };
        const prs = (json ? JSON.parse(json) : []) as { createdBy?: Who; closedBy?: Who; reviewers?: Who[] }[];
        for (const pr of prs) {
          const a = pr.createdBy && get(pr.createdBy.displayName, pr.createdBy.uniqueName, pr.createdBy.uniqueName);
          if (a) a.opened++;
          const c = pr.closedBy && get(pr.closedBy.displayName, pr.closedBy.uniqueName, pr.closedBy.uniqueName);
          if (c) c.merged++;
          for (const r of pr.reviewers ?? []) {
            if (!r.vote) continue; // asked, not answered
            const t = get(r.displayName, r.uniqueName, r.uniqueName);
            if (t) t.reviewed++;
          }
        }
      }
    }
    // Commits on the base branch, last half year: anyone who writes code, whatever the host.
    const log = await out('git', ['log', `origin/${repo.baseBranch}`, '--since=6.months', '--no-merges', '--format=%an%x09%ae'], env, repo.path);
    for (const line of log.split('\n').filter(Boolean)) {
      const [name, email] = line.split('\t');
      // GitHub's private address carries the login: 123+login@users.noreply.github.com.
      const login = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email ?? '')?.[1] ?? loginOf.get((email ?? '').toLowerCase());
      const t = get(name, login, email);
      if (t) t.commits++;
    }
  }

  // GitHub logins without a name: the profile's.
  const named = await Promise.all(
    [...tallies.values()].map(async (t) => {
      if (t.account && t.name === t.account && !t.account.includes('@')) {
        const name = (await out('gh', ['api', `users/${t.account}`, '--jq', '.name // ""'], env, team.repo)).trim();
        if (name) t.name = name;
      }
      return t;
    }),
  );

  const score = (t: Tally) => t.merged * 3 + t.reviewed * 2 + t.opened + t.commits / 5;
  return named
    .filter((t) => score(t) >= 2)
    .sort((a, b) => score(b) - score(a))
    .slice(0, 10)
    .map((t) => {
      const does = [t.merged > 0 && 'mergar PR:er', t.reviewed >= 2 && 'granskar', (t.opened > 0 || t.commits >= 5) && 'skriver kod'].filter(Boolean).join(', ');
      const evidence = [
        t.merged && `${t.merged} mergade`,
        t.reviewed && `${t.reviewed} granskade`,
        t.opened && `${t.opened} egna PR:er`,
        t.commits && `${t.commits} commits senaste halvåret`,
      ]
        .filter(Boolean)
        .join(', ');
      return { name: t.name, account: t.account ?? [...t.emails][0], does: does || undefined, evidence };
    });
}
