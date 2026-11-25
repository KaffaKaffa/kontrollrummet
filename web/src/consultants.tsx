import { useEffect, useState } from 'react';
import { Markdown } from './markdown.tsx';
import { When } from './when.tsx';
import { nameOf, post, put, type Consultant, type Consultation, type ConsultantProvider, type Role, type Team } from './api.ts';
import { Section, useAction } from './project.tsx';

/**
 * Consultants: specialists the agents ask over an API, outside the office. A
 * lawyer on a model that is good at law, an illustrator that draws. Each has a
 * face, a name, a provider and model, and its own instructions.
 */

/** Every service a consultant can be: called over its API by the control room, or through an MCP server. */
interface ServiceInfo {
  id: ConsultantProvider;
  label: string;
  via: 'api' | 'mcp';
  note: string;
  kinds: Consultant['kind'][];
}

const PROVIDER_LABEL: Record<string, string> = {
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  grok: 'xAI Grok',
  perplexity: 'Perplexity',
  copilot: 'GitHub Copilot',
  runway: 'Runway',
  elevenlabs: 'ElevenLabs',
  suno: 'Suno',
  meshy: 'Meshy',
  kling: 'Kling',
  tripo: 'Tripo',
  rodin: 'Rodin',
  flux: 'FLUX',
  deepl: 'DeepL',
  stability: 'Stability',
};

interface Catalog {
  consultants: Consultant[];
  templates: Consultant[];
  providers: Record<string, boolean>;
  keys: Record<string, { env: string; service: string }>;
  services?: ServiceInfo[];
  faces: string[];
}

export const consultantName = (c: Pick<Consultant, 'name' | 'nick'>) => c.nick || c.name;

export function ConsultantFace({ c, size = 'md' }: { c: Consultant; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={`avatar avatar-${size} consultant-face`} title={consultantName(c)}>
      {c.portrait && !broken ? <img src={c.portrait} alt="" onError={() => setBroken(true)} /> : <span aria-hidden="true">{consultantName(c).slice(0, 2)}</span>}
    </span>
  );
}

/** Services named in the tips; the first three can be chosen as the consultant's provider. */
const SERVICE: Record<string, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
  grok: 'Grok',
  flux: 'FLUX',
  elevenlabs: 'ElevenLabs',
  suno: 'Suno',
  kling: 'Kling',
  runway: 'Runway',
  meshy: 'Meshy',
  tripo: 'Tripo',
  rodin: 'Rodin',
  deepl: 'DeepL',
  perplexity: 'Perplexity',
  copilot: 'GitHub Copilot',
  stability: 'Stability',
};
const USABLE = new Set<string>(Object.keys(PROVIDER_LABEL));

/**
 * Which services and models are extra good at what the consultant does. The
 * ones the control room can ask are marked; the others are tips for doing it by
 * hand, or for a provider to connect later.
 */
export function Tips({ tips, onPick }: { tips?: Consultant['tips']; onPick?: (service: ConsultantProvider) => void }) {
  if (!tips?.length) return null;
  return (
    <span className="tips">
      {tips.map((t) => {
        const usable = USABLE.has(t.service);
        const label = `${SERVICE[t.service] ?? t.service} · ${t.model}`;
        const title = `${t.why}${usable ? '' : ' (finns inte att välja än)'}`;
        return onPick && usable ? (
          <button key={label} type="button" className="tip tip-usable" title={`${title}. Klicka för att välja ${SERVICE[t.service]}.`} onClick={() => onPick(t.service as ConsultantProvider)}>
            {label}
          </button>
        ) : (
          <span key={label} className={`tip ${usable ? 'tip-usable' : ''}`} title={title}>
            {label}
          </span>
        );
      })}
    </span>
  );
}

/** Opens the team's settings on the Konsulter tab. */
export function openConsultants(team: string) {
  try {
    localStorage.setItem('settings-tab', 'consultants');
  } catch {
    // The tab is just not remembered.
  }
  location.hash = `#/${team}/settings`;
}

