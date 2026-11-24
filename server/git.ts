import { execFile } from './proc.ts';
import { promisify } from 'node:util';
import { identityEnv, type Identity } from './accounts.ts';
import { hostOf, type GitHost } from './scan.ts';
import type { PrReview } from './db.ts';

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
  /** Where it stands with its reviewers, by account (login or e-mail). */
  review: PrReview;
}

/** An open PR waiting for the owner's review. */
export interface ReviewRequest {
  number: number;
  title: string;
  url: string;
  author: string;
}

/** A review, a comment or an inline comment on a PR, from a person or a bot (Copilot). */
export interface PrFeedback {
  id: string;
  author: string;
  /** ISO time it was written. */
  at: string;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED for a review; empty for a comment. */
  state: string;
  /** File and line for an inline comment. */
  where: string;
  body: string;
  /** The thread it answers, when it is a reply. */
  reply: boolean;
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
  /** Open, non-draft PRs created by the signed-in account. */
  ownPrs(repo: string, account: Identity): Promise<OwnPr[]>;
  /** Reviews and comments on a PR, oldest first. */
  prFeedback(prUrl: string, repo: string, account: Identity): Promise<PrFeedback[]>;
  /** Signed in, and as whom; null when not. */
  whoami(account: Identity): Promise<string | null>;
  loginCommand: string;
  /** Write access to the repo. */
  canPush(repo: string, account: Identity): Promise<boolean>;
  /** A new, empty repo; returns its clone URL. */
  createRepo(opts: { name: string; owner: string; project?: string; private: boolean }, account: Identity): Promise<string>;
}

/** An open PR of the owner's own that no card holds: theirs to merge. */
export interface OwnPr {
  number: number;
  title: string;
  url: string;
  review: PrReview;
}

type GhReviewFields = {
  reviewDecision: string;
  /** BLOCKED when branch protection or a ruleset holds the merge back. */
  mergeStateStatus?: string;
  reviewRequests: { login?: string; name?: string; slug?: string }[];
  latestReviews: { author: { login: string } | null; state: string }[];
};

/** Where a GitHub PR stands with its reviewers. A requested reviewer drops off the list once they have reviewed. */
function ghReview(pr: GhReviewFields): PrReview {
  const by = (st: string) => pr.latestReviews.filter((r) => r.state === st && r.author).map((r) => r.author!.login);
  const asked = pr.reviewRequests.map((r) => r.login ?? r.name ?? r.slug ?? '').filter(Boolean);
  if (pr.reviewDecision === 'CHANGES_REQUESTED' || by('CHANGES_REQUESTED').length) return { state: 'changes', who: by('CHANGES_REQUESTED') };
  // A requested review only holds the PR up when GitHub says a review is required, or the merge is blocked.
  if (pr.reviewDecision === 'REVIEW_REQUIRED' || (asked.length && pr.mergeStateStatus === 'BLOCKED')) return { state: 'waiting', who: asked };
  if (pr.reviewDecision === 'APPROVED' || by('APPROVED').length) return { state: 'approved', who: by('APPROVED') };
  return { state: 'none', who: [] };
}

type AzReviewer = { uniqueName: string; displayName: string; vote: number; isRequired?: boolean; isContainer?: boolean };

