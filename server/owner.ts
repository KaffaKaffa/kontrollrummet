import { execFileSync } from './proc.ts';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEAMS_DIR } from './config.ts';

/**
 * Who runs this control room: the person agents ask, notify and wait for.
 * Resolved once at start, in this order:
 *   1. CONTROL_ROOM_OWNER
 *   2. `owner`, else `handoff.name`, in a team's team.local.json (never team.json,
 *      which is shared and would name someone else)
 *   3. the first name on the signed-in GitHub account (gh api user), else its login
 */

function fromLocalConfig(): string | undefined {
  if (!existsSync(TEAMS_DIR)) return undefined;
  for (const dir of readdirSync(TEAMS_DIR).sort()) {
    const path = join(TEAMS_DIR, dir, 'team.local.json');
    if (!existsSync(path)) continue;
    try {
      const local = JSON.parse(readFileSync(path, 'utf8')) as { owner?: string; handoff?: { name?: string } };
      const name = (local.owner ?? local.handoff?.name ?? '').trim();
      if (name) return name;
    } catch {
      // A broken local file is reported where the team is loaded; here it just has no name.
    }
  }
  return undefined;
}

function fromGitHub(): string | undefined {
  try {
    const out = execFileSync('gh', ['api', 'user', '--jq', '[.name // "", .login] | @tsv'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [name = '', login = ''] = out.trim().split('\t');
    return name.trim().split(/\s+/)[0] || login.trim() || undefined;
  } catch {
    return undefined;
  }
}

export const OWNER: string = process.env.CONTROL_ROOM_OWNER?.trim() || fromLocalConfig() || fromGitHub() || 'ägaren';

/** Swedish genitive: Annas, but the owner, Max and Inez stay as they are. */
export const OWNERS: string = /[sxz]$/i.test(OWNER) ? OWNER : `${OWNER}s`;

/** Prompts in shared.md and roles/*.md write {{owner}} and {{owners}} for the name. */
export const withOwner = (text: string) => text.replaceAll('{{owners}}', OWNERS).replaceAll('{{owner}}', OWNER);
