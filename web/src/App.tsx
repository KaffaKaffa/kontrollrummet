import { ConsultantDesk, ConsultantFaces, ConsultantPanel } from './consultants.tsx';
import { Component, lazy, Suspense, useEffect, useMemo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { DevAppButtons } from './devapps.tsx';
import { awaitsReview, calledOr, nameOf, reviewText, post, useBoard, type Account, type Board, type Notice, type OwnPr, type Plan, type PlanStatus, type Role, type Subtask, type Team, type Usage } from './api.ts';
import { Markdown } from './markdown.tsx';
import { Linked, linkify } from './links.tsx';
import { lineSettled } from '../../server/notice-refs.ts';
import { When } from './when.tsx';
import { AgentSettings, Modal } from './settings.tsx';
import { Godfather } from './godfather.tsx';
import { Logo, NewProjectGuide, ProjectSettings } from './project.tsx';
import { Releases } from './releases.tsx';
import type { Director, Duty } from './office3d/director.ts';
import { doing, useLifeTick, useOfficeLife } from './office3d/life.ts';
import { ThemeToggle } from './theme.tsx';
import { NotifyToggle, useSystemNotifications } from './notify.tsx';
import { ApprovalCard, Avatar, CardDetail, CardRow, Composer, Log, LoginPrompt, MergedButton, shownStatus, StatusBadge } from './ui.tsx';

/**
 * The view lives in the URL hash, so a card can be bookmarked or sent:
 * #/<team>/office, #/<team>/office/card/12, #/<team>/office/agent/ios,
 * #/<team>/office/consultant/jurist, #/<team>/plans/3.
 * Old #/<team>/board/12 links still open card 12.
 */
function useRoute() {
  const read = () => location.hash.replace(/^#\/?/, '').split('/');
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  if (route[0] === 'new') return { team: null, view: 'new', planId: null, cardId: null, agentId: null, consultantId: null, conversationId: null } as const;
  // #/gudfadern and #/gudfadern/<conversation> belong to no team.
  if (route[0] === 'gudfadern')
    return { team: null, view: 'gudfadern', planId: null, cardId: null, agentId: null, consultantId: null, conversationId: route[1] ? Number(route[1]) : null } as const;
  const view = route[1] === 'plans' ? 'plans' : route[1] === 'releases' ? 'releases' : route[1] === 'settings' ? 'settings' : 'office';
  const cardId =
    route[2] === 'card' ? Number(route[3]) : route[1] === 'board' && route[2] ? Number(route[2]) : null;
  const agentId = route[2] === 'agent' ? (route[3] ?? null) : null;
  const consultantId = route[2] === 'consultant' ? (route[3] ?? null) : null;
  return { team: route[0] || null, view, planId: view === 'plans' && route[2] ? Number(route[2]) : null, cardId, agentId, consultantId, conversationId: null } as const;
}

/** One team's slice of the board: its roles, its tasks, its cards. */
type TeamBoard = Board & { team: Team; roles: Role[] };

/** Cards that need the owner go first, then work in progress, then the rest. */
const ORDER: Record<Subtask['status'], number> = {
  'needs-you': 0,
  failed: 1,
  running: 2,
  testing: 3,
  'pr-open': 4,
  watching: 5,
  quota: 6,
  queued: 6,
  done: 7,
};

/** A task's cards as a tree: what the lead handed out sits under the lead. */
function tree(cards: Subtask[]): { card: Subtask; depth: number }[] {
  const ids = new Set(cards.map((c) => c.id));
  const children = new Map<number | null, Subtask[]>();
  for (const c of cards) {
    const parent = c.parentId != null && ids.has(c.parentId) ? c.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), c]);
  }
  const out: { card: Subtask; depth: number }[] = [];
  const walk = (parent: number | null, depth: number) => {
    for (const c of (children.get(parent) ?? []).sort((a, b) => a.id - b.id)) {
      out.push({ card: c, depth: Math.min(depth, 3) });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

type Target = 'lead' | 'plan' | 'bug' | 'direct';

function NewTask({ board }: { board: TeamBoard }) {
  const lead = board.roles.find((r) => r.kind === 'lead');
  const bug = board.roles.find((r) => r.kind === 'bug');
  const architect = board.roles.find((r) => r.kind === 'architect');
  const [target, setTarget] = useState<Target>(lead ? 'lead' : 'direct');
  const [direct, setDirect] = useState('');
  const directRole = board.roles.find((r) => r.id === direct) ?? board.roles.find((r) => r.kind === 'app') ?? board.roles[0];
  const role = target === 'lead' ? lead : target === 'bug' ? bug : target === 'plan' ? architect : directRole;

  const placeholder =
    target === 'bug'
      ? `Klistra in fynden, ett per rad. ${calledOr(bug, 'Bug')} sorterar och delar ut.`
      : target === 'plan'
        ? `Vilken feature ska planeras? ${calledOr(architect, 'Arkitekten')} läser koden och tar fram en plan du kan genomföra eller parkera.`
      : target === 'lead'
        ? `Vad ska teamet göra? ${calledOr(lead, 'Teamleadern')} delar upp det.`
        : `Vad ska ${nameOf(role) ?? 'agenten'} göra?`;

  return (
    <section className="hero">
      <Avatar team={board.team.id} role={role} size="xl" />
      <div className="hero-main">
        <div className="segmented" role="tablist" aria-label="Till vem">
          {lead && (
            <button type="button" role="tab" aria-selected={target === 'lead'} onClick={() => setTarget('lead')}>
              {calledOr(lead, 'Teamleadern')}
            </button>
          )}
          {architect && (
            <button type="button" role="tab" aria-selected={target === 'plan'} onClick={() => setTarget('plan')}>
              Planera
            </button>
          )}
          {bug && (
            <button type="button" role="tab" aria-selected={target === 'bug'} onClick={() => setTarget('bug')}>
              Fyndlista
            </button>
          )}
          <button type="button" role="tab" aria-selected={target === 'direct'} onClick={() => setTarget('direct')}>
            Direkt
          </button>
        </div>
        <Composer
          placeholder={placeholder}
          rows={target === 'bug' ? 6 : 3}
          submitLabel={target === 'bug' ? `Lämna till ${calledOr(bug, 'Bug')}` : target === 'plan' ? 'Börja planera' : 'Skicka'}
          onSubmit={(text) => post('/api/tasks', { text, team: board.team.id, agent: role?.id })}
        >
          {target === 'direct' && (
            <label className="select">
              <span>Till</span>
              <select value={directRole?.id ?? ''} onChange={(e) => setDirect(e.target.value)}>
                {board.roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.nick ? `${r.nick} (${r.name})` : r.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </Composer>
      </div>
    </section>
  );
}

/**
 * A card stopped on the owner: the question, its choices as buttons, an answer of
 * his own, and for a test the agent could not run, what it needs to run it
 * itself. Picking or writing sends the answer and the agent goes on.
 */
function Decision({ card, team, role, owner }: { card: Subtask; team: string; role?: Role; owner: string }) {
  const [own, setOwn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = card.ask;
  const question = ask?.question ?? card.summary ?? card.brief;
  const answer = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/api/subtasks/${card.id}/messages`, { text });
      setOwn('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="decision" aria-label={`${nameOf(role) ?? card.agent} #${card.id} kräver beslut`}>
      <header className="decision-head">
        <Avatar team={team} role={role} size="sm" status={card.status} />
        <a href={`#/${team}/office/card/${card.id}`}>
          <strong>{nameOf(role) ?? card.agent}</strong> #{card.id}
        </a>
        <span className="decision-brief">{card.brief.split('\n')[0]}</span>
      </header>
      <p className="decision-question">
        <Linked text={question} />
      </p>
      {ask?.unblock && (
        <p className="decision-unblock">
          <span>För att testa själv behöver agenten</span>
          <Linked text={ask.unblock} />
        </p>
      )}
      <LoginPrompt subtask={card} owner={owner} />
      {ask?.options && ask.options.length > 0 && (
        <div className="decision-options">
          {ask.options.map((o) => (
            <button key={o} type="button" className="btn decision-option" disabled={busy} onClick={() => void answer(`${owner} valde: ${o}`)}>
              {o}
            </button>
          ))}
        </div>
      )}
      <form
        className="decision-own"
        onSubmit={(e) => {
          e.preventDefault();
          void answer(own);
        }}
      >
        <input
          value={own}
          onChange={(e) => setOwn(e.target.value)}
          placeholder={ask?.options?.length ? 'Eller skriv ett eget svar…' : 'Svara…'}
          aria-label={`Svar till ${nameOf(role) ?? card.agent}`}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !own.trim()}>
          Skicka
        </button>
      </form>
      {error && <p className="composer-error">{error}</p>}
    </article>
  );
}

/** Open PRs, one row per PR: nothing more happens on them until someone merges. */
function openPrs(board: TeamBoard): Subtask[] {
  const seen = new Set<number>();
  return board.subtasks.filter((s) => {
    if (s.team !== board.team.id || s.status !== 'pr-open' || s.prNumber == null || seen.has(s.prNumber)) return false;
    seen.add(s.prNumber);
    return true;
  });
}

/**
 * What the owner can do with a notice. Klart: done what it asked, and the agent
 * that wrote it hears so and goes on. Öppna: the agent's card, to ask or change
 * course. Stäng: out of the inbox, nobody told.
 */
function NoticeActions({ notice, team, card, name }: { notice: Notice; team: string; card?: Subtask; name?: string }) {
  const [busy, setBusy] = useState(false);
  const act = (what: 'done' | 'close') => {
    setBusy(true);
    void post(`/api/notices/${notice.id}/${what}`).finally(() => setBusy(false));
  };
  return (
    <div className="notice-actions">
      {card && (
        <button type="button" className="btn btn-merged" disabled={busy} onClick={() => act('done')} title={`Markera som gjort och säg det till ${name ?? 'agenten'}`}>
          Klart
        </button>
      )}
      {card && (
        <a className="btn btn-quiet" href={`#/${team}/office/card/${card.id}`}>
          Öppna
        </a>
      )}
      <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => act('close')} title="Ta bort ur inkorgen utan att säga något">
        Stäng
      </button>
    </div>
  );
}

function PrGlyph() {
  return (
    <span className="pr-glyph" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="16" height="16">
        <circle cx="6" cy="5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="6" cy="19" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="18" cy="19" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M6 7.2v9.6M18 16.8V10a4 4 0 0 0-4-4h-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/** The watch's notice of PRs that wait for the owner's review (server/watch.ts). */
const REVIEW_NOTICE = /^(En PR|\d+ PR:er) väntar på din granskning:/;
const REVIEW_LINE = /^- (\S+) #(\d+) (.*) \(([^()]*)\): (https?:\/\/\S+)$/;

/**
 * PRs that wait for the owner's review, each with a button that hands it to the
 * team leader: does it break anything in his parts, and what was done. The
 * card stops on him with the summary; approving stays his click.
 */
function ReviewNotice({ board, text }: { board: TeamBoard; text: string }) {
  const lead = board.roles.find((r) => r.kind === 'lead');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prs = text
    .split('\n')
    .map((l) => REVIEW_LINE.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(([, repo, number, title, author, url]) => ({ repo, number, title, author, url }));
  const delegate = async (url: string, title: string) => {
    setBusy(url);
    setError(null);
    try {
      await post(`/api/teams/${board.team.id}/review`, { url, title });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="notice notice-review">
      <Avatar team={board.team.id} role={lead} size="sm" />
      <div>
        <p>{prs.length === 1 ? 'En PR väntar på din granskning:' : `${prs.length} PR:er väntar på din granskning:`}</p>
        <ul className="review-list">
          {prs.map((pr) => {
            // A card about this PR already: where it is, instead of the button.
            const card = board.subtasks.find((s) => s.brief.includes(pr.url) && s.status !== 'failed');
            return (
              <li key={pr.url}>
                <a href={pr.url} target="_blank" rel="noreferrer">
                  {board.team.repos.length > 1 ? `${pr.repo} ` : ''}#{pr.number}
                </a>{' '}
                {pr.title} <span className="settings-muted">({pr.author})</span>
                <span className="review-action">
                  {card ? (
                    <a href={`#/${board.team.id}/office/card/${card.id}`}>
                      {card.status === 'done' ? 'Granskad' : card.status === 'needs-you' ? 'Granskad, väntar på dig' : `${calledOr(lead, 'Teamleadern')} granskar`} (#{card.id})
                    </a>
                  ) : (
                    <button type="button" className="btn btn-quiet" disabled={busy !== null} onClick={() => void delegate(pr.url, pr.title)}>
                      {busy === pr.url ? `Ger den till ${calledOr(lead, 'teamleadern')}…` : `Låt ${calledOr(lead, 'teamleadern')} granska`}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        {error && <p className="composer-error">{error}</p>}
      </div>
    </div>
  );
}

function Inbox({ board }: { board: TeamBoard }) {
  const roles = new Map(board.roles.map((r) => [r.id, r]));
  const cards = new Map(board.subtasks.map((s) => [s.id, s]));
  const approvals = board.approvals.filter((a) => a.team === board.team.id);
  const notices = board.notices.filter((n) => n.team === board.team.id && !n.closedAt).slice(0, 12);
  const waiting = board.subtasks.filter((s) => s.status === 'needs-you');
  const prs = openPrs(board);
  // A PR waiting for someone else's approval is not the owner's to merge yet.
  const merges = prs.filter((s) => !awaitsReview(s));
  const reviewing = prs.filter(awaitsReview);
  // The owner's own PRs that no card holds: the same, without a card to link.
  const mine = board.ownPrs[board.team.id] ?? [];
  const blocked = (p: OwnPr) => p.review.state === 'waiting' || p.review.state === 'changes';
  const many = board.team.repos.length > 1;
  const ownRow = (p: OwnPr, waits: boolean) => (
    <div key={`own-${p.url}`} className={`inbox-item inbox-merge ${waits ? 'inbox-reviewing' : ''}`}>
      {!waits && <PrGlyph />}
      <span className="inbox-merge-main">
        <span>
          <a href={p.url} target="_blank" rel="noreferrer">
            {waits ? `PR #${p.number}` : <strong>Merga PR #{p.number}</strong>}
          </a>{' '}
          · din{many ? ` i ${p.repo}` : ''}
          {waits && (
            <>
              {' · '}
              <span title={reviewText(p)}>{reviewText(p, { short: true })}</span>
            </>
          )}
        </span>
        <span className="inbox-text">{p.title.slice(0, 140)}</span>
      </span>
    </div>
  );
  const myMerges = mine.filter((p) => !blocked(p));
  const myWaits = mine.filter(blocked);
  if (!approvals.length && !notices.length && !waiting.length && !prs.length && !mine.length) return null;
  return (
    <section className="inbox" aria-label="Inkorgen">
      <h2 className="section-title">Inkorgen</h2>
      {(approvals.length > 0 || waiting.length > 0) && <p className="inbox-sub">Kräver beslut</p>}
      {approvals.map((a) => (
        <ApprovalCard key={a.id} approval={a} team={board.team.id} role={a.subtaskId != null ? roles.get(cards.get(a.subtaskId)?.agent ?? '') : undefined} />
      ))}
      {waiting.map((s) => (
        <Decision key={s.id} card={s} team={board.team.id} role={roles.get(s.agent)} owner={board.owner} />
      ))}
      {merges.length + myMerges.length > 0 && <p className="inbox-sub">Att merga</p>}
      {merges.map((s) => (
        <div key={s.id} className="inbox-item inbox-merge">
          <PrGlyph />
          <span className="inbox-merge-main">
            <span>
              <a href={s.prUrl ?? `#/${board.team.id}/office/card/${s.id}`} target="_blank" rel="noreferrer">
                <strong>Merga PR #{s.prNumber}</strong>
              </a>{' '}
              · <a href={`#/${board.team.id}/office/card/${s.id}`}>{nameOf(roles.get(s.agent)) ?? s.agent} #{s.id}</a>
            </span>
            <span className="inbox-text">{s.brief.split('\n')[0].slice(0, 140)}</span>
            <MergedButton subtask={s} compact />
          </span>
        </div>
      ))}
      {myMerges.map((p) => ownRow(p, false))}
      {reviewing.length + myWaits.length > 0 && <p className="inbox-sub">Väntar på granskning</p>}
      {myWaits.map((p) => ownRow(p, true))}
      {reviewing.map((s) => (
        <div key={s.id} className="inbox-item inbox-merge inbox-reviewing">
          <span className="inbox-merge-main">
            <span>
              <a href={s.prUrl ?? `#/${board.team.id}/office/card/${s.id}`} target="_blank" rel="noreferrer">
                PR #{s.prNumber}
              </a>{' '}
              · <a href={`#/${board.team.id}/office/card/${s.id}`}>{nameOf(roles.get(s.agent)) ?? s.agent} #{s.id}</a> · <span title={reviewText(s)}>{reviewText(s, { short: true })}</span>
            </span>
            <span className="inbox-text">{s.brief.split('\n')[0].slice(0, 140)}</span>
          </span>
        </div>
      ))}
      {notices.map((n) => {
        const from = n.subtaskId != null ? cards.get(n.subtaskId) : undefined;
        const role = from ? roles.get(from.agent) : board.roles.find((r) => r.kind === 'lead');
        return (
          <div key={n.id} className="notice-wrap">
            {REVIEW_NOTICE.test(n.text) ? (
              <ReviewNotice board={board} text={n.text} />
            ) : (
              <div className="notice">
                <Avatar team={board.team.id} role={role} size="sm" />
                <NoticeBody notice={n} board={board} />
              </div>
            )}
            <NoticeActions notice={n} team={board.team.id} card={from} name={nameOf(role)} />
          </div>
        );
      })}
    </section>
  );
}

const CARD_REF = /(?<![\w/]|PR\s?|PR)#(\d+)\b/g;

/**
 * A notice line by line. A line whose cards or PRs have all moved on since the
 * notice was written (done, merged) is struck out with "klart", so a list of
 * three things shows which one is left. Card numbers link to the card, with
 * where it stands now.
 */
function NoticeBody({ notice, board }: { notice: Notice; board: TeamBoard }) {
  const cards = new Map(board.subtasks.map((s) => [s.id, s]));
  const roles = new Map(board.roles.map((r) => [r.id, r]));
  const own = notice.subtaskId != null;
  // Only a card's own notice names cards; a review list's "#52" is someone's PR.
  const withCards = (part: string, key: number): ReactNode[] => {
    const out: ReactNode[] = [];
    let last = 0;
    for (const m of part.matchAll(CARD_REF)) {
      const card = own ? cards.get(Number(m[1])) : undefined;
      if (!card) continue;
      if (m.index > last) out.push(part.slice(last, m.index));
      out.push(
        <a key={`${key}-${m.index}`} className="card-ref" href={`#/${board.team.id}/office/card/${card.id}`} title={`Kort #${card.id}, ${nameOf(roles.get(card.agent)) ?? card.agent}`}>
          #{card.id}
          <StatusBadge status={shownStatus(card, board.subtasks)} />
        </a>,
      );
      last = m.index + m[0].length;
    }
    if (last < part.length) out.push(part.slice(last));
    return out;
  };
  const lines = notice.text.split('\n');
  return (
    <div className="notice-body">
      <When at={notice.at} />
      {lines.map((line, i) => {
        const done = own && lineSettled(line, board.subtasks, notice.at);
        return (
          <p key={i} className={done ? 'notice-line is-settled' : 'notice-line'}>
            {line ? linkify(line, withCards) : '\u00a0'}
            {done && <span className="notice-done">klart</span>}
          </p>
        );
      })}
    </div>
  );
}

function BoardColumn({ board, openId }: { board: TeamBoard; openId: number | null }) {
  const roles = useMemo(() => new Map(board.roles.map((r) => [r.id, r])), [board.roles]);
  const [showDone, setShowDone] = useState(false);

  const tasks = useMemo(() => {
    const byTask = new Map<number, Subtask[]>();
    for (const s of board.subtasks) byTask.set(s.taskId, [...(byTask.get(s.taskId) ?? []), s]);
    return board.tasks
      .map((t) => {
        const cards = byTask.get(t.id) ?? [];
        return { task: t, cards, rank: Math.min(...cards.map((c) => ORDER[c.status]), 9) };
      })
      .sort((a, b) => a.rank - b.rank || b.task.id - a.task.id);
  }, [board.tasks, board.subtasks]);

  const active = tasks.filter((t) => t.cards.some((c) => c.status !== 'done' && c.status !== 'failed'));
  const finished = tasks.filter((t) => !active.includes(t));

  const renderTask = ({ task, cards }: (typeof tasks)[number]) => {
    const done = cards.filter((c) => c.status === 'done').length;
    const agents = [...new Set(cards.map((c) => c.agent))];
    return (
      <li key={task.id} className="task">
        <header className="task-head">
          <h3 className="task-title">{task.title}</h3>
          <span className="stack" aria-label={`${agents.length} agenter`}>
            {agents.slice(0, 6).map((a) => (
              <Avatar key={a} team={board.team.id} role={roles.get(a)} size="sm" />
            ))}
          </span>
        </header>
        {cards.length > 1 && (
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={cards.length} aria-valuenow={done}>
            <span style={{ width: `${(done / cards.length) * 100}%` }} />
          </div>
        )}
        <div className="task-cards">
          {tree(cards).map(({ card, depth }) => (
            <CardRow
              key={card.id}
              subtask={card}
              team={board.team.id}
              role={roles.get(card.agent)}
              depth={depth}
              all={board.subtasks}
              open={card.id === openId}
              onOpen={() => (location.hash = `#/${board.team.id}/office/card/${card.id}`)}
            />
          ))}
        </div>
      </li>
    );
  };

  return (
    <aside className="board-column" aria-label="Boarden">
      <NewTask board={board} />
      <Inbox board={board} />
      {tasks.length === 0 && (
        <div className="empty-state">
          <p className="empty-title">Kontoret är tyst.</p>
          <p>Ge {calledOr(board.roles.find((r) => r.kind === 'lead'), 'teamleadern')} något att göra, eller klistra in en fyndlista till {calledOr(board.roles.find((r) => r.kind === 'bug'), 'Bug')}.</p>
        </div>
      )}
      {active.length > 0 && <h2 className="section-title">Pågår</h2>}
      <ul className="tasks">{active.map(renderTask)}</ul>
      {finished.length > 0 && (
        <>
          <button type="button" className="btn btn-quiet section-toggle" onClick={() => setShowDone(!showDone)} aria-expanded={showDone}>
            Klart <span className="num">{finished.length}</span>
          </button>
          {showDone && <ul className="tasks tasks-done">{finished.map(renderTask)}</ul>}
        </>
      )}
    </aside>
  );
}

/** A card, opened over the office from the right. */
function CardDrawer({ board, id, loadEvents }: { board: TeamBoard; id: number; loadEvents: (id: number) => Promise<void> }) {
  const open = board.subtasks.find((s) => s.id === id);
  const close = () => (location.hash = `#/${board.team.id}/office`);
  if (!open) return null;
  return (
    <Modal label={`Kort ${open.id}`} onClose={close} drawer>
      <CardDetail
        onClose={close}
        all={board.subtasks}
        subtask={open}
        role={board.roles.find((r) => r.id === open.agent)}
        team={board.team.id}
        parent={open.parentId != null ? board.subtasks.find((s) => s.id === open.parentId) : undefined}
        events={board.events[open.id] ?? []}
        loadEvents={loadEvents}
        generation={board.generation}
        owner={board.owner}
      />
    </Modal>
  );
}

/**
 * A view that throws must not blank the whole page: the top bar stays, the
 * error is shown, and the other views still work. Most often the page is newer
 * than a server that has not restarted yet.
 */
class ViewBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty-state view-error">
        <p className="empty-title">Den här vyn kunde inte visas.</p>
        <p>Oftast är webben nyare än servern: den startar om när agenterna är klara, och sidan laddar om sig själv då. De andra vyerna fungerar under tiden.</p>
        <p className="mono settings-muted">{this.state.error.message}</p>
        <button type="button" className="btn" onClick={() => location.reload()}>
          Ladda om
        </button>
      </div>
    );
  }
}

const BOARD_WIDTH_KEY = 'board-width';

/** The left panel's width in px, dragged by the owner and remembered in this browser; null: the default. */
function useBoardWidth(): [number | null, (w: number | null) => void] {
  const [width, setWidth] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(BOARD_WIDTH_KEY));
      return v > 0 ? v : null;
    } catch {
      return null;
    }
  });
  const set = (w: number | null) => {
    setWidth(w);
    try {
      if (w == null) localStorage.removeItem(BOARD_WIDTH_KEY);
      else localStorage.setItem(BOARD_WIDTH_KEY, String(Math.round(w)));
    } catch {
      // Not remembered in a private window.
    }
  };
  return [width, set];
}

/**
 * The handle on the left panel's edge: drag to make it wider or narrower, never
 * narrower than it is by default; a double click goes back to the default.
 */
function BoardResizer({ width, onWidth }: { width: number | null; onWidth: (w: number | null) => void }) {
  const [dragging, setDragging] = useState(false);
  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    const column = document.querySelector<HTMLElement>('.board-column');
    if (!column) return;
    e.preventDefault();
    const min = parseFloat(getComputedStyle(column).minWidth) || column.getBoundingClientRect().width;
    const max = Math.max(min, window.innerWidth * 0.6);
    const left = column.getBoundingClientRect().left;
    setDragging(true);
    const move = (ev: PointerEvent) => onWidth(Math.min(max, Math.max(min, ev.clientX - left)));
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      className={`board-resizer ${dragging ? 'is-dragging' : ''}`}
      style={{ left: width ? `${width}px` : undefined }}
      role="separator"
      aria-orientation="vertical"
      aria-label="Ändra panelens bredd"
      title="Dra för att ändra bredden, dubbelklicka för standard"
      onPointerDown={start}
      onDoubleClick={() => onWidth(null)}
    >
      <span className="board-resizer-grip" aria-hidden="true">
        ‹›
      </span>
    </div>
  );
}

/** What an agent does when nobody needs it. Office life. */
const IDLE = [
  'Fikar.',
  'Vattnar kontorsväxten.',
  'Sorterar sina pennor efter färg.',
  'Läser release notes för nöjes skull.',
  'Spelar pingis med testaren.',
  'Byter tangentbord. Igen.',
  'Diskar sin kaffekopp.',
  'Har möte med sig själv.',
  'Ritar flödesscheman på en servett.',
  'Väntar på att kompilatorn ska bli klar. Av gammal vana.',
  'Testar en ny kaffesort i automaten.',
  'Tränar på att säga nej till möten.',
  'Organiserar om sin skrivbordsbakgrund.',
  'Skriver haikus i commit-meddelanden. I huvudet.',
  'Lagar det fladdrande lysröret med ett gem.',
];

function Desk({ role, board, index, loadEvents, life }: { role: Role; board: TeamBoard; index: number; loadEvents: (id: number) => Promise<void>; life: Director }) {
  // Free: what they are up to in the office right now (and what they just said).
  useLifeTick(1000);
  const now = life.agents.get(role.id);
  const up = doing(life, role.id);
  const mine = board.subtasks.filter((s) => s.agent === role.id);
  const current =
    mine.find((s) => s.status === 'running') ??
    mine.find((s) => s.status === 'needs-you') ??
    mine.find((s) => s.status === 'watching' && board.tasks.find((t) => t.id === s.taskId)?.title !== 'Boarden');
  const queue = mine.filter((s) => s.status === 'queued');
  const done = mine.filter((s) => s.status === 'done').length;
  const isMine = (id: number) => mine.some((s) => s.id === id);
  const label = (r: string) => r.replace(/^[\w-]+:/, '');
  const locks = [
    ...Object.entries(board.locks)
      .filter(([, id]) => isMine(id))
      .map(([r]) => ({ r, text: label(r), title: 'Låst åt agenten' })),
    ...Object.entries(board.lockQueues ?? {}).flatMap(([r, q]) => [
      ...(q.sharing.some(isMine) ? [{ r, text: `${label(r)} (delar)`, title: `Delar instansen med kort #${board.locks[r]}` }] : []),
      ...(q.waiting.some(isMine) ? [{ r, text: `väntar på ${label(r)}`, title: `Används av kort #${board.locks[r]}` }] : []),
    ]),
  ];
  const events = current ? (board.events[current.id] ?? []) : [];
  const lastSaid = [...events].reverse().find((e) => e.kind === 'text' || e.kind === 'tool');

  useEffect(() => {
    if (current) void loadEvents(current.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, board.generation]);

  return (
    <section className={`desk ${current ? `desk-${current.status}` : 'desk-idle'}`} aria-label={nameOf(role)}>
      <a className="desk-top" href={`#/${board.team.id}/office/agent/${role.id}`} title={`Inställningar för ${nameOf(role)}`}>
        <Avatar team={board.team.id} role={role} size="xl" status={current?.status} />
        <div className="desk-who">
          <h2>{nameOf(role)}</h2>
          <p className="desk-title">{role.nick ? `${role.name} · ${role.title}` : role.title}</p>
          <p className="desk-model">
            {role.model}
            {role.wakeModel ? ` · ${role.wakeModel} vid uppföljning` : ''}
          </p>
        </div>
      </a>
      <div className={`speech ${current ? '' : 'speech-idle'}`}>
        {current
          ? lastSaid
            ? lastSaid.body.replace(/^mcp__control-room__/, '')
            : 'Kommer igång…'
          : up
            ? `${up}${now?.say ? ` · ”${now.say}”` : ''}`
            : IDLE[(index + new Date().getHours()) % IDLE.length]}
      </div>
      {role.vibe && <p className="desk-vibe">{role.vibe}</p>}
      <footer className="desk-foot">
        {current ? (
          <a href={`#/${board.team.id}/office/card/${current.id}`} className="desk-card">
            <StatusBadge status={shownStatus(current, board.subtasks)} /> <span>#{current.id}</span>
          </a>
        ) : (
          <span className="badge">{now && now.duty !== 'free' ? DUTY_BADGE[now.duty] ?? 'Ledig' : 'Ledig'}</span>
        )}
        {queue.length > 0 && <span className="desk-stat num">{queue.length} i kö</span>}
        {done > 0 && <span className="desk-stat num">{done} klara</span>}
        {locks.map((l) => (
          <span key={`${l.r}-${l.text}`} className="chip" title={l.title}>
            {l.text}
          </span>
        ))}
      </footer>
      {current && events.length > 0 && (
        <details className="desk-log">
          <summary>Visa loggen</summary>
          <Log events={events.slice(-40)} team={board.team.id} role={role} />
        </details>
      )}
    </section>
  );
}

/** A duty with no running card on the desk, as a badge. */
const DUTY_BADGE: Partial<Record<Duty, string>> = {
  queue: 'I kö',
  sleep: 'Kvoten slut',
  despair: 'Misslyckades',
};

const KIND_ORDER = { lead: 0, architect: 1, bug: 2, designer: 3, app: 4, tester: 5 } as const;

/** The office as desks or in 3D, remembered on this device. */
function useOfficeMode(): ['desks' | '3d', (m: 'desks' | '3d') => void] {
  const [mode, setMode] = useState<'desks' | '3d'>(() => {
    try {
      return localStorage.getItem('office.mode') === '3d' ? '3d' : 'desks';
    } catch {
      return 'desks';
    }
  });
  return [
    mode,
    (m) => {
      setMode(m);
      try {
        localStorage.setItem('office.mode', m);
      } catch {
        // Only a convenience.
      }
    },
  ];
}

// The 3D office is its own chunk: three.js loads only when it is shown.
const Office3D = lazy(() => import('./office3d/Office3D.tsx'));

function Office({
  board,
  loadEvents,
  cardId,
  agentId,
  consultantId,
}: {
  board: TeamBoard;
  loadEvents: (id: number) => Promise<void>;
  cardId: number | null;
  agentId: string | null;
  consultantId: string | null;
}) {
  // Who is busy comes first: working, then waiting for the owner, then the rest; idle desks last.
  const busy = (r: Role) => {
    const mine = board.subtasks.filter((s) => s.agent === r.id && board.tasks.find((t) => t.id === s.taskId)?.title !== 'Boarden');
    const has = (st: Subtask['status']) => mine.some((s) => s.status === st);
    if (has('running') || has('testing')) return 0;
    if (has('needs-you')) return 1;
    if (has('watching') || has('quota') || has('queued')) return 2;
    return 3;
  };
  const roles = [...board.roles].sort((a, b) => busy(a) - busy(b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const agent = agentId ? board.roles.find((r) => r.id === agentId) : undefined;
  const consultant = consultantId ? (board.consultants[board.team.id] ?? []).find((c) => c.id === consultantId) : undefined;
  const [mode, setMode] = useOfficeMode();
  const approvals = useMemo(() => board.approvals.filter((a) => a.team === board.team.id), [board.approvals, board.team.id]);
  const [boardWidth, setBoardWidth] = useBoardWidth();
  // The office goes on in either view: the desks say what the people in 3D are doing.
  const life = useOfficeLife(board.team.id, board.roles, board.subtasks, board.tasks, approvals);
  return (
    <div className="office-layout" style={{ '--board-width': boardWidth ? `${boardWidth}px` : undefined } as CSSProperties}>
      <BoardColumn board={board} openId={cardId} />
      <BoardResizer width={boardWidth} onWidth={setBoardWidth} />
      <div className="office-main">
        <div className="office-bar">
          {mode === '3d' ? <ConsultantFaces list={board.consultants[board.team.id] ?? []} team={board.team.id} consultations={board.consultations} /> : <span />}
        <div className="segmented office-mode" role="tablist" aria-label="Visa kontoret som">
          <button type="button" role="tab" aria-selected={mode === 'desks'} onClick={() => setMode('desks')}>
            Skrivbord
          </button>
          <button type="button" role="tab" aria-selected={mode === '3d'} onClick={() => setMode('3d')}>
            Kontoret 3D
          </button>
        </div>
        </div>
        {mode === '3d' ? (
          <Suspense fallback={<p className="empty">Bygger kontoret…</p>}>
            <Office3D
              director={life}
              team={board.team.id}
              roles={board.roles}
              subtasks={board.subtasks}
              tasks={board.tasks}
              approvals={approvals}
              onOpenCard={(id) => (location.hash = `#/${board.team.id}/office/card/${id}`)}
              onOpenAgent={(id) => (location.hash = `#/${board.team.id}/office/agent/${id}`)}
            />
          </Suspense>
        ) : (
          <div className="office">
            {roles.map((r, i) => (
              <Desk key={r.id} role={r} board={board} index={i} loadEvents={loadEvents} life={life} />
            ))}
            {(board.consultants[board.team.id] ?? []).map((c) => (
              <ConsultantDesk key={`c-${c.id}`} c={c} team={board.team.id} roles={board.roles} consultations={board.consultations} />
            ))}
          </div>
        )}
      </div>
      {cardId != null && <CardDrawer board={board} id={cardId} loadEvents={loadEvents} />}
      {agent && <AgentSettings key={agent.id} team={board.team} role={agent} onClose={() => (location.hash = `#/${board.team.id}/office`)} />}
      {consultant && (
        <Modal label={consultant.name} onClose={() => (location.hash = `#/${board.team.id}/office`)} drawer>
          <ConsultantPanel c={consultant} team={board.team.id} roles={board.roles} consultations={board.consultations} onClose={() => (location.hash = `#/${board.team.id}/office`)} />
        </Modal>
      )}
    </div>
  );
}

const PLAN_LABEL: Record<PlanStatus, string> = {
  draft: 'Utkast',
  ready: 'Klar att ta ställning till',
  parked: 'Parkerad',
  implementing: 'Genomförs',
  done: 'Genomförd',
  discarded: 'Kastad',
};

const PLAN_BADGE: Record<PlanStatus, string> = {
  draft: 'badge',
  ready: 'badge badge-needs-you',
  parked: 'badge',
  implementing: 'badge badge-running',
  done: 'badge badge-done',
  discarded: 'badge',
};

function PlanActions({ plan }: { plan: Plan }) {
  const [busy, setBusy] = useState(false);
  const act = (action: string) => async () => {
    setBusy(true);
    await post(`/api/plans/${plan.id}/${action}`).catch(() => undefined);
    setBusy(false);
  };
  return (
    <div className="plan-actions">
      {(plan.status === 'ready' || plan.status === 'draft' || plan.status === 'parked') && (
        <button type="button" className="btn btn-primary" onClick={act('implement')} disabled={busy}>
          Genomför
        </button>
      )}
      {(plan.status === 'ready' || plan.status === 'draft') && (
        <button type="button" className="btn" onClick={act('park')} disabled={busy}>
          Parkera
        </button>
      )}
      {(plan.status === 'parked' || plan.status === 'discarded') && (
        <button type="button" className="btn" onClick={act('unpark')} disabled={busy}>
          Ta upp igen
        </button>
      )}
      {plan.status !== 'implementing' && plan.status !== 'done' && plan.status !== 'discarded' && (
        <button type="button" className="btn btn-quiet" onClick={act('discard')} disabled={busy}>
          Kasta
        </button>
      )}
    </div>
  );
}

const PLAN_ORDER: Record<PlanStatus, number> = { ready: 0, draft: 1, implementing: 2, parked: 3, done: 4, discarded: 5 };

function Plans({ board, openId }: { board: TeamBoard; openId: number | null }) {
  const architect = board.roles.find((r) => r.kind === 'architect');
  const plans = board.plans
    .filter((p) => p.team === board.team.id)
    .sort((a, b) => PLAN_ORDER[a.status] - PLAN_ORDER[b.status] || b.updatedAt.localeCompare(a.updatedAt));
  const open = plans.find((p) => p.id === openId) ?? plans.find((p) => p.status === 'ready') ?? plans[0];
  const card = open && board.subtasks.find((s) => s.id === open.subtaskId);
  const drafting = board.subtasks.filter(
    (s) => s.agent === architect?.id && !plans.some((p) => p.subtaskId === s.id) && s.status !== 'done' && s.status !== 'failed',
  );

  if (!plans.length && !drafting.length)
    return (
      <div className="empty-state plans-empty">
        <Avatar team={board.team.id} role={architect} size="xl" />
        <p className="empty-title">Inga planer än.</p>
        <p>Välj Planera på boarden och beskriv featuren. {calledOr(architect, 'Arkitekten')} ritar, du bestämmer.</p>
      </div>
    );

  return (
    <div className="plans">
      <nav className="plan-list" aria-label="Planer">
        {drafting.map((s) => (
          <a key={`d${s.id}`} className="plan-item" href={`#/${board.team.id}/office/card/${s.id}`}>
            <span className="plan-item-title">{s.brief.split('\n')[0]}</span>
            <span className="badge badge-running">{calledOr(architect, 'Arkitekten')} ritar</span>
          </a>
        ))}
        {plans.map((p) => (
          <a
            key={p.id}
            className={`plan-item ${p.id === open?.id ? 'is-open' : ''}`}
            href={`#/${board.team.id}/plans/${p.id}`}
            aria-current={p.id === open?.id ? 'true' : undefined}
          >
            <span className="plan-item-title">{p.title}</span>
            <span className={PLAN_BADGE[p.status]}>{PLAN_LABEL[p.status]}</span>
          </a>
        ))}
      </nav>
      {open && (
        <article className="plan">
          <header className="plan-head">
            <Avatar team={board.team.id} role={architect} size="lg" />
            <div className="plan-head-main">
              <p className="eyebrow">
                Plan #{open.id} · uppdaterad {new Date(open.updatedAt).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })}
              </p>
              <h2>{open.title}</h2>
              <span className={PLAN_BADGE[open.status]}>{PLAN_LABEL[open.status]}</span>
            </div>
          </header>
          <PlanActions plan={open} />
          <Markdown source={open.body} />
          <footer className="plan-foot">
            {card && <a href={`#/${board.team.id}/office/card/${card.id}`}>Prata med {calledOr(architect, 'arkitekten')} om planen (kort #{card.id})</a>}
            {open.taskId != null && (
              <span>
                Genomförs som uppgift {open.taskId}.{' '}
                {(() => {
                  const lead = board.subtasks.find((s) => s.taskId === open.taskId && s.parentId == null);
                  return lead ? <a href={`#/${board.team.id}/office/card/${lead.id}`}>Följ den</a> : null;
                })()}
              </span>
            )}
          </footer>
        </article>
      )}
    </div>
  );
}

/** When a window resets: the time today, the weekday and time otherwise. */
function resetTime(at: Date, now: Date): string {
  const time = at.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString('sv-SE', { weekday: 'short' })} ${time}`;
}

/** What is left, coarse enough to read at a glance: "2 d 5 h", "1 h 23 min", "4 min". */
function countdown(ms: number): string {
  const min = Math.ceil(ms / 60000);
  if (min <= 1) return 'under en minut';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

/** The current time, moved on every half minute so countdowns tick. */
function useNow(every = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), every);
    return () => clearInterval(id);
  }, [every]);
  return now;
}

/** How far into its account's subscription windows the team is. Moves only when an agent runs. */
function UsageMeter({ usage, account }: { usage: Usage | null; account?: Account }) {
  const now = useNow();
  const windows = [
    ['5 h', usage?.fiveHour],
    ['Vecka', usage?.weekly],
  ] as const;
  const age = usage ? Math.round((now.getTime() - Date.parse(usage.seenAt)) / 60000) : null;
  return (
    <div className="usage" title={`${account ? `Konto: ${account.name}. ` : ''}${usage ? `Senast avläst för ${age} min sedan, när en agent körde.` : 'Ingen avläsning än. Den kommer med första agenten.'}`}>
      {account && <span className="usage-account">{account.name}</span>}
      {windows.map(([label, w]) => {
        const at = w?.resetsAt ? new Date(w.resetsAt) : null;
        const left = at ? at.getTime() - now.getTime() : null;
        // Past its reset the figure is the old window's; the next agent run brings the new one.
        const reset = left != null && left <= 0;
        const pct = w && !reset ? Math.round(w.utilization * 100) : reset ? 0 : null;
        const level = pct == null ? '' : pct >= 90 ? 'usage-high' : pct >= 70 ? 'usage-mid' : '';
        const when = at == null ? 'okänt' : reset ? 'återställd' : `${resetTime(at, now)} · om ${countdown(left!)}`;
        return (
          <div key={label} className={`usage-row ${level}`}>
            <span className="usage-label">{label}</span>
            <span
              className="usage-bar"
              role="meter"
              aria-label={`${label}: ${pct ?? 'okänt'} procent, återställs ${when}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct ?? 0}
            >
              <span style={{ width: `${pct ?? 0}%` }} />
            </span>
            <span className="usage-pct num">{pct == null ? '–' : `${pct}%`}</span>
            <span className="usage-reset num" title={at ? `Återställs ${at.toLocaleString('sv-SE')}` : undefined}>
              {when}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function App() {
  const { board, loadEvents, loadConvEvents, watchDevLog } = useBoard();
  const route = useRoute();
  const { view } = route;
  const team = board.teams.find((t) => t.id === route.team) ?? board.teams[0];
  const teamBoard: TeamBoard | null = useMemo(
    () =>
      team
        ? {
            ...board,
            team,
            roles: team.roles,
            tasks: board.tasks.filter((t) => t.team === team.id),
            subtasks: board.subtasks.filter((s) => s.team === team.id),
          }
        : null,
    [board, team],
  );
  const attention = (id?: string) =>
    board.subtasks.filter((s) => (!id || s.team === id) && s.status === 'needs-you').length +
    board.approvals.filter((a) => !id || a.team === id).length +
    // Each open PR once, however many cards share it; one waiting for someone else's approval is not yet.
    new Set(board.subtasks.filter((s) => (!id || s.team === id) && s.status === 'pr-open' && !awaitsReview(s) && s.prNumber != null).map((s) => `${s.team}#${s.prNumber}`)).size +
    Object.entries(board.ownPrs)
      .filter(([t]) => !id || t === id)
      .flatMap(([, list]) => list)
      .filter((p) => p.review.state !== 'waiting' && p.review.state !== 'changes').length;

  const total = attention();
  // Done, needs you, an approval: a system notification when the window is not in front.
  useSystemNotifications(board);
  // Limits, quota and usage belong to the shown team's Claude account, or the open conversation's.
  const conversation = view === 'gudfadern' ? board.conversations.find((c) => c.id === route.conversationId) : undefined;
  const accountId = view === 'gudfadern' ? (conversation?.account ?? board.accounts.find((a) => a.isDefault)?.id) : team?.account;
  const account = board.accounts.find((a) => a.id === accountId);
  const paused = account ? board.pausedUntil[account.id] : undefined;
  const sameAccount = new Set(board.teams.filter((t) => t.account === accountId).map((t) => t.id));
  const running =
    board.subtasks.filter((s) => s.status === 'running' && sameAccount.has(s.team)).length +
    board.conversations.filter((c) => c.status === 'running' && c.account === accountId).length;
  useEffect(() => {
    document.title = total > 0 ? `(${total}) Kontrollrummet` : 'Kontrollrummet';
    // Inside Kontrollrummet.app the number goes on the Dock icon.
    (window as { webkit?: { messageHandlers?: { badge?: { postMessage: (n: number) => void } } } }).webkit?.messageHandlers?.badge?.postMessage(total);
    // An installed app window on Windows (Edge, Chrome): the same count on its taskbar icon.
    const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    void (total > 0 ? nav.setAppBadge?.(total) : nav.clearAppBadge?.())?.catch(() => undefined);
  }, [total]);

  return (
    <div className="shell">
      <header className="topbar">
        <h1 className="wordmark">
          Kontroll<span>rummet</span>
        </h1>
        <nav aria-label="Team" className="tabs">
          {board.teams.map((t) => (
            <a key={t.id} href={`#/${t.id}/${view === 'gudfadern' || view === 'new' ? 'office' : view}`} aria-current={view !== 'gudfadern' && view !== 'new' && t.id === team?.id ? 'page' : undefined}>
              <Logo team={t} />
              {t.name}
              {attention(t.id) > 0 && <span className="count num">{attention(t.id)}</span>}
            </a>
          ))}
          <a href="#/new" title="Nytt projekt" aria-label="Nytt projekt" aria-current={view === 'new' ? 'page' : undefined}>
            +
          </a>
        </nav>
        {team && view !== 'gudfadern' && view !== 'new' && (
          <nav aria-label="Vyer" className="tabs">
            <a href={`#/${team.id}/office`} aria-current={view === 'office' ? 'page' : undefined}>
              Kontoret
            </a>
            <a href={`#/${team.id}/plans`} aria-current={view === 'plans' ? 'page' : undefined}>
              Planer
              {board.plans.filter((p) => p.team === team.id && p.status === 'ready').length > 0 && (
                <span className="count num">{board.plans.filter((p) => p.team === team.id && p.status === 'ready').length}</span>
              )}
            </a>
            {team.hasReleases && (
              <a href={`#/${team.id}/releases`} aria-current={view === 'releases' ? 'page' : undefined}>
                Releases
              </a>
            )}
            <a href={`#/${team.id}/settings`} aria-current={view === 'settings' ? 'page' : undefined}>
              Inställningar
            </a>
          </nav>
        )}
        {team && view !== 'gudfadern' && view !== 'new' && <DevAppButtons board={board} team={team} watchDevLog={watchDevLog} />}
        <nav aria-label="Gudfadern" className="tabs">
          <a href="#/gudfadern" aria-current={view === 'gudfadern' ? 'page' : undefined}>
            Gudfadern
            {board.approvals.some((a) => a.conversationId) && <span className="count num">{board.approvals.filter((a) => a.conversationId).length}</span>}
          </a>
        </nav>
        <UsageMeter usage={account ? (board.usage[account.id] ?? null) : null} account={board.accounts.length > 1 ? account : undefined} />
        <p className="topbar-status">
          {board.restartPending ? (
            <span className="restart-note">
              Startar om för att ta ändringar i bruk{board.restartWaitingFor ? `, väntar på ${board.restartWaitingFor} ${board.restartWaitingFor > 1 ? 'agenter och byggen' : 'agent eller bygge'}` : ''}…
            </span>
          ) : board.connected && paused && Date.parse(paused) > Date.now() ? (
            <span className="paused">
              Kvoten är slut. Fortsätter {new Date(paused).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}
            </span>
          ) : board.connected ? (
            <>
              <span className="pulse" aria-hidden="true" />
              <span className="num">
                {running}/{board.limits.maxAgents}
              </span>{' '}
              vid tangentbordet
            </>
          ) : (
            <span className="offline">Ingen kontakt med servern</span>
          )}
          {board.connected && !board.restartPending && (
            <button
              type="button"
              className="icon-btn restart-btn"
              title="Starta om servern (väntar tills inga agenter arbetar)"
              aria-label="Starta om servern"
              onClick={() => {
                if (window.confirm('Starta om servern? Den väntar tills inga agenter arbetar, och bygger om webben.')) void post('/api/restart');
              }}
            >
              ↻
            </button>
          )}
        </p>
        <NotifyToggle />
        <ThemeToggle />
      </header>
      <main>
        <ViewBoundary key={`${view}-${team?.id ?? ''}`}>
        {view === 'new' ? (
          <NewProjectGuide board={board} />
        ) : view === 'gudfadern' ? (
          <Godfather board={board} openId={route.conversationId} loadConvEvents={loadConvEvents} />
        ) : !teamBoard ? (
          <p className="empty">
            {board.connected ? 'Inga team än. Lägg till en mapp under teams/ med en team.json.' : 'Ansluter…'}
          </p>
        ) : view === 'plans' ? (
          <Plans board={teamBoard} openId={route.planId} />
        ) : view === 'settings' ? (
          <ProjectSettings board={board} team={teamBoard.team} />
        ) : view === 'releases' ? (
          <Releases team={teamBoard.team.id} jobs={teamBoard.jobs} />
        ) : (
          <Office board={teamBoard} loadEvents={loadEvents} cardId={route.cardId} agentId={route.agentId} consultantId={route.consultantId} />
        )}
        </ViewBoundary>
      </main>
    </div>
  );
}