/** Votes: 10 approved, 5 approved with suggestions, 0 none yet, -5 waiting for the author, -10 rejected. */
function azReview(reviewers: AzReviewer[] | null | undefined, skip: Set<string> = new Set()): PrReview {
  const people = (reviewers ?? []).map((r) => ({ ...r, who: r.uniqueName || r.displayName })).filter((r) => !skip.has(r.who.toLowerCase()));
  const against = people.filter((r) => r.vote < 0).map((r) => r.who);
  // Only required reviewers hold a PR up; an optional one who has not voted blocks nothing.
  const pending = people.filter((r) => r.vote === 0 && r.isRequired).map((r) => r.who);
  const approved = people.filter((r) => r.vote > 0).map((r) => r.who);
  if (against.length) return { state: 'changes', who: against };
  if (pending.length) return { state: 'waiting', who: pending };
  if (approved.length) return { state: 'approved', who: approved };
  return { state: 'none', who: [] };
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
    const out = await exec('gh', ['pr', 'view', prUrl, '--json', 'state,mergeable,mergeStateStatus,reviewDecision,reviewRequests,latestReviews'], identityEnv(account), repo);
    const pr = JSON.parse(out) as GhReviewFields & { state: string; mergeable: string };
    return { state: pr.state === 'MERGED' ? 'MERGED' : pr.state === 'CLOSED' ? 'CLOSED' : 'OPEN', mergeable: pr.mergeable, review: ghReview(pr) };
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
  async ownPrs(repo, account) {
    const out = await exec(
      'gh',
      ['pr', 'list', '--author', '@me', '--state', 'open', '--limit', '50', '--json', 'number,title,url,isDraft,mergeStateStatus,reviewDecision,reviewRequests,latestReviews'],
      identityEnv(account),
      repo,
    );
    return (JSON.parse(out) as (GhReviewFields & { number: number; title: string; url: string; isDraft: boolean })[])
      .filter((p) => !p.isDraft)
      .map((p) => ({ number: p.number, title: p.title, url: p.url, review: ghReview(p) }));
  },
  async prFeedback(prUrl, repo, account) {
    const m = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(prUrl);
    if (!m) throw new Error('ingen GitHub-PR i länken');
    const env = identityEnv(account);
    const view = JSON.parse(await exec('gh', ['pr', 'view', prUrl, '--json', 'reviews,comments'], env, repo)) as {
      reviews: { id: string; author: { login: string } | null; body: string; state: string; submittedAt: string }[];
      comments: { id: string; author: { login: string } | null; body: string; createdAt: string }[];
    };
    // Inline comments are not in gh pr view; the REST API has them.
    const inline = JSON.parse(await exec('gh', ['api', '--paginate', `repos/${m[1]}/${m[2]}/pulls/${m[3]}/comments`], env, repo)) as {
      id: number;
      user: { login: string } | null;
      body: string;
      path: string;
      line: number | null;
      original_line: number | null;
      created_at: string;
      in_reply_to_id?: number;
    }[];
    const list: PrFeedback[] = [
      ...view.reviews.map((r) => ({ id: `r${r.id}`, author: r.author?.login ?? 'ghost', at: r.submittedAt, state: r.state, where: '', body: r.body, reply: false })),
      ...view.comments.map((c) => ({ id: `c${c.id}`, author: c.author?.login ?? 'ghost', at: c.createdAt, state: '', where: '', body: c.body, reply: false })),
      ...inline.map((c) => ({
        id: `i${c.id}`,
        author: c.user?.login ?? 'ghost',
        at: c.created_at,
        state: '',
        where: `${c.path}${c.line ?? c.original_line ? `:${c.line ?? c.original_line}` : ''}`,
        body: c.body,
        reply: Boolean(c.in_reply_to_id),
      })),
    ];
    return list.sort((a, b) => a.at.localeCompare(b.at));
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
    const out = await exec(
      'az',
      ['repos', 'pr', 'show', '--id', id, '--org', `https://dev.azure.com/${org}`, '--query', '{status: status, merge: mergeStatus, reviewers: reviewers}', '-o', 'json'],
      identityEnv(account),
      repo,
    );
    const { status, merge, reviewers } = JSON.parse(out) as { status: string; merge: string; reviewers: AzReviewer[] | null };
    // The owner (the agents' account) as reviewer of the PR is the owner's own click, not someone it waits for.
    const me = (await this.whoami(account))?.toLowerCase();
    const review = azReview(reviewers, new Set(me ? [me] : []));
    return {
      state: status === 'completed' ? 'MERGED' : status === 'abandoned' ? 'CLOSED' : 'OPEN',
      mergeable: merge === 'conflicts' ? 'CONFLICTING' : merge === 'succeeded' ? 'MERGEABLE' : 'UNKNOWN',
      review,
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
      reviewers: { uniqueName: string; displayName?: string; vote: number; isRequired?: boolean }[];
    }[];
    // Only what the owner holds up: a required reviewer with no vote yet (0). An optional one
    // blocks nothing. Own PRs count too: an agent or a pipeline opens them in the owner's name,
    // and a branch policy makes them review it before it goes in. Required through a group only
    // is not seen here; cards' PRs are left out by the caller.
    return prs
      .filter((p) => !p.isDraft)
      .filter((p) => {
        const votes = p.reviewers.filter((r) => mine.has(r.uniqueName.toLowerCase()) || mine.has((r.displayName ?? '').toLowerCase()));
        return votes.some((r) => r.isRequired) && votes.every((r) => r.vote === 0);
      })
      .map((p) => ({
        number: p.pullRequestId,
        title: p.title,
        url: `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}/pullrequest/${p.pullRequestId}`,
        author: p.createdBy.displayName,
      }));
  },
  async ownPrs(repo, account) {
    const login = await this.whoami(account);
    if (!login) throw new Error('inte inloggad i az');
    const { org, project, repo: name } = await azureRemote(repo);
    const out = await exec(
      'az',
      ['repos', 'pr', 'list', '--org', `https://dev.azure.com/${org}`, '--project', project, '--repository', name, '--status', 'active', '--creator', login, '--top', '100', '-o', 'json'],
      identityEnv(account),
      repo,
    );
    return (JSON.parse(out) as { pullRequestId: number; title: string; isDraft?: boolean; reviewers: AzReviewer[] | null }[])
      .filter((p) => !p.isDraft)
      .map((p) => ({
        number: p.pullRequestId,
        title: p.title,
        url: `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}/pullrequest/${p.pullRequestId}`,
        // The owner listed as reviewer of their own PR (a branch policy) is not someone it waits for.
        review: azReview(p.reviewers, new Set([login.toLowerCase()])),
      }));
  },
  async prFeedback(prUrl, repo, account) {
    const id = /pullrequest\/(\d+)/.exec(prUrl)?.[1];
    if (!id) throw new Error('ingen PR i länken');
    const { org, project, repo: name } = await azureRemote(repo);
    const out = await exec(
      'az',
      ['devops', 'invoke', '--area', 'git', '--resource', 'pullRequestThreads', '--org', `https://dev.azure.com/${org}`, '--route-parameters', `project=${project}`, `repositoryId=${name}`, `pullRequestId=${id}`, '--api-version', '7.1', '-o', 'json'],
      identityEnv(account),
      repo,
    );
    const threads = (JSON.parse(out) as {
      value: {
        id: number;
        isDeleted?: boolean;
        threadContext?: { filePath?: string; rightFileStart?: { line: number } } | null;
        comments: { id: number; parentCommentId?: number; author: { uniqueName: string; displayName: string }; content?: string; publishedDate: string; commentType?: string; isDeleted?: boolean }[];
      }[];
    }).value;
    const list: PrFeedback[] = [];
    for (const t of threads) {
      if (t.isDeleted) continue;
      const file = t.threadContext?.filePath?.replace(/^\//, '');
      const where = file ? `${file}${t.threadContext?.rightFileStart ? `:${t.threadContext.rightFileStart.line}` : ''}` : '';
      for (const c of t.comments) {
        // Votes, pushes and policy runs are system comments, not feedback.
        if (c.isDeleted || c.commentType === 'system' || !c.content) continue;
        list.push({ id: `${t.id}.${c.id}`, author: c.author.uniqueName || c.author.displayName, at: c.publishedDate, state: '', where, body: c.content, reply: Boolean(c.parentCommentId) });
      }
    }
    return list.sort((a, b) => a.at.localeCompare(b.at));
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
