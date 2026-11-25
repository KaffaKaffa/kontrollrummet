import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Linked } from './links.tsx';
import { Lightbox } from './gallery.tsx';
import { When } from './when.tsx';
import { avatarUrl, awaitsReview, nameOf, post, reviewText, type AgentEvent, type Approval, type Role, type Subtask, type SubtaskStatus } from './api.ts';

export const STATUS_LABEL: Record<SubtaskStatus, string> = {
  queued: 'I kö',
  quota: 'Kvotstopp',
  running: 'Arbetar',
  watching: 'Bevakar',
  'needs-you': 'Väntar på dig',
  'pr-open': 'Att merga',
  testing: 'Testas',
  done: 'Klar',
  failed: 'Gick inte',
};

/**
 * A status as the board shows it: `merge-wait` is a watcher whose open cards only wait for a merge,
 * `review-wait` an open PR that waits for someone else's approval.
 */
export type Shown = SubtaskStatus | 'merge-wait' | 'review-wait';

const SHOWN_LABEL: Record<Shown, string> = { ...STATUS_LABEL, 'merge-wait': 'Väntar på merge', 'review-wait': 'Granskas' };

/**
 * What a card is really waiting for. A teamleader or bug card watches its
 * cards; once every one still open is a PR (or watches only PRs in turn),
 * nothing moves until the owner merges, and "Bevakar" would hide that.
 */
export function shownStatus(card: Subtask, all: Subtask[]): Shown {
  const st = settle(card, all);
  return st === 'idle' ? 'watching' : st;
}

/** `idle`: a watcher with nothing open under it, which holds nothing up. */
function settle(card: Subtask, all: Subtask[]): Shown | 'idle' {
  if (awaitsReview(card)) return 'review-wait';
  if (card.status !== 'watching') return card.status;
  const open = all
    .filter((c) => c.parentId === card.id && c.id !== card.id)
    .map((c) => settle(c, all))
    .filter((st) => st !== 'done' && st !== 'failed' && st !== 'idle');
  if (!open.length) return 'idle';
  return open.every((st) => st === 'pr-open' || st === 'merge-wait' || st === 'review-wait') ? 'merge-wait' : 'watching';
}

export function StatusBadge({ status }: { status: Shown }) {
  return <span className={`badge badge-${status}`}>{SHOWN_LABEL[status]}</span>;
}

/**
 * "Mergad": the owner says they merged, and the server asks GitHub at once instead
 * of at its next round. GitHub decides; if the PR is still open it says so.
 */
