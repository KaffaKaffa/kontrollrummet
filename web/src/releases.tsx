import { useCallback, useEffect, useRef, useState } from 'react';
import { post, type Job } from './api.ts';
import { Modal } from './settings.tsx';

interface Channel {
  label: string;
  version: string | null;
  build: string | null;
  state: string | null;
  stateText: string | null;
  at: string | null;
}

interface AppReleases {
  id: string;
  name: string;
  store: 'appstore' | 'play' | 'msstore' | 'manual';
  test: Channel | null;
  prod: Channel | null;
  pending: Channel | null;
  url: string | null;
  storeUrl: string | null;
  error: string | null;
  canTest: boolean;
  canProd: boolean;
}

interface ProdPreview {
  app: string;
  store: AppReleases['store'];
  version: string | null;
  build: string | null;
  destination: string;
  blocked: string | null;
  needsNotes: boolean;
  canRelease: boolean;
}

interface TeamReleases {
  team: string;
  apps: AppReleases[];
  checkedAt: string;
}

const STORE_PUBLIC: Record<AppReleases['store'], string> = {
  appstore: 'App Store',
  play: 'Google Play',
  msstore: 'Microsoft Store',
  manual: 'butiken',
};

const STORE: Record<AppReleases['store'], string> = {
  appstore: 'App Store Connect',
  play: 'Google Play',
  msstore: 'Partner Center',
  manual: 'Partner Center',
};

