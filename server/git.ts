import { execFile } from './proc.ts';
import { promisify } from 'node:util';
import { identityEnv, type Identity } from './accounts.ts';
import { hostOf, type GitHost } from './scan.ts';

const run = promisify(execFile);

/**
 * Where a team's repo is hosted: GitHub through gh, Azure DevOps through az
 * repos. Everything about pull requests that is not git itself goes through
 * here, as the team's account.
 */

export interface PrState {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  /** MERGEABLE, CONFLICTING or UNKNOWN. */
  mergeable: string;
}

/** An open PR waiting for the owner's review. */
export interface ReviewRequest {
  number: number;
  title: string;
  url: string;
  author: string;
}

export interface GitProvider {
  id: Exclude<GitHost, 'none'>;
  label: string;
  /** The CLI that must be installed and signed in. */
  cli: string;
  /** Finds PR links in what an agent wrote; group 1 is the number. */
  prUrl: RegExp;
  /** For the agents' prompt: how a PR is opened here. */
  prHow: string;
  prState(prUrl: string, repo: string, account: Identity): Promise<PrState>;
  /** Merged PRs into the base branch, newest last, with their files. */
  mergedPrs(repo: string, base: string, account: Identity): Promise<{ number: number; title: string; url: string; mergedAt: string; files: string[] }[]>;
  /**
   * Open, non-draft PRs in the repo where the owner is asked to review and has
   * not yet voted: as the signed-in account, or as any identity in `me`.
   */
  reviewRequests(repo: string, account: Identity, me: string[]): Promise<ReviewRequest[]>;
  /** Signed in, and as whom; null when not. */
  whoami(account: Identity): Promise<string | null>;
  loginCommand: string;
  /** Write access to the repo. */
  canPush(repo: string, account: Identity): Promise<boolean>;
  /** A new, empty repo; returns its clone URL. */
  createRepo(opts: { name: string; owner: string; project?: string; private: boolean }, account: Identity): Promise<string>;
}