const CONSENT_LABEL: Record<Consultant['consent'], string> = {
  always: 'Kräver alltid samtycke',
  session: 'Samtycke en gång per kort',
  never: 'Kräver aldrig samtycke',
};

/** A consultant at a desk like the agents', in the desk view: not in the office, but in the same grid. */
export function ConsultantDesk({ c, team, roles, consultations = [] }: { c: Consultant; team: string; roles: Role[]; consultations?: Consultation[] }) {
  const askers = c.askers === 'all' ? 'Alla får fråga' : `Frågas av ${c.askers.map((id) => roles.find((r) => r.id === id)).filter(Boolean).map((r) => r!.nick || r!.name).join(', ') || 'ingen'}`;
  const now = activeFor(c, team, consultations);
  const asker = now ? roles.find((r) => r.id === now.asker) : undefined;
  return (
    <section className={`desk ${now ? 'desk-running' : 'desk-idle'} desk-consultant`} aria-label={consultantName(c)}>
      <a className="desk-top" href={`#/${team}/office/consultant/${c.id}`} title={`Öppna ${consultantName(c)}`}>
        <ConsultantFace c={c} size="xl" />
        <div className="desk-who">
          <h2>{consultantName(c)}</h2>
          <p className="desk-title">{c.nick ? `${c.name} · ${c.title}` : c.title}</p>
          <p className="desk-model">
            {PROVIDER_LABEL[c.provider] ?? c.provider} {c.mcp ? 'via MCP' : c.model}
          </p>
        </div>
      </a>
      {now ? (
        <div className="speech">
          {c.kind === 'image' ? 'Ritar' : 'Svarar'} {nameOf(asker) ?? now.asker}
          {now.subtaskId != null && (
            <>
              {' '}
              på <a href={`#/${team}/office/card/${now.subtaskId}`}>#{now.subtaskId}</a>
            </>
          )}
          …
        </div>
      ) : (
        <div className="speech speech-idle">{c.kind === 'image' ? 'Ritar när någon beställer.' : 'Svarar när någon frågar.'}{c.web ? ' Söker på webben.' : ''}</div>
      )}
      {c.vibe && <p className="desk-vibe">{c.vibe}</p>}
      <footer className="desk-foot">
        <span className={now ? 'badge badge-running' : 'badge'}>{now ? 'Arbetar' : 'Konsult'}</span>
        <span className="desk-stat">{askers}</span>
        <span className="desk-stat">{CONSENT_LABEL[c.consent]}</span>
      </footer>
    </section>
  );
}

/** In the 3D office the consultants are only faces, on the row with the view switch. */
export function ConsultantFaces({ list, team, consultations = [] }: { list: Consultant[]; team: string; consultations?: Consultation[] }) {
  if (!list.length) return null;
  return (
    <div className="consultant-faces" aria-label="Konsulter">
      {list.map((c) => {
        const busy = Boolean(activeFor(c, team, consultations));
        return (
          <a
            key={c.id}
            className={busy ? 'consultant-face-btn is-busy' : 'consultant-face-btn'}
            href={`#/${team}/office/consultant/${c.id}`}
            title={`${consultantName(c)}${c.nick ? ` (${c.name})` : ''}: ${c.title}${busy ? ' · arbetar' : ''}`}
          >
            <ConsultantFace c={c} size="md" />
          </a>
        );
      })}
    </div>
  );
}

/** The question the consultant is working on now, if any. */
const activeFor = (c: Consultant, team: string, list: Consultation[]) =>
  list.findLast((x) => x.team === team && x.consultant === c.id && x.status === 'running');

const seconds = (from: string, to: string | null) => Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
const took = (s: number) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);