export function MergedButton({ subtask, compact }: { subtask: Subtask; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const check = async (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    setNote(null);
    try {
      const r = (await post(`/api/subtasks/${subtask.id}/merged`)) as { state: string };
      if (r.state === 'OPEN') setNote(`PR #${subtask.prNumber} är inte mergad på GitHub än.`);
      if (r.state === 'CONFLICTING') setNote(`PR #${subtask.prNumber} har merge-konflikter. Agenten löser dem.`);
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className={`merged ${compact ? 'merged-compact' : ''}`}>
      <button type="button" className="btn btn-merged" onClick={check} disabled={busy}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {busy ? 'Kollar…' : 'Mergad'}
      </button>
      {note && (
        <span className="merged-note" role="status">
          {note}
        </span>
      )}
    </span>
  );
}

/** A role's portrait, or its initials when the picture is missing. */
export function Avatar({
  team,
  role,
  size = 'md',
  status,
}: {
  team: string;
  role: Role | undefined;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  status?: Shown;
}) {
  const [broken, setBroken] = useState(false);
  const name = nameOf(role) ?? '?';
  return (
    <span className={`avatar avatar-${size} ${status ? `ring-${status}` : ''}`} title={name}>
      {role && !broken ? (
        <img src={avatarUrl(team, role)} alt="" onError={() => setBroken(true)} />
      ) : (
        <span aria-hidden="true">{name.slice(0, 2)}</span>
      )}
    </span>
  );
}

const usd = (n: number) => (n > 0 ? `$${n.toFixed(2)}` : '');

/** One card on the board: who has it, where it is, what came out of it. */
export function CardRow({
  subtask,
  team,
  role,
  depth,
  onOpen,
  open,
  all,
}: {
  subtask: Subtask;
  team: string;
  role?: Role;
  depth: number;
  onOpen: () => void;
  open: boolean;
  /** The board's cards, to tell a watcher that only waits for merges. */
  all?: Subtask[];
}) {
  const shown = all ? shownStatus(subtask, all) : subtask.status;
  return (
    <button
      type="button"
      className={`card-row ${open ? 'is-open' : ''}`}
      style={{ marginLeft: `calc(${depth} * var(--space-24))` }}
      onClick={onOpen}
      aria-current={open ? 'true' : undefined}
    >
      <Avatar team={team} role={role} size="sm" status={shown} />
      <span className="card-row-main">
        <span className="card-row-agent">
          {nameOf(role) ?? subtask.agent} · #{subtask.id}
        </span>
        <span className="card-row-brief">{subtask.brief.split('\n')[0]}</span>
      </span>
      <span className="card-row-meta">
        {subtask.prNumber != null && <span className="pr num">PR #{subtask.prNumber}</span>}
        {subtask.dependsOn.length > 0 && subtask.status === 'queued' && (
          <span className="num">väntar på {subtask.dependsOn.map((d) => `#${d}`).join(' ')}</span>
        )}
        {awaitsReview(subtask) ? (
          <span className="badge badge-review-wait" title={reviewText(subtask)}>
            {reviewText(subtask, { short: true })}
          </span>
        ) : (
          <StatusBadge status={shown} />
        )}
      </span>
    </button>
  );
}

/** The conversation: the agent's words as bubbles, its tools as quiet lines, its pictures inline. */
export function Log({ events, team, role }: { events: Pick<AgentEvent, 'id' | 'kind' | 'body' | 'at'>[]; team: string; role?: Role }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  // Every picture on the card, so the lightbox pages through them all.
  const images = events.filter((e) => e.kind === 'image');
  const pictures = images.map((e) => ({ src: e.body.replace(/^https?:\/\/[^/]+/, ''), name: decodeURIComponent(e.body.split('/').pop() ?? 'Bild') }));
  const [viewing, setViewing] = useState<number | null>(null);
  return (
    <div
      className="log"
      ref={ref}
      role="log"
      aria-live="polite"
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {events.length === 0 && <p className="log-empty">Tyst än så länge.</p>}
      {events.map((e) => {
        switch (e.kind) {
          case 'user': {
            // Wake-ups and replies from other cards start with a [sender] tag; only what the owner typed is a user bubble.
            const from = /^\[([^\]]+)\]\s*/.exec(e.body);
            return from ? (
              <div key={e.id} className="bubble bubble-system">
                <span className="bubble-from">
                  {from[1]} <When at={e.at} />
                </span>
                <Linked text={e.body.slice(from[0].length)} />
              </div>
            ) : (
              <div key={e.id} className="bubble bubble-user">
                <Linked text={e.body} />
                <When at={e.at} className="when-below" />
              </div>
            );
          }
          case 'text':
            return (
              <div key={e.id} className="said">
                <Avatar team={team} role={role} size="sm" />
                <div className="bubble bubble-agent">
                  <Linked text={e.body} />
                  <When at={e.at} className="when-below" />
                </div>
              </div>
            );
          case 'image': {
            const i = images.indexOf(e);
            return (
              <button key={e.id} type="button" className="log-image" onClick={() => setViewing(i)}>
                <img src={pictures[i].src} alt="Bild på kortet" loading="lazy" />
              </button>
            );
          }
          case 'tool':
            return (
              <div key={e.id} className="log-line log-tool">
                <span className="log-kind">›</span>
                <span className="log-body">{e.body.replace(/^mcp__control-room__/, '◆ ')}</span>
              </div>
            );
          default:
            return (
              <div key={e.id} className={`log-line log-${e.kind}`}>
                <span className="log-body">
                  <Linked text={e.body} />
                </span>
                {(e.kind === 'status' || e.kind === 'error') && <When at={e.at} className="when-line" />}
              </div>
            );
        }
      })}
      {viewing != null && <Lightbox pictures={pictures} start={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

/** The shortcut that sends: ⌘↩ on a Mac, Ctrl+↩ elsewhere (both work everywhere). */
const SEND_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘↩' : 'Ctrl+↩';

/** A file the owner attached to a message: uploaded, with a preview until it is sent. */
export interface Attached {
  name: string;
  /** Where the server saved it: named in the message so the agent can read it. */
  path: string;
  /** Served by the board, for images: shown on the card. */
  url?: string;
  preview?: string;
}

const readBase64 = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** An upload to the server's endpoint for it: { path, url? } back. */
export const uploadTo = (endpoint: string) => async (file: File) => {
  const res = (await post(endpoint, { name: file.name, data: await readBase64(file) })) as { path: string; url?: string };
  return { path: res.path, url: res.url };
};

/** The message as the agent gets it: the text, then each file's path to read. */
export function withAttachments(text: string, files: Attached[]): string {
  if (!files.length) return text;
  const body = text.trim() || (files.length > 1 ? 'Se de bifogade bilderna.' : 'Se den bifogade bilden.');
  return `${body}\n\nBifogat (läs med Read):\n${files.map((f) => `- ${f.path}`).join('\n')}`;
}

/** A pasted screenshot is called image.png: a name that says when, and stays unique. */
function named(file: File): File {
  if (file.name && file.name !== 'image.png' && file.name !== 'image.jpg') return file;
  const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  return new File([file], `skarmbild-${stamp}.${ext}`, { type: file.type });
}

export function Composer({
  placeholder,
  submitLabel,
  onSubmit,
  onUpload,
  children,
  rows = 3,
  label,
}: {
  placeholder: string;
  submitLabel: string;
  /** The text with any attachments' paths already in it, and the attachments. */
  onSubmit: (text: string, files: Attached[]) => Promise<unknown>;
  /** Given: images and files can be pasted, dropped or picked, and go with the message. */
  onUpload?: (file: File) => Promise<{ path: string; url?: string }>;
  children?: ReactNode;
  rows?: number;
  label?: string;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Attached[]>([]);
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const attach = async (list: File[]) => {
    if (!onUpload || !list.length) return;
    setError(null);
    setUploading((n) => n + list.length);
    for (const raw of list) {
      const file = named(raw);
      try {
        const saved = await onUpload(file);
        const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
        setFiles((f) => [...f, { name: file.name, ...saved, ...(preview ? { preview } : {}) }]);
      } catch (err) {
        setError(`${file.name}: ${(err as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  const drop = (i: number) =>
    setFiles((f) => {
      if (f[i]?.preview) URL.revokeObjectURL(f[i].preview!);
      return f.filter((_, k) => k !== i);
    });

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if ((!text.trim() && !files.length) || busy || uploading) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(withAttachments(text.trim(), files), files);
      setText('');
      files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
      setFiles([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className={`composer ${over ? 'is-drop' : ''}`}
      onSubmit={submit}
      onDragOver={(e) => {
        if (!onUpload || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!onUpload || !e.dataTransfer.files.length) return;
        e.preventDefault();
        setOver(false);
        void attach([...e.dataTransfer.files]);
      }}
    >
      {(files.length > 0 || uploading > 0) && (
        <ul className="composer-files" aria-label="Bifogat">
          {files.map((f, i) => (
            <li key={f.path}>
              {f.preview ? <img src={f.preview} alt={f.name} /> : <span className="composer-file-name">{f.name}</span>}
              <button type="button" className="composer-file-remove" onClick={() => drop(i)} aria-label={`Ta bort ${f.name}`}>
                ✕
              </button>
            </li>
          ))}
          {uploading > 0 && <li className="composer-file-busy">Laddar upp…</li>}
        </ul>
      )}
      <textarea
        value={text}
        rows={rows}
        placeholder={onUpload ? `${placeholder} Klistra in eller dra hit bilder.` : placeholder}
        aria-label={label ?? placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        }}
        onPaste={(e) => {
          // Images and files from the clipboard (a screenshot, a copied file) go with the message;
          // text pastes as usual.
          const pasted = [...e.clipboardData.files];
          if (!onUpload || !pasted.length) return;
          e.preventDefault();
          void attach(pasted);
        }}
      />
      <div className="composer-bar">
        <div className="composer-extra">
          {onUpload && (
            <label className="btn btn-quiet">
              Bifoga
              <input
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void attach([...(e.target.files ?? [])]);
                  e.target.value = '';
                }}
              />
            </label>
          )}
          {children}
        </div>
        {error && <span className="composer-error">{error}</span>}
        <span className="hint">{SEND_KEY}</span>
        <button type="submit" className="btn btn-primary" disabled={busy || uploading > 0 || (!text.trim() && !files.length)}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Something an agent wants to do that auto mode would not decide alone. */
export function ApprovalCard({ approval, role, team }: { approval: Approval; role?: Role; team: string }) {
  const [busy, setBusy] = useState(false);
  const [always, setAlways] = useState(false);
  const [rules, setRules] = useState((approval.suggestedRules ?? []).join('\n'));
  const [scope, setScope] = useState<'team' | 'global'>('team');
  const [error, setError] = useState<string | null>(null);
  const decide = (allow: boolean) => async () => {
    setBusy(true);
    setError(null);
    await post(`/api/approvals/${approval.id}`, { allow }).catch(() => setBusy(false));
  };
  const allowAlways = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/approvals/${approval.id}`, { allow: true, always: true, scope, rules: rules.split('\n').map((r) => r.trim()).filter(Boolean) });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="approval">
      <Avatar team={team} role={role} size="sm" />
      <div className="approval-main">
        <p>
          <strong>{nameOf(role) ?? (approval.conversationId ? 'Gudfadern' : 'En agent')}</strong> {approval.denied ? 'nekades att köra' : 'vill köra'}{' '}
          <code>{approval.tool}</code>
          {approval.subtaskId != null ? (
            <>
              {' '}
              på <a href={`#/${team}/office/card/${approval.subtaskId}`}>kort #{approval.subtaskId}</a>
            </>
          ) : approval.conversationId ? (
            <>
              {' '}
              i <a href={`#/gudfadern/${approval.conversationId}`}>samtal #{approval.conversationId}</a>
            </>
          ) : null}
        </p>
        <pre className="approval-what">{approval.summary}</pre>
        <When at={approval.at} />
        {approval.denied && <p className="approval-why">{approval.denied} Tillåter du det gäller det för kortet framåt, och agenten kör det igen.</p>}
        <div className="approval-actions">
          <button type="button" className="btn btn-primary" onClick={decide(true)} disabled={busy}>
            {approval.denied ? 'Tillåt och kör om' : 'Godkänn'}
          </button>
          <button type="button" className="btn" onClick={decide(false)} disabled={busy}>
            {approval.denied ? 'Låt bli' : 'Neka'}
          </button>
          {approval.tool === 'Bash' && !always && (
            <button type="button" className="btn" onClick={() => setAlways(true)} disabled={busy}>
              Tillåt alltid…
            </button>
          )}
        </div>
        {always && (
          <div className="approval-always">
            <p className="approval-why">En regel per rad. Ändra den så att den inte blir bredare än du vill.</p>
            <textarea className="approval-rules" rows={Math.max(2, rules.split('\n').length)} value={rules} onChange={(e) => setRules(e.target.value)} spellCheck={false} />
            <label>
              Gäller{' '}
              <select value={scope} onChange={(e) => setScope(e.target.value as 'team' | 'global')}>
                <option value="team">det här projektet</option>
                <option value="global">alla projekt</option>
              </select>
            </label>
            <div className="approval-actions">
              <button type="button" className="btn btn-primary" onClick={allowAlways} disabled={busy || !rules.trim()}>
                Spara och tillåt
              </button>
              <button type="button" className="btn" onClick={() => setAlways(false)} disabled={busy}>
                Avbryt
              </button>
            </div>
          </div>
        )}
        {error && <p className="approval-why">{error}</p>}
      </div>
    </div>
  );
}

/** A card opened: its conversation, a line to the agent, and what can be done with it. */
/**
 * A card stopped because something is logged out: what it is, a button that
 * logs in again (Terminal for a command, the browser for a page), and then one
 * that lets the agent go on, with the message it never got if there was one.
 */
export function LoginPrompt({ subtask, owner }: { subtask: Subtask; owner: string }) {
  const login = subtask.ask?.login;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!login || subtask.status !== 'needs-you') return null;
  const run = async (what: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await what();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const logIn = () =>
    run(async () => {
      if (login.fix) {
        const r = (await post(`/api/subtasks/${subtask.id}/login`)) as { message: string };
        setNote(r.message);
      } else if (login.url) {
        window.open(login.url, '_blank', 'noopener');
        setNote('Logga in i webbläsaren och tryck sedan Fortsätt.');
      }
    });
  const goOn = () =>
    run(() => post(`/api/subtasks/${subtask.id}/messages`, { text: subtask.ask?.retry ?? `${owner} har loggat in igen: ${login.what}. Fortsätt.` }));
  return (
    <div className="login-prompt" role="alert">
      <p>
        <strong>Utloggat:</strong> {login.what}
      </p>
      <div className="login-prompt-actions">
        {(login.fix || login.url) && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void logIn()}>
            Logga in
          </button>
        )}
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void goOn()}>
          Fortsätt
        </button>
      </div>
      {note && <p className="settings-muted">{note}</p>}
      {error && <p className="composer-error">{error}</p>}
    </div>
  );
}

export function CardDetail({
  subtask,
  role,
  team,
  events,
  loadEvents,
  generation,
  parent,
  onClose,
  all,
  owner = 'Ägaren',
}: {
  subtask: Subtask;
  role?: Role;
  team: string;
  events: AgentEvent[];
  loadEvents: (id: number) => Promise<void>;
  generation: number;
  parent?: Subtask;
  /** In the drawer: a close button in the header, which stays put while the log scrolls. */
  onClose?: () => void;
  all?: Subtask[];
  /** Who runs the control room, for the line sent when a login is back. */
  owner?: string;
}) {
  const shown = all ? shownStatus(subtask, all) : subtask.status;
  useEffect(() => {
    void loadEvents(subtask.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtask.id, generation]);
  const act = (action: string) => () => void post(`/api/subtasks/${subtask.id}/${action}`).catch(() => undefined);

  return (
    <section className="detail" aria-label={`Kort ${subtask.id}`}>
      <header className="detail-head">
        <Avatar team={team} role={role} size="lg" status={shown} />
        <div className="detail-title">
          <p className="eyebrow">
            Kort #{subtask.id}
            {parent && (
              <>
                {' '}
                · från <a href={`#/${team}/office/card/${parent.id}`}>#{parent.id}</a>
              </>
            )}
          </p>
          <h2>{nameOf(role) ?? subtask.agent}</h2>
          <StatusBadge status={shown} />
        </div>
        {onClose && (
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Stäng kortet" title="Stäng (Esc)">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
            </svg>
          </button>
        )}
      </header>
      <details className="brief">
        <summary>{subtask.brief.split('\n')[0]}</summary>
        <p>{subtask.brief}</p>
      </details>
      <div className="detail-facts">
        {subtask.prUrl && (
          <a href={subtask.prUrl} target="_blank" rel="noreferrer">
            PR #{subtask.prNumber}
          </a>
        )}
        {subtask.branch && <code className="filename">{subtask.branch}</code>}
        {subtask.costUsd > 0 && <span className="num">{usd(subtask.costUsd)}</span>}
        {(subtask.consultCredits ?? 0) > 0 && (
          <span className="num" title="AI-credits konsulterna på Copilot har kostat på det här kortet (1 credit = 0,01 USD).">
            {Math.round(subtask.consultCredits! * 10) / 10} credits
          </span>
        )}
        {subtask.contextTokens > 0 && (
          <span className="num" title="Hur mycket agenten läser om vid varje steg. Över gränsen sammanfattas samtalet, och en väckning börjar i en ny session.">
            {Math.round(subtask.contextTokens / 1000)}k sammanhang
          </span>
        )}
        {subtask.status === 'pr-open' && subtask.prUrl && <MergedButton subtask={subtask} />}
      </div>
      <Log events={events} team={team} role={role} />
      <LoginPrompt subtask={subtask} owner={owner} />
      <Composer
        rows={2}
        placeholder={`Skriv till ${nameOf(role) ?? 'agenten'}…`}
        submitLabel="Skicka"
        onUpload={uploadTo(`/api/subtasks/${subtask.id}/upload`)}
        onSubmit={(text, files) => post(`/api/subtasks/${subtask.id}/messages`, { text, images: files.flatMap((f) => (f.url && f.preview ? [f.url] : [])) })}
      >
        <button type="button" className="btn btn-quiet" onClick={act('stop')} disabled={subtask.status !== 'running'}>
          Stoppa
        </button>
        <button type="button" className="btn btn-quiet" onClick={act('terminal')} disabled={!subtask.sessionId}>
          Terminal
        </button>
        <button type="button" className="btn btn-quiet" onClick={act('done')} disabled={subtask.status === 'done'}>
          Klar
        </button>
      </Composer>
    </section>
  );
}