type Env = NodeJS.ProcessEnv;
const exec = async (cmd: string, args: string[], env: Env, cwd?: string) =>
  (await run(cmd, args, { cwd, env, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();

const github: GitProvider = {
  id: 'github',
  label: 'GitHub',
  cli: 'gh',
  prUrl: /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g,
  prHow: 'Öppna en PR mot basbranchen med `gh pr create`.',
  async prState(prUrl, repo, account) {
    const out = await exec('gh', ['pr', 'view', prUrl, '--json', 'state,mergeable'], identityEnv(account), repo);
    const { state, mergeable } = JSON.parse(out) as { state: string; mergeable: string };
    return { state: state === 'MERGED' ? 'MERGED' : state === 'CLOSED' ? 'CLOSED' : 'OPEN', mergeable };
  },
  async mergedPrs(repo, base, account) {
    const out = await exec('gh', ['pr', 'list', '--state', 'merged', '--base', base, '--limit', '20', '--json', 'number,title,url,mergedAt,files'], identityEnv(account), repo);
    return (JSON.parse(out) as { number: number; title: string; url: string; mergedAt: string; files: { path: string }[] }[])
      .map((p) => ({ ...p, files: p.files.map((f) => f.path) }))
      .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
  },
  async reviewRequests(repo, account, me) {
    // A review request disappears on GitHub once the review is in, so the search is the whole answer.
    const seen = new Map<string, ReviewRequest>();
    for (const who of ['@me', ...me]) {
      const out = await exec(
        'gh',
        ['pr', 'list', '--state', 'open', '--search', `review-requested:${who} draft:false`, '--limit', '50', '--json', 'number,title,url,author'],
        identityEnv(account),
        repo,
      );
      for (const p of JSON.parse(out) as { number: number; title: string; url: string; author: { login: string } }[]) seen.set(p.url, { ...p, author: p.author.login });
    }
    return [...seen.values()];
  },
  async whoami(account) {
    try {
      return (await exec('gh', ['api', 'user', '--jq', '.login'], identityEnv(account))) || null;
    } catch {
      return null;
    }
  },
  loginCommand: 'gh auth login',
  async canPush(repo, account) {
    try {
      const p = await exec('gh', ['repo', 'view', '--json', 'viewerPermission', '--jq', '.viewerPermission'], identityEnv(account), repo);
      return ['ADMIN', 'MAINTAIN', 'WRITE'].includes(p);
    } catch {
      return false;
    }
  },
  async createRepo({ name, owner, private: priv }, account) {
    const full = owner ? `${owner}/${name}` : name;
    await exec('gh', ['repo', 'create', full, priv ? '--private' : '--public', '--add-readme'], identityEnv(account));
    return exec('gh', ['repo', 'view', full, '--json', 'sshUrl', '--jq', '.sshUrl'], identityEnv(account));
  },
};

/** dev.azure.com/{org}/{project}/_git/{repo}, or {org}.visualstudio.com/{project}/_git/{repo}. */
function azureParts(url: string): { org: string; project: string; repo: string } | null {
  const m =
    /dev\.azure\.com[/:](?:v3\/)?([^/]+)\/([^/]+)\/(?:_git\/)?([^/?#]+)/.exec(url) ??
    /([\w-]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/.exec(url);
  return m ? { org: m[1].replace(/^[^@]+@/, ''), project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) } : null;
}

async function azureRemote(repo: string): Promise<{ org: string; project: string; repo: string }> {
  const remote = (await run('git', ['remote', 'get-url', 'origin'], { cwd: repo })).stdout.trim();
  const parts = azureParts(remote);
  if (!parts) throw new Error(`origin (${remote}) ser inte ut som ett Azure DevOps-repo`);
  return parts;
}

const azure: GitProvider = {
  id: 'azure',
  label: 'Azure DevOps',
  cli: 'az',
  prUrl: /https:\/\/(?:dev\.azure\.com\/[^/\s]+|[\w-]+\.visualstudio\.com)\/[^/\s]+\/_git\/[^/\s]+\/pullrequest\/(\d+)/g,
  prHow: 'Öppna en PR mot basbranchen med `az repos pr create --source-branch <din branch> --target-branch <basbranch> --title … --description …` (aldrig med `--auto-complete`), och skriv PR-länken på en egen rad.',
  async prState(prUrl, repo, account) {
    const id = /pullrequest\/(\d+)/.exec(prUrl)?.[1];
    if (!id) throw new Error('ingen PR i länken');
    const { org } = await azureRemote(repo);
    const out = await exec('az', ['repos', 'pr', 'show', '--id', id, '--org', `https://dev.azure.com/${org}`, '--query', '{status: status, merge: mergeStatus}', '-o', 'json'], identityEnv(account), repo);
    const { status, merge } = JSON.parse(out) as { status: string; merge: string };
    return {
      state: status === 'completed' ? 'MERGED' : status === 'abandoned' ? 'CLOSED' : 'OPEN',
      mergeable: merge === 'conflicts' ? 'CONFLICTING' : merge === 'succeeded' ? 'MERGEABLE' : 'UNKNOWN',
    };
  },
  async mergedPrs(repo, base, account) {
    const { org, project, repo: name } = await azureRemote(repo);
    const out = await exec(
      'az',
      ['repos', 'pr', 'list', '--org', `https://dev.azure.com/${org}`, '--project', project, '--repository', name, '--status', 'completed', '--target-branch', base, '--top', '20', '-o', 'json'],
      identityEnv(account),
      repo,
    );
    const prs = JSON.parse(out) as { pullRequestId: number; title: string; closedDate: string; lastMergeCommit?: { commitId: string }; lastMergeTargetCommit?: { commitId: string } }[];
    const list = [];
    for (const p of prs) {
      // az has no file list for a PR; git has, from the merge commit.
      let files: string[] = [];
      if (p.lastMergeCommit?.commitId && p.lastMergeTargetCommit?.commitId) {
        files = (await run('git', ['diff', '--name-only', p.lastMergeTargetCommit.commitId, p.lastMergeCommit.commitId], { cwd: repo }).catch(() => ({ stdout: '' }))).stdout
          .split('\n')
          .filter(Boolean);
      }
      list.push({
        number: p.pullRequestId,
        title: p.title,
        url: `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}/pullrequest/${p.pullRequestId}`,
        mergedAt: p.closedDate,
        files,
      });
    }
    return list.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
  },
  async reviewRequests(repo, account, me) {
    const login = await this.whoami(account);
    if (!login) throw new Error('inte inloggad i az');
    const mine = new Set([login, ...me].map((u) => u.toLowerCase()));
    const { org, project, repo: name } = await azureRemote(repo);
    // Filtered here, not with --reviewer: az cannot resolve every identity a PR names (guests, old names).
    const out = await exec(
      'az',
      ['repos', 'pr', 'list', '--org', `https://dev.azure.com/${org}`, '--project', project, '--repository', name, '--status', 'active', '--top', '200', '-o', 'json'],
      identityEnv(account),
      repo,
    );
    const prs = JSON.parse(out) as {
      pullRequestId: number;
      title: string;
      isDraft?: boolean;
      createdBy: { uniqueName: string; displayName: string };
      reviewers: { uniqueName: string; vote: number }[];
    }[];
    return prs
      .filter((p) => !p.isDraft && !mine.has(p.createdBy.uniqueName.toLowerCase()))
      // Asked, and no vote yet (0). Required through a group only is not seen here.
      .filter((p) => {
        const votes = p.reviewers.filter((r) => mine.has(r.uniqueName.toLowerCase()));
        return votes.length > 0 && votes.every((r) => r.vote === 0);
      })
      .map((p) => ({
        number: p.pullRequestId,
        title: p.title,
        url: `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}/pullrequest/${p.pullRequestId}`,
        author: p.createdBy.displayName,
      }));
  },
  async whoami(account) {
    try {
      return (await exec('az', ['account', 'show', '--query', 'user.name', '-o', 'tsv'], identityEnv(account))) || null;
    } catch {
      return null;
    }
  },
  loginCommand: 'az login && az extension add --name azure-devops',
  async canPush(repo, account) {
    try {
      const { org, project, repo: name } = await azureRemote(repo);
      await exec('az', ['repos', 'show', '--repository', name, '--org', `https://dev.azure.com/${org}`, '--project', project, '-o', 'none'], identityEnv(account));
      return true;
    } catch {
      return false;
    }
  },
  async createRepo({ name, owner, project }, account) {
    if (!project) throw new Error('ange Azure DevOps-projektet');
    const out = await exec('az', ['repos', 'create', '--name', name, '--org', `https://dev.azure.com/${owner}`, '--project', project, '--query', 'sshUrl', '-o', 'tsv'], identityEnv(account));
    return out;
  },
};

export const PROVIDERS = { github, azure } as const;

export function provider(host: GitHost): GitProvider | null {
  return host === 'none' ? null : PROVIDERS[host];
}

/** The provider for a team's repo, from its origin; cached per checkout. */
const byRepo = new Map<string, GitProvider | null>();
export async function providerFor(repo: string): Promise<GitProvider | null> {
  if (byRepo.has(repo)) return byRepo.get(repo)!;
  const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd: repo }).then((r) => r.stdout.trim()).catch(() => null);
  const p = provider(hostOf(remote));
  byRepo.set(repo, p);
  return p;
}

/** Every PR link an agent's text may hold, whichever host. */
export const ANY_PR_URL = new RegExp(`${github.prUrl.source}|${azure.prUrl.source}`, 'g');

/** The PR number in a GitHub or Azure DevOps link. */
export const prNumberOf = (url: string) => Number(/\/(?:pull|pullrequest)\/(\d+)/.exec(url)?.[1]) || null;