/** Ticks once a second while something runs, for "har tänkt i 42 s". */
function useTick(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

/**
 * A consultant in the side panel, like an agent's card: who it is, whether it
 * works right now, and its latest questions with how it reasoned, what it
 * searched and read, and what it answered. Live while a question runs.
 */
export function ConsultantPanel({ c, team, roles, consultations, onClose }: { c: Consultant; team: string; roles: Role[]; consultations: Consultation[]; onClose: () => void }) {
  const mine = consultations.filter((x) => x.team === team && x.consultant === c.id).reverse();
  const now = mine.find((x) => x.status === 'running');
  useTick(Boolean(now));
  return (
    <section className="detail consultant-panel" aria-label={consultantName(c)}>
      <header className="detail-head">
        <ConsultantFace c={c} size="lg" />
        <div className="detail-title">
          <p className="eyebrow">
            Konsult · {PROVIDER_LABEL[c.provider] ?? c.provider} {c.mcp ? 'via MCP' : c.model}
          </p>
          <h2>{consultantName(c)}</h2>
          <span className={now ? 'badge badge-running' : 'badge'}>{now ? 'Arbetar' : 'Ledig'}</span>
        </div>
        <button type="button" className="btn btn-quiet" onClick={() => openConsultants(team)}>
          Inställningar
        </button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Stäng" title="Stäng (Esc)">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      </header>
      <div className="log consultations">
        {mine.length === 0 && <p className="log-empty">{c.mcp ? 'Den här konsulten nås via MCP, så agenten använder dess verktyg själv och inget syns här.' : 'Ingen har frågat än.'}</p>}
        {mine.map((x) => {
          const who = roles.find((r) => r.id === x.asker);
          const running = x.status === 'running';
          return (
            <article key={x.id} className={`consultation is-${x.status}`}>
              <p className="consultation-head">
                <strong>{nameOf(who) ?? x.asker}</strong>
                {x.subtaskId != null && (
                  <>
                    {' '}
                    på <a href={`#/${team}/office/card/${x.subtaskId}`}>kort #{x.subtaskId}</a>
                  </>
                )}{' '}
                · <When at={x.startedAt} /> · {running ? `har arbetat i ${took(seconds(x.startedAt, null))}` : `tog ${took(seconds(x.startedAt, x.endedAt))}`}
              </p>
              <details className="consultation-part">
                <summary>Frågan</summary>
                <div className="consultation-text">{x.question}</div>
              </details>
              {(x.thinking || running) && (
                <details className="consultation-part" open={running}>
                  <summary>Resonemang{running && !x.answer ? ' …' : ''}</summary>
                  {x.thinking ? <Markdown source={x.thinking} /> : <p className="settings-muted">Tjänsten visar inget resonemang för den här modellen, bara svaret.</p>}
                </details>
              )}
              {x.searches.length > 0 && (
                <details className="consultation-part">
                  <summary>Sökte på webben ({x.searches.length})</summary>
                  <ul>
                    {x.searches.map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                </details>
              )}
              {x.sources.length > 0 && (
                <details className="consultation-part">
                  <summary>Källor ({x.sources.length})</summary>
                  <ul>
                    {x.sources.map((src) => (
                      <li key={src.url}>
                        <a href={src.url} target="_blank" rel="noreferrer">
                          {src.title || src.url}
                        </a>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {x.answer && (
                <div className="consultation-answer">
                  <Markdown source={x.answer} />
                </div>
              )}
              {x.error && <p className="consultation-error">{x.error}</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}

/** Image models for an image consultant; for text, none of the audio, image or embedding ones. */
const fits = (kind: Consultant['kind'], id: string) =>
  kind === 'image' ? /image/.test(id) : !/image|audio|realtime|transcribe|tts|embedding|whisper|dall-e|moderation|search|computer|codex|veo|imagen|live/.test(id);

interface CopilotModel {
  id: string;
  name: string;
  price?: { input: number; output: number };
}
interface CopilotStatus {
  hasKey: boolean;
  limits: { card: number; day: number };
  usedToday: number;
  quota?: { plan?: string; remainingPercent?: number; resetDate?: string; unlimited: boolean };
  models: CopilotModel[];
  error?: string;
}

const makerOf = (id: string) => (/^claude/.test(id) ? 'Anthropic' : /^(gpt|o\d|chatgpt)/.test(id) ? 'OpenAI' : /^gemini/.test(id) ? 'Google' : 'Andra');
const credits = (n: number) => (n >= 10 ? Math.round(n) : Math.round(n * 100) / 100);

/** Copilot's models grouped by maker, with the price in credits per million tokens. */
function CopilotModelPicker({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  const [models, setModels] = useState<CopilotModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/consultants/copilot')
      .then(async (r) => {
        const data = (await r.json()) as CopilotStatus & { error?: string };
        if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
        if (live) {
          setModels(data.models.filter((m) => fits('text', m.id)));
          if (data.error) setError(data.error);
        }
      })
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, []);
  if (!models?.length) return <ModelInput value={value} onChange={onChange} placeholder={error ? 'Skriv modellens id' : 'Hämtar modellerna …'} error={error} />;
  const groups = ['Anthropic', 'OpenAI', 'Google', 'Andra'].map((g) => [g, models.filter((m) => makerOf(m.id) === g)] as const).filter(([, l]) => l.length);
  return (
    <label className="field">
      <span>Modell</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {!models.some((m) => m.id === value) && <option value={value}>{value || 'Välj modell'}</option>}
        {groups.map(([g, list]) => (
          <optgroup key={g} label={g}>
            {list.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} {m.price ? `· ${credits(m.price.input)} / ${credits(m.price.output)} credits per miljon tokens` : '· pris okänt'}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <small className="settings-muted">Pris: credits in / ut per miljon tokens (1 credit = 0,01 USD).</small>
      {error && <small className="settings-muted">{error}</small>}
    </label>
  );
}

function ModelInput({ value, onChange, placeholder, error }: { value: string; onChange: (m: string) => void; placeholder: string; error: string | null }) {
  return (
    <label className="field">
      <span>Modell</span>
      <input className="mono" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {error && <small className="settings-muted">{error}</small>}
    </label>
  );
}

function ModelPicker({ provider, kind, value, onChange }: { provider: ConsultantProvider; kind: Consultant['kind']; value: string; onChange: (m: string) => void }) {
  if (provider === 'copilot') return <CopilotModelPicker value={value} onChange={onChange} />;
  return <PlainModelPicker provider={provider} kind={kind} value={value} onChange={onChange} />;
}

function PlainModelPicker({ provider, kind, value, onChange }: { provider: ConsultantProvider; kind: Consultant['kind']; value: string; onChange: (m: string) => void }) {
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setModels(null);
    setError(null);
    fetch(`/api/consultants/models?provider=${provider}`)
      .then(async (r) => {
        const data = (await r.json()) as { models?: string[]; error?: string };
        if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
        if (live) setModels((data.models ?? []).filter((m) => fits(kind, m)));
      })
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [provider, kind]);
  return (
    <label className="field">
      <span>Modell</span>
      {models ? (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {!models.includes(value) && <option value={value}>{value || 'Välj modell'}</option>}
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      ) : (
        <input className="mono" value={value} placeholder={error ? 'Skriv modellens id' : 'Hämtar modellerna …'} onChange={(e) => onChange(e.target.value)} />
      )}
      {error && <small className="settings-muted">{error}</small>}
    </label>
  );
}

function ConsultantForm({ team, roles, c, catalog, reload }: { team: Team; roles: Role[]; c: Consultant; catalog: Catalog; reload: () => void }) {
  const mcpServers = team.mcpServers ?? [];
  // A server older than the page may lack the newer fields.
  const [form, setForm] = useState<Consultant>({ ...c, tips: c.tips ?? [], askers: c.askers ?? 'all', consent: c.consent ?? 'session' });
  const [question, setQuestion] = useState('');
  const [reply, setReply] = useState<{ text: string; images: string[] } | null>(null);
  const [picking, setPicking] = useState(false);
  const save = useAction();
  const face = useAction();
  const tryIt = useAction();
  const set = (patch: Partial<Consultant>) => setForm((f) => ({ ...f, ...patch }));
  const service = catalog.services?.find((x) => x.id === form.provider);
  const viaMcp = service?.via === 'mcp';
  const missingKey = !viaMcp && !catalog.providers[form.provider];
  return (
    <fieldset className="devapp-form consultant-form">
      <legend>{consultantName(form)}</legend>
      <div className="consultant-head">
        <ConsultantFace c={{ ...form, portrait: c.portrait }} size="xl" />
        <div className="consultant-face-actions">
          <button
            type="button"
            className="btn"
            disabled={face.busy || !form.look.trim() || !catalog.providers.openai}
            title={catalog.providers.openai ? 'Ritas med OpenAI utifrån Utseende, i samma stil som agenterna' : 'Kräver en OpenAI-nyckel'}
            onClick={() =>
              void face.run(async () => {
                await put(`/api/teams/${team.id}/consultants/${c.id}`, form);
                await post(`/api/teams/${team.id}/consultants/${c.id}/portrait`);
                reload();
              })
            }
          >
            {face.busy ? 'Ritar …' : 'Rita porträtt'}
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => setPicking((p) => !p)}>
            Välj ett ansikte
          </button>
          {face.error && <span className="composer-error">{face.error}</span>}
        </div>
      </div>
      {picking && (
        <div className="face-picker">
          {catalog.faces.map((f) => (
            <button
              key={f}
              type="button"
              className="face-pick"
              title={f}
              onClick={() =>
                void face.run(async () => {
                  await post(`/api/teams/${team.id}/consultants/${c.id}/face`, { face: f });
                  setPicking(false);
                  reload();
                })
              }
            >
              <img src={`/api/faces/${f}`} alt={f} onError={(e) => ((e.currentTarget.parentElement as HTMLElement).style.display = 'none')} />
            </button>
          ))}
        </div>
      )}
      <div className="form-row">
        <label className="field">
          <span>Namn</span>
          <input value={form.nick} placeholder={form.name} onChange={(e) => set({ nick: e.target.value })} />
        </label>
        <label className="field">
          <span>Roll</span>
          <input value={form.name} placeholder="Jurist" onChange={(e) => set({ name: e.target.value })} />
        </label>
      </div>
      <label className="field">
        <span>Vad man frågar om</span>
        <input value={form.title} placeholder="Integritetspolicy, användarvillkor, GDPR" onChange={(e) => set({ title: e.target.value })} />
      </label>
      <div className="form-row">
        <label className="field">
          <span>Gör</span>
          <select value={form.kind} onChange={(e) => set({ kind: e.target.value as Consultant['kind'], web: e.target.value === 'image' ? false : form.web })}>
            <option value="text">Svarar i text</option>
            <option value="image">Gör bilder</option>
          </select>
        </label>
        <label className="field">
          <span>Leverantör</span>
          <select value={form.provider} onChange={(e) => set({ provider: e.target.value as ConsultantProvider, model: '' })}>
            {(['api', 'mcp'] as const).map((via) => (
              <optgroup key={via} label={via === 'api' ? 'Över API (kontrollrummet frågar)' : 'Via MCP (agenten använder serverns verktyg)'}>
                {(catalog.services ?? [])
                  .filter((x) => x.via === via)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label} · {x.note}
                      {via === 'api' && !catalog.providers[x.id] ? ' (nyckel saknas)' : ''}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        {viaMcp ? (
          <label className="field">
            <span>MCP-server</span>
            <select value={form.mcp ?? ''} onChange={(e) => set({ mcp: e.target.value })}>
              <option value="">Välj server</option>
              {mcpServers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          !missingKey && <ModelPicker provider={form.provider} kind={form.kind} value={form.model} onChange={(model) => set({ model })} />
        )}
      </div>
      {(form.tips ?? []).length > 0 && (
        <p className="tips-row">
          <span className="settings-muted">Bra på det här:</span> <Tips tips={form.tips} onPick={(provider) => set({ provider, model: '' })} />
        </p>
      )}
      {missingKey && <p className="settings-note">Ingen nyckel för {PROVIDER_LABEL[form.provider]} än. Lägg in den under API-nycklar högst upp.</p>}
      {viaMcp && (
        <p className="settings-note">
          {PROVIDER_LABEL[form.provider]} nås genom en MCP-server. Agenterna som får fråga {consultantName(form)} får servern automatiskt och använder dess verktyg med instruktionerna nedan; kontrollrummet anropar den inte själv.{' '}
          {mcpServers.length === 0 || !form.mcp ? `Finns inte servern i listan: lägg till ${PROVIDER_LABEL[form.provider]}s MCP-server i projektets MCP-inställningar (eller i Claude Code) först.` : ''}
        </p>
      )}
      {form.kind === 'text' && !viaMcp && (
        <label className="field-check">
          <input type="checkbox" checked={form.web} onChange={(e) => set({ web: e.target.checked })} />
          <span>Får söka på webben när den svarar</span>
        </label>
      )}
      <div className="form-row">
        <label className="field">
          <span>Samtycke</span>
          <select value={form.consent} onChange={(e) => set({ consent: e.target.value as Consultant['consent'] })}>
            <option value="always">Kräver alltid samtycke</option>
            <option value="session">Kräver samtycke en gång per kort</option>
            <option value="never">Kräver aldrig samtycke</option>
          </select>
        </label>
      </div>
      <div className="field">
        <span>Vem får fråga</span>
        <div className="consultant-askers">
          <label className="field-check">
            <input type="checkbox" checked={form.askers === 'all'} onChange={(e) => set({ askers: e.target.checked ? 'all' : [] })} />
            <span>Alla agenter</span>
          </label>
          {form.askers !== 'all' &&
            roles.map((r) => {
              const list = form.askers as string[];
              return (
                <label key={r.id} className="field-check">
                  <input type="checkbox" checked={list.includes(r.id)} onChange={(e) => set({ askers: e.target.checked ? [...list, r.id] : list.filter((x) => x !== r.id) })} />
                  <span>{r.nick ? `${r.nick} (${r.name})` : r.name}</span>
                </label>
              );
            })}
        </div>
      </div>
      <label className="field">
        <span>Instruktioner</span>
        <textarea rows={8} value={form.instructions} onChange={(e) => set({ instructions: e.target.value })} />
      </label>
      <label className="field">
        <span>Utseende (för porträttet)</span>
        <textarea rows={2} value={form.look} placeholder="Ålder, hår, kläder, något typiskt" onChange={(e) => set({ look: e.target.value })} />
      </label>
      <div className="settings-actions settings-actions-start">
        <button type="button" className="btn btn-primary" disabled={save.busy} onClick={() => void save.run(() => put(`/api/teams/${team.id}/consultants/${c.id}`, form).then(reload), 'Sparat.')}>
          Spara
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            if (window.confirm(`Ta bort ${consultantName(form)}?`)) void save.run(() => post(`/api/teams/${team.id}/consultants/${c.id}/remove`).then(reload));
          }}
        >
          Ta bort
        </button>
        {save.error && <span className="composer-error">{save.error}</span>}
        {save.done && <span className="saved">{save.done}</span>}
      </div>
      <div className="infra-prompt">
        <textarea rows={2} value={question} placeholder={`Prova ${consultantName(form)}: ställ en fråga (kostar ett anrop)`} onChange={(e) => setQuestion(e.target.value)} aria-label="Prova konsulten" />
        <div className="settings-actions settings-actions-start">
          <button
            type="button"
            className="btn"
            disabled={tryIt.busy || !question.trim()}
            onClick={() =>
              void tryIt.run(async () => {
                await put(`/api/teams/${team.id}/consultants/${c.id}`, form);
                setReply((await post(`/api/teams/${team.id}/consultants/${c.id}/try`, { question })) as { text: string; images: string[] });
              })
            }
          >
            {tryIt.busy ? 'Väntar på svar …' : 'Fråga'}
          </button>
          {tryIt.error && <span className="composer-error">{tryIt.error}</span>}
        </div>
        {reply && (
          <div className="consultant-reply">
            {reply.text && <p>{reply.text}</p>}
            {reply.images.map((u) => (
              <img key={u} src={u} alt="" />
            ))}
          </div>
        )}
      </div>
    </fieldset>
  );
}

/**
 * The providers' API keys. Pasted in a Terminal window (PowerShell on Windows)
 * at a hidden prompt, and kept by the operating system: the keychain on a Mac,
 * encrypted for the signed-in user on Windows. Never in a file in the repo.
 */
/** The Copilot row under API-nycklar: status, plan, what is left of the month, and the limits that can be changed. */
function CopilotRow({ reload }: { reload: () => void }) {
  const [st, setSt] = useState<CopilotStatus | null>(null);
  const [card, setCard] = useState('');
  const [day, setDay] = useState('');
  const [saved, setSaved] = useState(false);
  const save = useAction();
  const load = () =>
    fetch('/api/consultants/copilot')
      .then((r) => r.json() as Promise<CopilotStatus>)
      .then((d) => {
        setSt(d);
        setCard(String(d.limits.card));
        setDay(String(d.limits.day));
      })
      .catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);
  if (!st) return null;
  const q = st.quota;
  const left = q?.unlimited ? 'Obegränsat' : q?.remainingPercent !== undefined ? `${Math.round(q.remainingPercent)} % kvar av månaden` : 'Kvoten okänd';
  const changed = card !== String(st.limits.card) || day !== String(st.limits.day);
  return (
    <div className="copilot-row">
      <div className="copilot-head">
        <span className={`dot ${st.hasKey ? 'dot-ok' : 'dot-missing'}`} aria-hidden="true" />
        <strong>Copilot</strong>
        <span className="settings-muted">{st.hasKey ? 'Inloggad' : 'Token saknas'}</span>
        {q?.plan && <span className="settings-muted">Plan: {q.plan}</span>}
        {st.hasKey && <span className="num">{left}</span>}
        {q?.resetDate && <span className="settings-muted">Nollställs {new Date(q.resetDate).toLocaleDateString('sv-SE')}</span>}
      </div>
      {st.error && <span className="composer-error">{st.error}</span>}
      <form
        className="copilot-limits"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run(async () => {
            await put('/api/consultants/copilot', { card: Number(card), day: Number(day) });
            await load();
            setSaved(true);
            reload();
          });
        }}
      >
        <label className="field">
          <span>Gräns per kort (credits)</span>
          <input type="number" min="1" step="any" value={card} onChange={(e) => { setCard(e.target.value); setSaved(false); }} />
        </label>
        <label className="field">
          <span>Gräns per dag (credits)</span>
          <input type="number" min="1" step="any" value={day} onChange={(e) => { setDay(e.target.value); setSaved(false); }} />
        </label>
        <button type="submit" className="btn" disabled={save.busy || !changed}>
          Spara gränser
        </button>
        {saved && !changed && <span className="saved">Sparat</span>}
      </form>
      <p className="settings-muted">Använt idag: {credits(st.usedToday)} av {st.limits.day} credits. När en gräns är nådd nekas frågorna och kortet får en notis.</p>
      {save.error && <span className="composer-error">{save.error}</span>}
    </div>
  );
}

function ApiKeys({ catalog, reload }: { catalog: Catalog; reload: () => void }) {
  const open = useAction();
  const [opened, setOpened] = useState(false);
  // Only the providers a consultant here is set to: no row for a service nobody uses.
  const used = [...new Set(catalog.consultants.map((c) => c.provider))].filter((p) => p in catalog.keys);
  if (!used.length) return null;
  return (
    <div className="api-keys">
      <p className="inbox-sub">API-nycklar</p>
      <p className="settings-note">
        Konsulterna anropar leverantörerna med en API-nyckel som du skapar hos dem. Klicka på Lägg in: sidan där du skapar nyckeln öppnas, och ett terminalfönster (Terminal på Mac, PowerShell på Windows) där du klistrar in den. Den syns inte när du klistrar. Nyckeln sparas i nyckelringen på Mac och krypterat för din användare på Windows, aldrig i en fil i repot, och används direkt utan omstart.
      </p>
      <ul className="api-key-list">
        {used.map((p) => (
          <li key={p}>
            <span className={`dot ${catalog.providers[p] ? 'dot-ok' : 'dot-missing'}`} aria-hidden="true" />
            <strong>{PROVIDER_LABEL[p]}</strong>
            <span className="settings-muted">{catalog.providers[p] ? 'Nyckel finns' : 'Ingen nyckel'}</span>
            <button
              type="button"
              className="btn"
              disabled={open.busy}
              onClick={() =>
                void open.run(async () => {
                  await post('/api/consultants/key', { provider: p });
                  setOpened(true);
                })
              }
            >
              {catalog.providers[p] ? 'Byt nyckel' : 'Lägg in'}
            </button>
          </li>
        ))}
      </ul>
      {used.includes('copilot') && <CopilotRow reload={reload} />}
      {opened && (
        <p className="saved">
          Klistra in nyckeln i terminalfönstret och tryck Enter.{' '}
          <button type="button" className="btn btn-quiet" onClick={reload}>
            Kolla igen
          </button>
        </p>
      )}
      {open.error && <span className="composer-error">{open.error}</span>}
      <p className="settings-muted">
        Kör du servern med en miljövariabel ({used.map((p) => catalog.keys[p].env).join(', ')}) används den i första hand.
      </p>
    </div>
  );
}

export function ConsultantsTab({ team, roles }: { team: Team; roles: Role[] }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = useAction();
  const reload = () =>
    fetch(`/api/teams/${team.id}/consultants`)
      .then((r) => r.json())
      .then((c: Catalog) => setCatalog(c))
      .catch((err: Error) => setError(err.message));
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.id]);
  return (
    <Section
      title="Konsulter"
      note={
        <>
          Specialister utanför kontoret som agenterna frågar med <code>consult</code>: en jurist till policyer och villkor, en illustratör till bilder. Varje konsult är en modell utanför Claude, hos OpenAI eller Google, med egna instruktioner. Den svarar på en fråga i taget och ser varken repot eller kortet; agenten som frågar gör jobbet med svaret. Frågorna går till leverantören, så inga personuppgifter eller hemligheter.
        </>
      }
    >
      {error && <p className="composer-error">{error}</p>}
      {catalog && <ApiKeys catalog={catalog} reload={() => void reload()} />}
      {catalog && (
        <div className="form">
          {catalog.consultants.length === 0 && <p className="settings-muted">Inga konsulter än.</p>}
          {catalog.consultants.map((c) => (
            <ConsultantForm key={`${c.id}-${c.portrait ?? ''}`} team={team} roles={roles} c={c} catalog={catalog} reload={() => void reload()} />
          ))}
          <p className="inbox-sub">Lägg till en konsult</p>
          <div className="consultant-gallery">
            {catalog.templates.map((t) => (
              <button
                key={t.id}
                type="button"
                className="consultant-tile"
                disabled={add.busy}
                title={t.title}
                onClick={() => void add.run(() => post(`/api/teams/${team.id}/consultants`, { template: t.id }).then(reload))}
              >
                <ConsultantFace c={{ ...t, portrait: `/api/faces/consultant-${t.id}` }} size="lg" />
                <strong>{t.name}</strong>
                <span className="settings-muted">{t.title}</span>
                <Tips tips={t.tips} />
              </button>
            ))}
            <button type="button" className="consultant-tile consultant-tile-own" disabled={add.busy} onClick={() => void add.run(() => post(`/api/teams/${team.id}/consultants`, {}).then(reload))}>
              <span className="avatar avatar-lg">+</span>
              <strong>Egen konsult</strong>
              <span className="settings-muted">Från början, med egna instruktioner</span>
            </button>
          </div>
          {add.error && <span className="composer-error">{add.error}</span>}
        </div>
      )}
    </Section>
  );
}