function ago(iso: string | null): string {
  if (!iso) return '';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return 'nyss';
  if (min < 60) return `${min} min sedan`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} h sedan`;
  return new Date(iso).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
}

/** What makes a state good, waiting or bad, in state colours only. */
function tone(c: Channel): string {
  const s = c.state ?? '';
  if (['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION', 'VALID', 'completed'].includes(s)) return 'badge-done';
  if (['REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY', 'INVALID', 'FAILED', 'EXPIRED', 'halted'].includes(s)) return 'badge-failed';
  if (['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE', 'PROCESSING', 'inProgress'].includes(s)) return 'badge-needs-you';
  return '';
}

function ChannelBox({ c, empty, kind, link }: { c: Channel | null; empty: string; kind: string; link?: { href: string; text: string } | null }) {
  return (
    <div className={`channel channel-${kind} ${c ? '' : 'channel-empty'}`}>
      <p className="channel-label">{c?.label ?? kind}</p>
      {c ? (
        <>
          <p className="channel-version num">
            {c.version ?? '–'}
            {c.build && c.build !== c.version && <span className="channel-build"> ({c.build})</span>}
          </p>
          <p className="channel-meta">
            {c.stateText && <span className={`badge ${tone(c)}`}>{c.stateText}</span>}
            {c.at && <span className="num">{ago(c.at)}</span>}
          </p>
          {link && (
            <a className="channel-link" href={link.href} target="_blank" rel="noreferrer">
              {link.text}
            </a>
          )}
        </>
      ) : (
        <p className="channel-none">{empty}</p>
      )}
    </div>
  );
}

function JobLog({ job }: { job: Job }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [job.log.length]);
  const badge = job.status === 'running' ? 'badge-running' : job.status === 'done' ? 'badge-done' : 'badge-failed';
  return (
    <details className="job" open={job.status !== 'done'}>
      <summary>
        <span className={`badge ${badge}`}>{job.status === 'running' ? 'Pågår' : job.status === 'done' ? 'Klart' : 'Misslyckades'}</span>
        <span className="job-title">{job.title}</span>
        <span className="num job-when">{ago(job.endedAt ?? job.startedAt)}</span>
      </summary>
      <pre ref={ref} className="job-log">{job.log || 'Startar…'}</pre>
    </details>
  );
}

/** The one place a prod release starts: what goes where, said plainly, then a deliberate yes. */
function ProdDialog({ team, app, onClose }: { team: string; app: AppReleases; onClose: () => void }) {
  const [preview, setPreview] = useState<ProdPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sv, setSv] = useState('');
  const [en, setEn] = useState('');
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/teams/${team}/apps/${app.id}/prod-preview`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        setPreview(body as ProdPreview);
      })
      .catch((e: Error) => setError(e.message));
  }, [team, app.id]);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/teams/${team}/apps/${app.id}/prod`, { confirm: true, notesSv: sv, notesEn: en });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const notesMissing = Boolean(preview?.needsNotes) && !sv.trim() && !en.trim();
  return (
    <Modal label={`${app.name} till prod`} onClose={onClose}>
      <header className="modal-head">
        <div>
          <p className="eyebrow">Till prod</p>
          <h2>{app.name}</h2>
        </div>
        <button type="button" className="btn btn-quiet modal-close" onClick={onClose}>
          Stäng
        </button>
      </header>
      {!preview && !error && <p className="empty">Läser läget i butiken…</p>}
      {preview && (
        <div className="form">
          <dl className="facts">
            <dt>Version</dt>
            <dd className="num">{preview.version ?? '–'}</dd>
            <dt>Build</dt>
            <dd className="num">{preview.build ?? '–'}</dd>
            <dt>Går till</dt>
            <dd>{preview.destination}</dd>
          </dl>
          {preview.blocked ? (
            <p className="blocked">{preview.blocked}</p>
          ) : (
            <>
              {preview.needsNotes && (
                <>
                  <label className="field">
                    <span>Nyheter på svenska</span>
                    <textarea rows={3} value={sv} onChange={(e) => setSv(e.target.value)} placeholder="Vad är nytt i den här versionen?" />
                  </label>
                  <label className="field">
                    <span>Nyheter på engelska</span>
                    <textarea rows={3} value={en} onChange={(e) => setEn(e.target.value)} placeholder="What's new in this version?" />
                    <small>Står bara ett språk ifyllt används det för båda.</small>
                  </label>
                </>
              )}
              <label className="field field-check">
                <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
                <span>
                  Ja, skicka {preview.version}
                  {preview.build && preview.build !== preview.version ? ` (${preview.build})` : ''} till {preview.store === 'appstore' ? 'Apples granskning' : preview.store === 'msstore' ? 'Microsofts certifiering; godkänns den går den ut till alla direkt' : 'Play produktion, till alla användare'}.
                </span>
              </label>
            </>
          )}
        </div>
      )}
      {error && <p className="composer-error">{error}</p>}
      <footer className="modal-foot">
        <button type="button" className="btn" onClick={onClose}>
          Avbryt
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void send()}
          disabled={!preview || Boolean(preview.blocked) || !sure || notesMissing || busy}
        >
          Skicka till prod
        </button>
      </footer>
    </Modal>
  );
}

/** Store versions per app: out for testers, on its way, and out for everyone. */
export function Releases({ team, jobs }: { team: string; jobs: Job[] }) {
  const [prodFor, setProdFor] = useState<AppReleases | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const act = async (path: string) => {
    setActionError(null);
    await post(path).catch((e: Error) => setActionError(e.message));
  };
  const [data, setData] = useState<TeamReleases | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (refresh = false) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/teams/${team}/releases${refresh ? '?refresh' : ''}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setData(body as TeamReleases);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [team],
  );

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 5 * 60 * 1000);
    return () => window.clearInterval(t);
  }, [load]);

  return (
    <div className="releases">
      <header className="releases-head">
        <div>
          <h2 className="section-title">Releases</h2>
          <p className="eyebrow">{data ? `Läst från butikerna ${ago(data.checkedAt)}.` : 'Läser från butikerna…'}</p>
        </div>
        <button type="button" className="btn" onClick={() => void load(true)} disabled={busy}>
          {busy ? 'Läser…' : 'Uppdatera'}
        </button>
      </header>
      {error && <p className="composer-error">{error}</p>}
      {actionError && <p className="composer-error">{actionError}</p>}
      <div className="release-grid">
        {data?.apps.map((a) => (
          <section key={a.id} className="release" aria-label={a.name}>
            <header className="release-head">
              <h3>{a.name}</h3>
              {a.url ? (
                <a href={a.url} target="_blank" rel="noreferrer" className="release-store">
                  {STORE[a.store]}
                </a>
              ) : (
                <span className="release-store">{STORE[a.store]}</span>
              )}
            </header>
            {(() => {
              const appJobs = jobs.filter((j) => j.team === team && j.app === a.id);
              const running = appJobs.some((j) => j.status === 'running');
              const approved = a.pending?.state === 'PENDING_DEVELOPER_RELEASE';
              return (
                <>
                  {(a.canTest || a.canProd) && (
                    <div className="release-actions">
                      {a.canTest && (
                        <button type="button" className="btn" disabled={running} onClick={() => void act(`/api/teams/${team}/apps/${a.id}/test`)}>
                          Testbuild
                        </button>
                      )}
                      {a.canProd && approved && (
                        <button type="button" className="btn btn-primary" disabled={running} onClick={() => void act(`/api/teams/${team}/apps/${a.id}/release`)}>
                          Släpp {a.pending?.version}
                        </button>
                      )}
                      {a.canProd && (
                        <button type="button" className="btn" disabled={running} onClick={() => setProdFor(a)}>
                          Till prod…
                        </button>
                      )}
                    </div>
                  )}
                  {appJobs.slice(0, 2).map((j) => (
                    <JobLog key={j.id} job={j} />
                  ))}
                </>
              );
            })()}
            {a.error ? (
              <p className="composer-error">{a.error}</p>
            ) : (
              <div className="channels">
                <ChannelBox
                  kind="Test"
                  c={a.test}
                  empty={a.store === 'msstore' ? `Samma version som i butiken` : a.store === 'manual' ? 'Ingen version hittad' : 'Ingen testbuild'}
                />
                <ChannelBox kind="På väg" c={a.pending} empty="Inget på väg" />
                <ChannelBox
                  kind="Prod"
                  c={a.prod}
                  empty={a.store === 'manual' ? 'Läses inte automatiskt. Se Partner Center.' : 'Inte släppt än'}
                  link={a.storeUrl ? { href: a.storeUrl, text: `Öppna i ${STORE_PUBLIC[a.store]}` } : null}
                />
              </div>
            )}
          </section>
        ))}
      </div>
      {prodFor && <ProdDialog team={team} app={prodFor} onClose={() => setProdFor(null)} />}
    </div>
  );
}
