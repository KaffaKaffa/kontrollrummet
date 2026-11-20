import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { post, put, type Board, type DevApp, type Team } from './api.ts';
import { Section, useAction } from './project.tsx';
import { Modal } from './settings.tsx';

/**
 * The project's local apps on the board: a button per app in the top bar
 * that says whether it runs, and a window with its output, start and stop,
 * and what the agents do with it. The control room runs them (server/devapps.ts);
 * agents use the same one instead of starting their own.
 */

const STATUS: Record<DevApp['status'], string> = {
  stopped: 'Stoppad',
  starting: 'Startar …',
  running: 'Kör',
  stopping: 'Stoppar …',
  failed: 'Stannade',
};

/** Colours and cursor moves the dev servers print are not for a page. */
const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r(?!\n)/g, '\n');

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return 'localhost';
  }
};

export function DevAppButtons({ board, team, watchDevLog }: { board: Board; team: Team; watchDevLog: (key: string | null, prev?: string) => void }) {
  const apps = board.devApps[team.id] ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const shown = apps.find((a) => a.key === open);
  const show = (key: string | null) => {
    watchDevLog(key, open ?? undefined);
    setOpen(key);
  };
  if (!apps.length) return null;
  return (
    <>
      <nav aria-label="Appar lokalt" className="devapp-bar">
        {apps.map((a) => (
          <button
            key={a.key}
            type="button"
            className={`devapp-chip devapp-${a.status}${a.ask ? ' devapp-asks' : ''}`}
            title={`${a.label}: ${STATUS[a.status]}${a.source ? ` från ${a.source.label}` : ''}`}
            onClick={() => show(a.key)}
          >
            <span className="devapp-dot" aria-hidden="true" />
            {a.label} <span className="devapp-host">{host(a.url)}</span>
            {(a.ask || a.queue.length > 0) && <span className="count num">{a.ask ? '?' : a.queue.length}</span>}
          </button>
        ))}
      </nav>
      {/* Outside the top bar: its backdrop filter would hold a fixed window inside it. */}
      {shown && createPortal(<DevAppWindow app={shown} board={board} team={team} log={board.devLogs[shown.key] ?? ''} onClose={() => show(null)} />, document.body)}
    </>
  );
}

