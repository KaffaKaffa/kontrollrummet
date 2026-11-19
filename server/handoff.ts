import { accountEnv } from './accounts.ts';
import { hostOf } from './scan.ts';
import { execFile, execFileSync } from './proc.ts';
import { promisify } from 'node:util';
import { submitTask } from './actions.ts';
import { startAgent } from './agent.ts';
import { bus } from './bus.ts';
import { addEvent, getMark, getSubtask, listMarks, setMark } from './db.ts';
import { getTeam, loadTeams, type Team } from './roles.ts';

const run = promisify(execFile);

/**
 * Control rooms talk through GitHub issues in the team's repo. An issue
 * labelled for this room (handoff.label) becomes a task for the team leader;
 * an issue this room opened for a peer wakes the card that asked when the peer
 * comments or closes it. Every comment a room writes carries a marker with its
 * name, so neither answers itself. The check is gh on the clock: no tokens
 * until there is something to do.
 */

interface Handoff {
  team: string;
  subtaskId: number;
  direction: 'in' | 'out';
  /** Comments already passed on. */
  seen: number;
  closed: boolean;
}

const marker = (name: string) => `<!-- kontrollrum:${name} -->`;
const scope = (teamId: string) => `handoff:${teamId}`;

function load(teamId: string, issue: number): Handoff | null {
  const v = getMark(scope(teamId), String(issue));
  return v ? (JSON.parse(v) as Handoff) : null;
}

function save(issue: number, h: Handoff) {
  setMark(scope(h.team), String(issue), JSON.stringify(h));
}

function gitRemote(repo: string): string | null {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

async function gh(team: Team, args: string[]): Promise<string> {
  // As the team's account; handoff runs over GitHub issues only.
  const { stdout } = await run('gh', args, { cwd: team.repo, env: accountEnv(team.account), maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function comment(team: Team, issue: number, text: string) {
  await gh(team, ['issue', 'comment', String(issue), '--body', `${text}\n\n${marker(team.handoff!.name)}`]);
}

/** Opens an issue for a peer room. The card that asked is woken when they answer. */
export async function askPeer(teamId: string, subtaskId: number, peer: string, title: string, body: string): Promise<string> {
  const team = getTeam(teamId);
  const cfg = team?.handoff;
  if (!team || !cfg) throw new Error('teamet har ingen handoff i team.local.json');
  const label = cfg.peers[peer];
  if (!label) throw new Error(`okänd mottagare ${peer}. Finns: ${Object.keys(cfg.peers).join(', ') || 'inga'}`);
  await gh(team, ['label', 'create', label, '--color', '7c3aed', '--description', `Till ${peer}s kontrollrum`, '--force']);
  const url = (
    await gh(team, ['issue', 'create', '--title', title, '--label', label, '--body', `${body}\n\n— ${cfg.name}s kontrollrum, kort #${subtaskId}\n${marker(cfg.name)}`])
  ).trim();
  const issue = Number(/\/issues\/(\d+)/.exec(url)?.[1]);
  save(issue, { team: team.id, subtaskId, direction: 'out', seen: 0, closed: false });
  return url;
}

/** A comment on an issue this room is part of, from the card working on it. */
export async function replyPeer(teamId: string, issue: number, text: string, close: boolean) {
  const team = getTeam(teamId);
  if (!team?.handoff) throw new Error('teamet har ingen handoff i team.local.json');
  await comment(team, issue, text);
  if (close) await gh(team, ['issue', 'close', String(issue)]);
  const h = load(team.id, issue);
  if (h) save(issue, { ...h, seen: h.seen + 1, closed: close || h.closed });
}

const wake = (subtaskId: number, text: string) => {
  bus.emit({ type: 'event', event: addEvent(subtaskId, 'status', text.split('\n')[0]) });
  void startAgent(subtaskId, text, { wake: true }).catch(() => undefined);
};

async function checkTeam(team: Team) {
  const cfg = team.handoff!;
  // New issues for this room.
  const open = JSON.parse(await gh(team, ['issue', 'list', '--label', cfg.label, '--state', 'open', '--json', 'number,title,body,url,author', '--limit', '30'])) as {
    number: number;
    title: string;
    body: string;
    url: string;
    author: { login: string };
  }[];
  for (const i of open) {
    if (load(team.id, i.number)) continue;
    const text = `${i.title}

Från ett annat kontrollrum, via GitHub-issue #${i.number} (${i.url}, öppnad av ${i.author.login}):

${i.body.replace(/<!-- kontrollrum:[^>]*-->/g, '').trim()}

Svara och ställ följdfrågor med reply_peer på issue ${i.number}. När det är klart: report done, så skrivs din summary som svar och issuen stängs.`;
    const { subtask } = submitTask(team.id, text);
    save(i.number, { team: team.id, subtaskId: subtask.id, direction: 'in', seen: 0, closed: false });
    await comment(team, i.number, `Mottaget. Ligger hos teamleadern som kort #${subtask.id}.`).catch(() => undefined);
  }

  // Issues already handed over: answers to pass on, finished work to report back.
  for (const { key, value } of listMarks(scope(team.id))) {
    if (!value) continue;
    const issue = Number(key);
    const h = JSON.parse(value) as Handoff;
    if (h.closed) continue;
    const card = getSubtask(h.subtaskId);
    if (h.direction === 'in' && card?.status === 'done') {
      await comment(team, issue, card.summary ?? 'Klart.');
      await gh(team, ['issue', 'close', String(issue)]);
      save(issue, { ...h, closed: true });
      continue;
    }
    const view = JSON.parse(await gh(team, ['issue', 'view', String(issue), '--json', 'state,comments'])) as {
      state: string;
      comments: { body: string; author: { login: string } }[];
    };
    const theirs = view.comments.filter((c) => !c.body.includes(marker(cfg.name)));
    const unseen = theirs.slice(h.seen);
    if (unseen.length) {
      wake(h.subtaskId, `[Kontrollrummet] Nytt svar på GitHub-issue #${issue}:\n\n${unseen.map((c) => c.body.replace(/<!-- kontrollrum:[^>]*-->/g, '').trim()).join('\n\n---\n\n')}`);
    }
    const closed = view.state === 'CLOSED';
    if (closed && h.direction === 'out' && !unseen.length) wake(h.subtaskId, `[Kontrollrummet] GitHub-issue #${issue} är stängd av mottagaren.`);
    save(issue, { ...h, seen: theirs.length, closed });
  }
}

export function startHandoff() {
  const round = () => {
    for (const team of loadTeams()) if (team.handoff && hostOf(gitRemote(team.repo)) === 'github') void checkTeam(team).catch((err) => console.warn(`[handoff] ${team.id}: ${(err as Error).message}`));
  };
  setTimeout(round, 20_000);
  setInterval(round, 3 * 60_000);
}