function DevAppWindow({ app, board, team, log, onClose }: { app: DevApp; board: Board; team: Team; log: string; onClose: () => void }) {
  const act = useAction();
  const [from, setFrom] = useState<number | null>(app.source?.card ?? null);
  const call = (action: string, body: unknown = {}) => void act.run(() => post(`/api/dev/${team.id}/${app.id}/${action}`, body));
  const active = app.status === 'starting' || app.status === 'running';
  // Cards with a worktree in the app's repo can be what it runs from.
  const repoPath = team.repos.find((r) => r.id === app.repo)?.path ?? team.repo;
  const cards = board.subtasks.filter((s) => s.team === team.id && s.worktree?.startsWith(`${repoPath}/`) && s.status !== 'done' && s.status !== 'failed');
  const title = (id: number) => {
    const s = board.subtasks.find((x) => x.id === id);
    return s ? `#${id} ${s.brief.split('\n')[0].slice(0, 60)}` : `#${id}`;
  };
  const portBusy = app.status === 'failed' && app.exit?.startsWith('Porten är upptagen');

  // The output follows the end, unless the owner scrolled up to read.
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    if (pre.current && stick.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [log]);
  useEffect(() => {
    stick.current = true;
  }, [app.key]);

  return (
    <Modal label={app.label} onClose={onClose} wide>
      <header className="devapp-head">
        <div>
          <p className="eyebrow">
            <span className={`devapp-dot devapp-${app.status}`} aria-hidden="true" /> {STATUS[app.status]}
            {app.source && active ? ` från ${app.source.label}` : ''}
          </p>
          <h2>{app.label}</h2>
        </div>
        {app.url && (
          <a className="btn" href={app.url} target="_blank" rel="noreferrer">
            Öppna {host(app.url)} ↗
          </a>
        )}
      </header>

      {app.ask && (
        <div className="devapp-ask" role="alert">
          <span>Kort {title(app.ask)} är klart med {app.label}. Ska den fortsätta köra?</span>
          <button type="button" className="btn" onClick={() => call('answer', { keep: false })}>
            Stäng ner
          </button>
          <button type="button" className="btn btn-primary" onClick={() => call('answer', { keep: true })}>
            Låt den vara igång
          </button>
        </div>
      )}

      <div className="devapp-controls">
        <label className="field devapp-from">
          <span>Kör från</span>
          <select value={from ?? ''} onChange={(e) => setFrom(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Din checkout ({team.repos.find((r) => r.id === app.repo)?.id ?? app.repo})</option>
            {cards.map((s) => (
              <option key={s.id} value={s.id}>
                Kort {title(s.id)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-primary" disabled={act.busy || app.status === 'stopping'} onClick={() => call('start', { from })}>
          {active ? 'Starta om' : 'Starta'}
        </button>
        {portBusy && (
          <button type="button" className="btn" disabled={act.busy} onClick={() => call('start', { from, force: true })} title="Stoppar det som lyssnar på portarna och startar">
            Ta över portarna
          </button>
        )}
        <button type="button" className="btn" disabled={act.busy || app.status === 'stopped' || app.status === 'stopping'} onClick={() => call('stop')}>
          Stoppa
        </button>
        {act.error && <span className="composer-error">{act.error}</span>}
      </div>

      <div className="devapp-who">
        {app.users.length > 0 && <p>Används av kort {app.users.map((u) => title(u.card)).join(', ')}.</p>}
        {app.queue.length > 0 && (
          <p>
            Väntar: {app.queue.map((u) => title(u.card)).join(', ')}. {app.held ? 'De får den när du släpper den.' : 'De får den när den blir ledig.'}
          </p>
        )}
        {app.exit && <p className="composer-error">{app.exit}</p>}
        <label className="field-check">
          <input type="checkbox" checked={app.held} onChange={(e) => call('hold', { held: e.target.checked })} />
          <span>Jag tittar på den: agenterna får använda den som den är, men inte stoppa den eller starta om den från en annan worktree</span>
        </label>
        <KeepRunning team={team} app={app} apps={board.devApps[team.id] ?? []} />
      </div>

      <pre
        className="devapp-log"
        ref={pre}
        tabIndex={0}
        aria-label={`Utskrift från ${app.label}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {plain(log) || (app.status === 'stopped' ? 'Inte startad än.' : '…')}
      </pre>
      <p className="settings-muted">
        <code>{app.command}</code>
        {app.dir ? ` i ${app.dir}` : ''} · loggen ligger i {app.log}
      </p>
    </Modal>
  );
}

type AppConfig = Pick<DevApp, 'id' | 'label' | 'repo' | 'dir' | 'command' | 'url' | 'ports' | 'notes' | 'keepRunning'>;

const configOf = (a: AppConfig): AppConfig => ({ id: a.id, label: a.label, repo: a.repo, dir: a.dir, command: a.command, url: a.url, ports: a.ports, notes: a.notes, keepRunning: a.keepRunning });

const saveApps = (teamId: string, list: AppConfig[]) => put(`/api/teams/${teamId}/settings`, { devApps: list.map(configOf) });

/** The owner's choice for every agent: never ask, leave it running. Saved with the apps. */
function KeepRunning({ team, app, apps }: { team: Team; app: DevApp; apps: DevApp[] }) {
  const act = useAction();
  return (
    <label className="field-check">
      <input
        type="checkbox"
        checked={app.keepRunning}
        disabled={act.busy}
        onChange={(e) => {
          const keep = e.target.checked;
          void act.run(() => saveApps(team.id, apps.map((a) => (a.id === app.id ? { ...a, keepRunning: keep } : a))));
        }}
      />
      <span>Agenterna stänger aldrig ner den när de är klara (du får ingen fråga)</span>
    </label>
  );
}

// ---------------------------------------------------------------- settings

interface Answer {
  added: string[];
  changed: string[];
  removed: string[];
  summary: string;
}

const EMPTY: AppConfig = { id: '', label: '', repo: '', dir: '', command: '', url: '', ports: [], notes: '', keepRunning: false };

/**
 * Inställningar → Appar: the apps and how they start. An agent identifies
 * them from the repos (also when the project is added); the owner corrects.
 */
export function DevAppsTab({ team, apps }: { team: Team; apps: DevApp[] }) {
  const [list, setList] = useState<AppConfig[]>(() => apps.map(configOf));
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const save = useAction();
  const ask = useAction();
  const saved = JSON.stringify(apps.map(configOf));
  // A new list from the server (identified, saved elsewhere) replaces an unchanged form.
  const [base, setBase] = useState(saved);
  if (saved !== base) {
    setBase(saved);
    setList(apps.map(configOf));
  }
  const set = (i: number, patch: Partial<AppConfig>) => setList((l) => l.map((a, k) => (k === i ? { ...a, ...patch } : a)));
  const send = () =>
    void ask.run(async () => {
      setAnswer((await post(`/api/teams/${team.id}/dev-apps/ask`, { text })) as Answer);
      setText('');
    });
  return (
    <Section
      title="Appar lokalt"
      note={
        <>
          Det du kör på datorn när du utvecklar: en webbapp, en backend, ett API. Varje app får en knapp i toppraden där du startar och stoppar den och ser vad den skriver. Agenterna använder samma app med <code>use_app</code> i stället för att starta en egen, så att två servrar aldrig krockar på samma port. Kommandot körs med zsh i mappen och får <code>$CR_ROOT</code> (checkouten), <code>$CR_CARD</code> (kortet, tomt för dig) och <code>$CR_RUN</code> (teams/{team.id}/run).
        </>
      }
    >
      <div className="infra-prompt">
        <textarea
          rows={2}
          value={text}
          placeholder="Tomt: agenten läser repona och hittar apparna själv. Eller skriv, t.ex. ”webben startas med pnpm dev i apps/web”."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
          }}
          aria-label="Beskriv vad som saknas eller ska ändras"
        />
        <div className="settings-actions settings-actions-start">
          <button type="button" className="btn btn-primary" disabled={ask.busy} onClick={send}>
            {ask.busy ? 'Läser repona …' : text.trim() ? 'Skicka' : 'Identifiera'}
          </button>
          {ask.error && <span className="composer-error">{ask.error}</span>}
        </div>
        {answer && (
          <p className="saved">
            {[answer.added.length ? `Tillagt: ${answer.added.join(', ')}.` : '', answer.changed.length ? `Ändrat: ${answer.changed.join(', ')}.` : '', answer.removed.length ? `Borttaget: ${answer.removed.join(', ')}.` : '', answer.summary]
              .filter(Boolean)
              .join(' ')}
          </p>
        )}
      </div>
      <div className="form">
        {list.length === 0 && <p className="settings-muted">Inga appar än.</p>}
        {list.map((a, i) => (
          <fieldset className="devapp-form" key={i}>
            <legend>{a.label || 'Ny app'}</legend>
            <div className="form-row">
              <label className="field">
                <span>Namn</span>
                <input value={a.label} placeholder="Portal Internal" onChange={(e) => set(i, { label: e.target.value })} />
              </label>
              {team.repos.length > 1 && (
                <label className="field">
                  <span>Repo</span>
                  <select value={a.repo} onChange={(e) => set(i, { repo: e.target.value })}>
                    {team.repos.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.id}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="field">
                <span>Mapp i repot</span>
                <input value={a.dir} placeholder="roten" onChange={(e) => set(i, { dir: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span>Kommando</span>
              <input className="mono" value={a.command} placeholder="pnpm run dev" onChange={(e) => set(i, { command: e.target.value })} />
            </label>
            <div className="form-row">
              <label className="field">
                <span>Adress</span>
                <input value={a.url} placeholder="http://localhost:5173" onChange={(e) => set(i, { url: e.target.value })} />
              </label>
              <label className="field">
                <span>Portar</span>
                <input
                  value={a.ports.join(', ')}
                  placeholder="5173"
                  onChange={(e) => set(i, { ports: e.target.value.split(/[\s,]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0) })}
                />
              </label>
            </div>
            <label className="field">
              <span>För agenterna</span>
              <textarea rows={2} value={a.notes} placeholder="Inloggning, testanvändare, vad som måste vara igång" onChange={(e) => set(i, { notes: e.target.value })} />
            </label>
            <div className="settings-actions settings-actions-start">
              <label className="field-check">
                <input type="checkbox" checked={a.keepRunning} onChange={(e) => set(i, { keepRunning: e.target.checked })} />
                <span>Agenterna stänger aldrig ner den</span>
              </label>
              <button type="button" className="btn btn-quiet" onClick={() => setList((l) => l.filter((_, k) => k !== i))}>
                Ta bort
              </button>
            </div>
          </fieldset>
        ))}
        <div className="settings-actions">
          {save.error && <span className="composer-error">{save.error}</span>}
          {save.done && <span className="saved">{save.done}</span>}
          <button type="button" className="btn" onClick={() => setList((l) => [...l, { ...EMPTY, repo: team.repos[0]?.id ?? '' }])}>
            Lägg till app
          </button>
          <button type="button" className="btn btn-primary" disabled={save.busy} onClick={() => void save.run(() => saveApps(team.id, list.filter((a) => a.label.trim() && a.command.trim())), 'Sparat.')}>
            Spara
          </button>
        </div>
      </div>
    </Section>
  );
}
