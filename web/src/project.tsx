import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ConsultantsTab } from './consultants.tsx';
import { DevAppsTab } from './devapps.tsx';
import { del, nameOf, post, put, type PermissionList, type Board, type InfraItem, type Check, type CheckFor, type Existing, type ExistingSkill, type Library, type Scan, type Suggested, type Team } from './api.ts';
import { Avatar, useDraft } from './ui.tsx';
import { TeamCap } from './limits.tsx';
import { FolderField } from './folders.tsx';

/**
 * A project's settings: its name, account and logo, its agents, its skills and
 * the MCP servers its agents can be given. Everything writes the team's files.
 */

export function useLibrary(): Library | null {
  const [library, setLibrary] = useState<Library | null>(null);
  useEffect(() => {
    void fetch('/api/library')
      .then((r) => r.json())
      .then(setLibrary);
  }, []);
  return library;
}

export const readFile = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** The project's logo, or its initials on a colour from its name. */
export function Logo({ team, size = 20 }: { team: Pick<Team, 'id' | 'name' | 'hasLogo'>; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (team.hasLogo && !broken)
    return <img className="team-logo" src={`/api/teams/${team.id}/logo`} alt="" width={size} height={size} onError={() => setBroken(true)} />;
  const hue = [...team.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
  return (
    <span className="team-logo team-logo-initials" style={{ width: size, height: size, background: `hsl(${hue} 55% 45%)` }} aria-hidden="true">
      {team.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Section({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {note && <p className="settings-note">{note}</p>}
      {children}
    </section>
  );
}

export function useAction() {
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const run = useCallback(async (fn: () => Promise<unknown>, done?: string) => {
    setState({ busy: true, error: null, done: null });
    try {
      await fn();
      setState({ busy: false, error: null, done: done ?? null });
    } catch (err) {
      setState({ busy: false, error: (err as Error).message, done: null });
    }
  }, []);
  return { ...state, run };
}

function General({ board, team }: { board: Board; team: Team }) {
  const [name, setName] = useState(team.name);
  const [baseBranch, setBaseBranch] = useState(team.baseBranch);
  const [account, setAccount] = useState(team.account);
  const [logoPrompt, setLogoPrompt] = useState('');
  const save = useAction();
  const logo = useAction();
  const info = board.accounts.find((a) => a.id === account);
  return (
    <Section title="Projektet">
      <div className="form">
        <div className="form-row">
          <label className="field">
            <span>Namn</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Basbranch</span>
            <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
          </label>
          <label className="field">
            <span>Konto</span>
            <select value={account} onChange={(e) => setAccount(e.target.value)}>
              {board.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.kind === 'foundry' ? ' (Foundry)' : ''}
                  {a.loggedIn ? '' : a.kind === 'foundry' ? ' (inte redo)' : ' (inte inloggat)'}
                </option>
              ))}
            </select>
            <small>
              {info?.loggedIn ? (
                info.kind === 'foundry' ? `Microsoft Foundry, ${info.detail}. Agenterna och gh körs som det här kontot.` : `Inloggat som ${info.email}. Agenterna och gh körs som det här kontot.`
              ) : (
                <button type="button" className="link-btn" onClick={() => void post(`/api/accounts/${account}/${info?.kind === 'foundry' && info.auth === 'key' ? 'key' : 'login'}`)}>
                  {info?.kind === 'foundry' ? (info.auth === 'key' ? 'Nyckel saknas. Ange den i Terminal' : 'Inte inloggad i Azure. Logga in i Terminal') : 'Inte inloggat. Logga in i Terminal'}
                </button>
              )}
            </small>
          </label>
        </div>
        <p className="settings-facts">
          {team.repos.length > 1 ? 'Mapp' : 'Repo'}: <code className="filename">{team.repo}</code>
        </p>
        {team.repos.length > 1 && (
          <ul className="settings-list">
            {team.repos.map((r) => (
              <li key={r.id}>
                <strong>{r.id}</strong>
                <span className="settings-muted">{team.roles.filter((x) => x.repos[0] === r.id).map((x) => x.name).join(', ') || 'Ingen agent har det som sitt eget'}</span>
                <span className="settings-muted">basbranch {r.baseBranch}</span>
                <span />
              </li>
            ))}
          </ul>
        )}
        <div className="settings-actions">
          {save.error && <span className="composer-error">{save.error}</span>}
          {save.done && <span className="saved">{save.done}</span>}
          <button
            type="button"
            className="btn btn-primary"
            disabled={save.busy}
            onClick={() => void save.run(() => put(`/api/teams/${team.id}/settings`, { name, baseBranch, account }), 'Sparat. Kör kontrollerna igen.')}
          >
            Spara
          </button>
        </div>
        <div className="logo-row">
          <Logo team={team} size={56} />
          <div className="logo-actions">
            <label className="btn">
              Ladda upp logga
              <input
                type="file"
                accept="image/png,image/svg+xml,image/jpeg,image/webp"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void logo.run(async () => post(`/api/teams/${team.id}/logo`, { name: file.name, data: await readFile(file) }));
                }}
              />
            </label>
            {board.images.available && (
              <span className="logo-generate">
                <input value={logoPrompt} onChange={(e) => setLogoPrompt(e.target.value)} placeholder="Beskriv loggan, t.ex. ett moln med en gitarrhals" aria-label="Beskrivning av loggan" />
                <button type="button" className="btn" disabled={logo.busy || !logoPrompt.trim()} onClick={() => void logo.run(() => post(`/api/teams/${team.id}/logo`, { generate: logoPrompt }))}>
                  {logo.busy ? 'Ritar…' : 'Generera'}
                </button>
              </span>
            )}
            {team.hasLogo && (
              <button type="button" className="btn btn-quiet" onClick={() => void logo.run(() => post(`/api/teams/${team.id}/logo/remove`))}>
                Ta bort
              </button>
            )}
            {logo.error && <span className="composer-error">{logo.error}</span>}
          </div>
        </div>
      </div>
    </Section>
  );
}

/**
 * az has one active login per profile. A project on a customer's Azure DevOps
 * often needs another login than the default, so it can have a profile of its own.
 */
function AzureProfile({ value, onChange, suggestion }: { value: string; onChange: (v: string) => void; suggestion: string }) {
  return (
    <div className="field">
      <span>Azure DevOps-inloggning</span>
      <label className="field-check">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked ? suggestion : '')} />
        <span>Egen az-profil för projektet (när standardinloggningen i ~/.azure är ett annat konto)</span>
      </label>
      {value && <input value={value} onChange={(e) => onChange(e.target.value)} aria-label="Sökväg till az-profilen" />}
      <small>Agenterna, PR-bevakningen och kontrollerna använder den. Logga in där från kontrollen "Skrivrätt".</small>
    </div>
  );
}

interface AzLogin {
  profile: string;
  user: string | null;
  subscription: string | null;
}
interface ItemStatus {
  ok: boolean;
  detail: string;
}
interface InfraAnswer {
  added: string[];
  changed: string[];
  removed: string[];
  summary: string;
  ok: boolean;
}

/** The project's own az profile for Azure DevOps: git, PRs and pipelines (Git tab). */
function DevOpsProfile({ team }: { team: Team }) {
  const [dir, setDir] = useState(team.azureConfigDir ?? '');
  const [who, setWho] = useState<AzLogin | null | undefined>(undefined);
  const [note, setNote] = useState<string | null>(null);
  const save = useAction();
  useEffect(() => {
    void fetch(`/api/teams/${team.id}/azure`)
      .then((r) => r.json())
      .then((s: { devops: AzLogin }) => setWho(s.devops))
      .catch(() => setWho(null));
  }, [team.id, team.azureConfigDir]);
  const dirty = dir !== (team.azureConfigDir ?? '');
  return (
    <Section title="Azure DevOps" note="Projektets egen az-profil, så att en inloggning här aldrig byter konto i ett annat projekt. Agenterna, PR-bevakningen och kontrollerna använder den.">
      <div className="form">
        {dir ? (
          <input value={dir} onChange={(e) => setDir(e.target.value)} aria-label="az-profil för DevOps" />
        ) : (
          <p className="settings-muted">
            Använder den delade ~/.azure.{' '}
            <button type="button" className="link-btn" onClick={() => setDir(`~/.azure-${team.id}`)}>
              Ge projektet en egen profil
            </button>
          </p>
        )}
        {!dirty && who !== undefined && (
          <small className={`login-line ${who?.user ? 'is-ok' : 'is-fail'}`}>
            <span>{who?.user ? `Inloggad som ${who.user}${who.subscription ? ` · ${who.subscription}` : ''}.` : 'Inte inloggad.'}</span>
            {team.azureConfigDir && (
              <button type="button" className="link-btn" onClick={() => void post(`/api/teams/${team.id}/azure/login`).then(() => setNote('Logga in i Terminal-fönstret.'))}>
                Logga in
              </button>
            )}
          </small>
        )}
        <div className="settings-actions">
          {save.error && <span className="composer-error">{save.error}</span>}
          {note && <span className="settings-muted">{note}</span>}
          <button type="button" className="btn btn-primary" disabled={!dirty || save.busy} onClick={() => void save.run(() => put(`/api/teams/${team.id}/settings`, { azureConfigDir: dir }), 'Sparat.')}>
            Spara
          </button>
        </div>
      </div>
    </Section>
  );
}

/**
 * The prompt over the list: empty identifies on its own (infrastructure as
 * code, a scan of the repo, the project's memory, the signed-in CLIs); with
 * text, it does what the owner wrote. The answer is saved, and shown.
 */
function InfraPrompt({ team, placeholder }: { team: Team; placeholder: string }) {
  const [text, setText] = useDraft(`infra:${team.id}`);
  const [answer, setAnswer] = useState<InfraAnswer | null>(null);
  const act = useAction();
  const send = () =>
    void act.run(async () => {
      setAnswer((await post(`/api/teams/${team.id}/infra/ask`, { text })) as InfraAnswer);
      setText('');
    });
  return (
    <div className="infra-prompt">
      <textarea
        rows={2}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
        }}
        aria-label="Beskriv vad som saknas eller ska ändras"
      />
      <div className="settings-actions settings-actions-start">
        <button type="button" className="btn btn-primary" disabled={act.busy} onClick={send}>
          {act.busy ? 'Läser repot, minnet och CLI:erna…' : text.trim() ? 'Skicka' : 'Identifiera'}
        </button>
        <span className="settings-muted">{text.trim() ? 'Agenten gör det du skrev och sparar.' : 'Tomt: agenten letar själv och lägger till det som saknas.'}</span>
        {act.error && <span className="composer-error">{act.error}</span>}
      </div>
      {answer && (
        <div className="found-list">
          {(answer.added.length > 0 || answer.changed.length > 0 || answer.removed.length > 0) && (
            <p className="saved">
              {[
                answer.added.length ? `Tillagt: ${answer.added.join(', ')}` : '',
                answer.changed.length ? `Ändrat: ${answer.changed.join(', ')}` : '',
                answer.removed.length ? `Borttaget: ${answer.removed.join(', ')}` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          <p>{answer.summary}</p>
        </div>
      )}
    </div>
  );
}

const lines = (o: Record<string, string> | undefined, sep: string) =>
  Object.entries(o ?? {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n');
const parseLines = (text: string, sep: string) =>
  Object.fromEntries(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const at = l.indexOf(sep);
        return at < 0 ? [l, ''] : [l.slice(0, at).trim(), l.slice(at + sep.length).trim()];
      })
      .filter(([k]) => k),
  ) as Record<string, string>;
/** A command line as arguments: spaces split, "quotes" keep together. */
const words = (line: string) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
const commandLine = (c: string[]) => c.map((w) => (/\s/.test(w) ? `"${w}"` : w)).join(' ');
const monitorLines = (m: InfraItem['monitor']) => (m ? lines(m as unknown as Record<string, string>, ': ') : '');

/** One item: what it is at a glance, and every part of it editable in place. */
function ItemCard({
  item,
  status,
  editing,
  onEdit,
  onSave,
  onRemove,
  onLogin,
  onApprove,
}: {
  item: InfraItem;
  status?: ItemStatus;
  editing: boolean;
  onEdit: (on: boolean) => void;
  onSave: (item: InfraItem) => void;
  onRemove: () => void;
  onLogin: () => void;
  onApprove?: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [facts, setFacts] = useState(lines(item.facts, ': '));
  const [notes, setNotes] = useState(item.notes ?? '');
  const [env, setEnv] = useState(lines(item.env, '='));
  const [login, setLogin] = useState((item.login?.steps ?? []).map(commandLine).join('\n'));
  const [loginEnv, setLoginEnv] = useState(lines(item.login?.env, '='));
  const [url, setUrl] = useState(item.login?.url ?? '');
  const [secret, setSecret] = useState(item.login?.secret ?? '');
  const [check, setCheck] = useState(item.check ? commandLine(item.check.command) : '');
  const [monitor, setMonitor] = useState(monitorLines(item.monitor));
  if (!editing) {
    const fs = Object.entries(item.facts);
    return (
      <article className={`infra-item ${item.suggested ? 'is-suggested' : ''}`}>
        <header className="infra-item-head">
          <strong>{item.title}</strong>
          <span className="chip">{item.kind}</span>
          {item.monitor && <span className="chip">felbevakning</span>}
        </header>
        {fs.length > 0 && (
          <dl className="infra-facts">
            {fs.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {item.notes && <p className="settings-muted infra-notes">{item.notes}</p>}
        {item.env && <p className="settings-muted">Agenterna får {Object.keys(item.env).join(', ')}.</p>}
        {item.source && <p className="settings-muted infra-source">{item.source}</p>}
        <div className="infra-item-foot">
          {status && <small className={`login-line ${status.ok ? 'is-ok' : 'is-fail'}`}><span>{status.detail}</span></small>}
          <span className="infra-item-actions">
            {onApprove && (
              <button type="button" className="btn btn-primary" onClick={onApprove}>
                Godkänn
              </button>
            )}
            {item.login && !item.suggested && (
              <button type="button" className="btn btn-quiet" onClick={onLogin}>
                Logga in
              </button>
            )}
            <button type="button" className="btn btn-quiet" onClick={() => onEdit(true)}>
              Redigera
            </button>
            <button type="button" className="btn btn-quiet" onClick={onRemove}>
              {item.suggested ? 'Avvisa' : 'Ta bort'}
            </button>
          </span>
        </div>
      </article>
    );
  }
  const save = () => {
    const steps = login.split('\n').map((l) => l.trim()).filter(Boolean).map(words);
    const m = parseLines(monitor, ':');
    const le = parseLines(loginEnv, '=');
    onSave({
      ...item,
      title,
      facts: parseLines(facts, ':'),
      notes: notes.trim() || undefined,
      env: Object.keys(parseLines(env, '=')).length ? parseLines(env, '=') : undefined,
      login:
        steps.length || url || secret
          ? { ...(Object.keys(le).length ? { env: le } : {}), ...(steps.length ? { steps } : {}), ...(url ? { url } : {}), ...(secret ? { secret } : {}) }
          : undefined,
      check: check.trim() ? { ...(item.check?.env ? { env: item.check.env } : {}), command: words(check) } : undefined,
      monitor: m.type ? (m as unknown as InfraItem['monitor']) : undefined,
    });
  };
  return (
    <article className="infra-item is-editing">
      <div className="form">
        <label className="field">
          <span>Titel</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span>Uppgifter (nyckel: värde, en per rad)</span>
          <textarea rows={Math.max(3, facts.split('\n').length + 1)} value={facts} onChange={(e) => setFacts(e.target.value)} placeholder={'projekt: mitt-projekt\nkonto: namn@exempel.se'} />
        </label>
        <label className="field">
          <span>Till agenterna</span>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Hur det används rätt, t.ex. flaggor som aldrig får utelämnas." />
        </label>
        <details className="infra-advanced">
          <summary>Variabler, inloggning, kontroll och felbevakning</summary>
          <label className="field">
            <span>Variabler agenterna får (NAMN=värde; secret:&lt;namn&gt; läses ur nyckelringen)</span>
            <textarea rows={2} value={env} onChange={(e) => setEnv(e.target.value)} placeholder="CLOUDSDK_CORE_PROJECT=mitt-projekt" />
          </label>
          <label className="field">
            <span>Inloggning (ett kommando per rad, körs i Terminal)</span>
            <textarea rows={2} value={login} onChange={(e) => setLogin(e.target.value)} placeholder="firebase login:add namn@exempel.se" />
          </label>
          <div className="form-row">
            <label className="field">
              <span>Variabler vid inloggning</span>
              <input value={loginEnv} onChange={(e) => setLoginEnv(e.target.value)} placeholder="AZURE_CONFIG_DIR=~/.azure-projekt" />
            </label>
            <label className="field">
              <span>Sida för token</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
            </label>
            <label className="field">
              <span>Token sparas som</span>
              <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="control-room-projekt-tjänst" />
            </label>
          </div>
          <label className="field">
            <span>Kontroll (ett kommando som bara läser)</span>
            <input value={check} onChange={(e) => setCheck(e.target.value)} placeholder="az account show" />
          </label>
          <label className="field">
            <span>Felbevakning (type: sentry | appInsights | googleLogging, och dess fält)</span>
            <textarea rows={3} value={monitor} onChange={(e) => setMonitor(e.target.value)} placeholder={'type: sentry\norg: min-org\nproject: mitt-projekt'} />
          </label>
        </details>
        <div className="settings-actions">
          <button type="button" className="btn btn-quiet" onClick={() => onEdit(false)}>
            Avbryt
          </button>
          <button type="button" className="btn btn-primary" disabled={!title.trim()} onClick={save}>
            Spara
          </button>
        </div>
      </div>
    </article>
  );
}

/** The list, saved whole: the server checks every item as it would an agent's. */
function useItems(team: Team) {
  const [status, setStatus] = useState<Record<string, ItemStatus> | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const act = useAction();
  const load = useCallback(() => {
    setStatus(null);
    void fetch(`/api/teams/${team.id}/infra`)
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({}));
  }, [team.id]);
  useEffect(load, [load, team.infraItems.length]);
  const saveAll = (items: InfraItem[]) => act.run(() => put(`/api/teams/${team.id}/settings`, { infraItems: items }));
  const replace = (id: string, next: InfraItem | null) =>
    void saveAll(team.infraItems.flatMap((i) => (i.id === id ? (next ? [next] : []) : [i]))).then(() => setEditing(null));
  const login = (id: string) =>
    void act.run(async () => setMessage(((await post(`/api/teams/${team.id}/infra/login`, { item: id })) as { message: string }).message));
  return { status, load, editing, setEditing, replace, saveAll, login, message, act };
}

function InfraTab({ team }: { team: Team }) {
  const it = useItems(team);
  const suggested = team.infraItems.filter((i) => i.suggested);
  const items = team.infraItems.filter((i) => !i.suggested);
  const add = () => {
    const id = `ny-${Date.now().toString(36)}`;
    void it.saveAll([...team.infraItems, { id, title: 'Ny post', kind: 'annat', facts: {} }]).then(() => it.setEditing(id));
  };
  const card = (i: InfraItem) => (
    <ItemCard
      key={`${i.id}-${JSON.stringify(i)}`}
      item={i}
      status={it.status?.[i.id]}
      editing={it.editing === i.id}
      onEdit={(on) => it.setEditing(on ? i.id : null)}
      onSave={(next) => it.replace(i.id, next)}
      onRemove={() => {
        if (i.suggested || window.confirm(`Ta bort ${i.title}? Agenterna får den inte längre.`)) it.replace(i.id, null);
      }}
      onLogin={() => it.login(i.id)}
      onApprove={i.suggested ? () => it.replace(i.id, { ...i, suggested: undefined }) : undefined}
    />
  );
  return (
    <Section title="Infrastruktur" note="Var projektet körs: molnprojekt, konton, resurser. Varje agent får listan i sin prompt, med variablerna satta, och föreslår det som saknas.">
      <InfraPrompt
        team={team}
        placeholder="Tomt: identifiera själv. Eller skriv, t.ex. ”Portalens resurser når vi med adm-kontot i ~/.azure-kund-adm” eller ”Ta bort Expo, appen är nedlagd”."
      />
      {suggested.length > 0 && (
        <div className="infra-suggested">
          <h4>Förslag från agenterna</h4>
          {suggested.map(card)}
        </div>
      )}
      <div className="infra-list">{items.length ? items.map(card) : <p className="settings-muted">Inget än. Tryck Identifiera, eller beskriv i rutan ovan.</p>}</div>
      <div className="settings-actions">
        {(it.act.error) && <span className="composer-error">{it.act.error}</span>}
        {it.message && <span className="settings-muted">{it.message}</span>}
        <button type="button" className="btn btn-quiet" onClick={it.load}>
          Kolla inloggningar
        </button>
        <button type="button" className="btn btn-quiet" onClick={add}>
          Lägg till
        </button>
      </div>
    </Section>
  );
}

/** The items that are error sources, how often they are read, and a test of each. */
function LoggingTab({ team }: { team: Team }) {
  const it = useItems(team);
  const [every, setEvery] = useState(String(team.monitorEveryMinutes));
  const [tested, setTested] = useState<{ source: string; ok: boolean; detail: string }[] | null>(null);
  const test = useAction();
  const save = useAction();
  const sources = team.infraItems.filter((i) => i.monitor && !i.suggested);
  return (
    <Section title="Loggning" note="Var felen i produktion läses. Nya fel blir ett kort till buggagenten, högst ett per runda.">
      <InfraPrompt team={team} placeholder="Tomt: hitta felkällorna själv. Eller skriv, t.ex. ”Sentry-projektet för webben heter min-app-web”." />
      <div className="infra-list">
        {sources.length ? (
          sources.map((i) => (
            <ItemCard
              key={`${i.id}-${JSON.stringify(i)}`}
              item={i}
              status={it.status?.[i.id]}
              editing={it.editing === i.id}
              onEdit={(on) => it.setEditing(on ? i.id : null)}
              onSave={(next) => it.replace(i.id, next)}
              onRemove={() => {
                if (window.confirm(`Sluta läsa fel från ${i.title}? Posten finns kvar under Infrastruktur.`)) it.replace(i.id, { ...i, monitor: undefined });
              }}
              onLogin={() => it.login(i.id)}
            />
          ))
        ) : (
          <p className="settings-muted">Ingen felkälla än. Tryck Identifiera, eller beskriv i rutan ovan.</p>
        )}
      </div>
      {tested && (
        <ul className="found-list">
          {tested.length ? tested.map((t) => <li key={t.source} className={t.ok ? 'is-ok' : 'is-fail'}>{t.source}: {t.detail}</li>) : <li>Ingen källa.</li>}
        </ul>
      )}
      <div className="settings-actions">
        {(test.error || save.error) && <span className="composer-error">{test.error ?? save.error}</span>}
        <label className="field-inline">
          <span>Kolla var</span>
          <select
            value={every}
            onChange={(e) => {
              setEvery(e.target.value);
              void save.run(() => put(`/api/teams/${team.id}/settings`, { monitorEveryMinutes: Number(e.target.value) }));
            }}
          >
            {['10', '15', '30', '60', '120'].map((v) => (
              <option key={v} value={v}>
                {v} minut
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-quiet" disabled={test.busy || !sources.length} onClick={() => void test.run(async () => setTested((await post(`/api/teams/${team.id}/monitors/test`)) as typeof tested))}>
          {test.busy ? 'Testar…' : 'Testa'}
        </button>
      </div>
    </Section>
  );
}

function Agents({ team, library }: { team: Team; library: Library | null }) {
  const [template, setTemplate] = useState('');
  const [name, setName] = useState('');
  const act = useAction();
  const kinds = new Set(team.roles.map((r) => r.kind));
  return (
    <Section title="Agenter" note="Klicka på en agent i Kontoret för modell, instruktioner och MCP-servrar.">
      <ul className="settings-list with-avatar">
        {team.roles.map((r) => (
          <li key={r.id}>
            <Avatar team={team.id} role={r} size="sm" />
            <a href={`#/${team.id}/office/agent/${r.id}`}>
              <strong>{r.nick ? `${r.nick} (${r.name})` : r.name}</strong>
            </a>
            <span className="settings-muted">{r.title}</span>
            <span className="settings-muted num">{r.model}</span>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={act.busy}
              onClick={() => {
                if (window.confirm(`Ta bort ${nameOf(r)} ur teamet? Filen flyttas till roles/.removed/ och anteckningarna finns kvar.`))
                  void act.run(() => post(`/api/teams/${team.id}/roles/${r.id}/remove`));
              }}
            >
              Ta bort
            </button>
          </li>
        ))}
      </ul>
      <div className="settings-add">
        <select value={template} onChange={(e) => setTemplate(e.target.value)} aria-label="Mall">
          <option value="">Lägg till agent…</option>
          {library?.templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}: {t.title}
              {kinds.has(t.kind) && t.kind !== 'app' ? ' (finns redan en)' : ''}
            </option>
          ))}
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Namn (valfritt)" aria-label="Namn" />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!template || act.busy}
          onClick={() =>
            void act.run(async () => {
              await post(`/api/teams/${team.id}/roles`, { template, name: name.trim() || undefined });
              setTemplate('');
              setName('');
            }, 'Tillagd. Justera den i Kontoret.')
          }
        >
          Lägg till
        </button>
        {act.error && <span className="composer-error">{act.error}</span>}
        {act.done && <span className="saved">{act.done}</span>}
      </div>
    </Section>
  );
}

/**
 * What the project already has, ticked: skills and commands (which can be
 * turned off for its agents) and instruction files (which Claude Code always
 * reads in the repo). Marked "Finns", so it is never mistaken for something new.
 */
function ExistingList({
  existing,
  enabled,
  onToggle,
  onRemove,
}: {
  existing: Existing;
  enabled: (id: string) => boolean;
  onToggle: (id: string, on: boolean) => void;
  onRemove?: (s: ExistingSkill) => void;
}) {
  const place = (where: string) => (where ? <code>{where}</code> : <span className="settings-muted">projektet</span>);
  if (!existing.skills.length && !existing.instructions.length) return <p className="settings-muted">Projektet har inga skills, kommandon eller instruktionsfiler än.</p>;
  return (
    <ul className="settings-list existing-list">
      {existing.instructions.map((i) => (
        <li key={`i:${i.where}:${i.file}`}>
          <input type="checkbox" checked disabled aria-label={`${i.file} följer med`} title="Läses av Claude Code i repot; kan inte stängas av härifrån" />
          <span>
            <span className="badge badge-done">Finns</span> <strong>{i.file}</strong>
          </span>
          <span className="settings-muted">{i.note}</span>
          <span className="settings-muted">
            {place(i.where)} · {i.tracked ? 'incheckad' : 'bara här'}
          </span>
          <span />
        </li>
      ))}
      {existing.skills.map((sk) => (
        <li key={`s:${sk.where}:${sk.kind}:${sk.id}`}>
          <input type="checkbox" checked={enabled(sk.id)} onChange={(e) => onToggle(sk.id, e.target.checked)} aria-label={`Agenterna använder ${sk.id}`} />
          <span>
            <span className="badge badge-done">Finns</span> <strong>{sk.kind === 'command' ? `/${sk.id}` : sk.id}</strong>
          </span>
          <span className="settings-muted">{sk.description || (sk.kind === 'command' ? 'Kommando' : 'Skill')}</span>
          <span className="settings-muted">
            {sk.kind === 'command' ? 'kommando' : 'skill'} · {place(sk.where)} · {sk.tracked ? 'incheckad' : 'bara här'}
          </span>
          {onRemove && sk.kind === 'skill' && !sk.tracked ? (
            <button type="button" className="btn btn-quiet" onClick={() => onRemove(sk)}>
              Ta bort
            </button>
          ) : (
            <span />
          )}
        </li>
      ))}
    </ul>
  );
}

function Skills({ team, library }: { team: Team; library: Library | null }) {
  const [existing, setExisting] = useState<Existing | null>(null);
  const act = useAction();
  const load = useCallback(() => {
    void fetch(`/api/teams/${team.id}/skills`)
      .then((r) => r.json())
      .then(setExisting);
  }, [team.id]);
  useEffect(load, [load]);
  const have = new Set(existing?.skills.map((s) => s.id));
  const disabled = new Set(team.disabledSkills);
  const add = (id: string, mode: 'local' | 'commit') =>
    void act.run(async () => {
      const r = (await post(`/api/teams/${team.id}/skills`, { id, mode })) as { card?: number };
      load();
      if (r.card) location.hash = `#/${team.id}/office/card/${r.card}`;
    });
  const toggle = (id: string, on: boolean) =>
    void act.run(() =>
      put(`/api/teams/${team.id}/settings`, { disabledSkills: on ? team.disabledSkills.filter((x) => x !== id) : [...team.disabledSkills, id] }),
    );
  const fresh = library?.skills.filter((s) => !have.has(s.id)) ?? [];
  return (
    <Section
      title="Skills och instruktioner"
      note="Bara en skills beskrivning läses vid varje steg; resten först när den används. Kryssa ur det agenterna inte ska använda."
    >
      <h4>Finns redan i projektet</h4>
      {existing && (
        <ExistingList
          existing={existing}
          enabled={(id) => !disabled.has(id)}
          onToggle={toggle}
          onRemove={(sk) => void act.run(async () => (await post(`/api/teams/${team.id}/skills/${sk.id}/remove`, { where: sk.where }), load()))}
        />
      )}
      <h4>Nya från biblioteket</h4>
      <ul className="settings-list">
        {fresh.length === 0 && <li className="settings-muted">Projektet har redan alla.</li>}
        {fresh.map((s) => (
          <li key={s.id}>
            <span>
              <span className="badge badge-running">Ny</span> <strong>{s.label}</strong>
            </span>
            <span className="settings-muted">{s.description}</span>
            <button type="button" className="btn btn-quiet" disabled={act.busy} onClick={() => add(s.id, 'local')} title="Kopieras till projektet men checkas inte in. Bara agenterna på den här Macen har den.">
              Lägg till lokalt
            </button>
            <button type="button" className="btn btn-quiet" disabled={act.busy} onClick={() => add(s.id, 'commit')} title="Ett kort till teamet lägger in den i en PR, så att alla som arbetar i repot får den.">
              Checka in
            </button>
          </li>
        ))}
      </ul>
      {act.error && <span className="composer-error">{act.error}</span>}
    </Section>
  );
}

function McpOverview({ team }: { team: Team }) {
  return (
    <Section title="MCP-servrar" note="Det agenterna kan få. Varje agent får bara de servrar som är valda i dess inställningar, och läser bara deras instruktioner.">
      <ul className="settings-list">
        {team.mcpServers.map((s) => {
          const users = team.roles.filter((r) => r.mcp !== 'all' && r.mcp.includes(s.id));
          return (
            <li key={s.id}>
              <strong>{s.label}</strong>
              <span className="settings-muted">{s.note || s.source}</span>
              <span className="settings-muted">{users.length ? users.map((r) => nameOf(r)).join(', ') : 'Ingen'}</span>
            </li>
          );
        })}
        {team.roles.some((r) => r.mcp === 'all') && (
          <li>
            <strong>Kontots alla</strong>
            <span className="settings-muted">Alla kontots servrar och claude.ai-connectors</span>
            <span className="settings-muted">
              {team.roles
                .filter((r) => r.mcp === 'all')
                .map((r) => nameOf(r))
                .join(', ')}
            </span>
          </li>
        )}
      </ul>
    </Section>
  );
}

const TAB_LABEL = { project: 'Projektet', git: 'Git', apps: 'Appar', consultants: 'Konsulter', infra: 'Infrastruktur', logging: 'Loggning', permissions: 'Behörigheter' } as const;
type SettingsTab = keyof typeof TAB_LABEL;

export function ProjectSettings({ board, team, extra }: { board: Board; team: Team; extra?: ReactNode }) {
  const library = useLibrary();
  // The tab survives a reload: a per-viewer convenience.
  const [tab, setTab] = useState<SettingsTab>(() => {
    try {
      const t = localStorage.getItem('settings-tab');
      return t && t in TAB_LABEL ? (t as SettingsTab) : 'project';
    } catch {
      return 'project';
    }
  });
  const pick = (t: SettingsTab) => {
    setTab(t);
    try {
      localStorage.setItem('settings-tab', t);
    } catch {
      // Private window: the tab is just not remembered.
    }
  };
  return (
    <div className="project-settings">
      <header className="settings-head">
        <Logo team={team} size={40} />
        <div>
          <p className="eyebrow">teams/{team.id}</p>
          <h2>{team.name}</h2>
        </div>
      </header>
      <div className="segmented settings-tabs" role="tablist" aria-label="Inställningar">
        {(Object.keys(TAB_LABEL) as SettingsTab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => pick(t)}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      {tab === 'project' && (
        <>
          <General key={`${team.id}-${team.account}-${team.name}`} board={board} team={team} />
          <TeamCap board={board} team={team} />
          <People key={`${team.id}-people`} team={team} />
          {extra}
          <Agents team={team} library={library} />
          <Skills team={team} library={library} />
          <McpOverview team={team} />
        </>
      )}
      {tab === 'git' && (
        <>
          <Section title="Inloggningar" note="Claude-kontot, git-värden och agenternas MCP-servrar, för projektets konto. Varje inloggning öppnar Terminal och skriver först ut vilket konto den gäller.">
            <Checks only="auth" target={{ team: team.id }} />
          </Section>
          <Section title="Repo och verktyg">
            <Checks only="repo" target={{ team: team.id }} />
          </Section>
          {(team.azure || team.azureConfigDir) && <DevOpsProfile key={`${team.id}-${team.azureConfigDir}`} team={team} />}
        </>
      )}
      {tab === 'apps' && <DevAppsTab key={team.id} team={team} apps={board.devApps[team.id] ?? []} />}
      {tab === 'consultants' && <ConsultantsTab key={team.id} team={team} roles={team.roles} />}
      {tab === 'infra' && <InfraTab team={team} />}
      {tab === 'logging' && <LoggingTab team={team} />}
      {tab === 'permissions' && <PermissionsTab key={team.id} team={team} />}
    </div>
  );
}

// ---------------------------------------------------------------- permissions

/** What agents may run without asking: defaults, and what the owner saved with "Tillåt alltid". */
function PermissionsTab({ team }: { team: Team }) {
  const [list, setList] = useState<PermissionList | null>(null);
  const [rule, setRule] = useState('');
  const [scope, setScope] = useState<'team' | 'global'>('team');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void fetch(`/api/permissions?team=${encodeURIComponent(team.id)}`)
      .then((r) => r.json())
      .then((l: PermissionList) => setList(l));
  }, [team.id]);
  useEffect(load, [load]);
  const add = async () => {
    setError(null);
    try {
      setList((await post('/api/permissions', { scope, team: team.id, rule })) as PermissionList);
      setRule('');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (s: 'team' | 'global', r: string) => setList((await del('/api/permissions', { scope: s, team: team.id, rule: r })) as PermissionList);
  const rows = (s: 'team' | 'global', items: PermissionList['team']) =>
    items.length === 0 ? (
      <p className="settings-note">Inga än.</p>
    ) : (
      <ul className="permission-list">
        {items.map((p) => (
          <li key={p.rule}>
            <code>{p.rule}</code>{' '}
            <span className="settings-note">
              {new Date(p.at).toLocaleDateString('sv-SE')}
              {p.from?.card != null && <> · kort #{p.from.card}</>}
            </span>{' '}
            <button type="button" className="btn" onClick={() => void remove(s, p.rule)}>
              Ta bort
            </button>
          </li>
        ))}
      </ul>
    );
  if (!list) return <p className="settings-note">Läser…</p>;
  return (
    <>
      <Section title="Alltid tillåtet i projektet" note="Sparas på den här datorn, inte i git. Gäller alla agenter i projektet som ändrar kod.">
        {rows('team', list.team)}
      </Section>
      <Section title="Alltid tillåtet i alla projekt">{rows('global', list.global)}</Section>
      <Section title="Lägg till regel" note="Samma form som i Claude Code, till exempel Bash(npx playwright test:*). Regler som tillåter vad som helst, eller något som aldrig får tillåtas (release, deploy, merge), sparas inte.">
        <div className="approval-actions">
          <input value={rule} onChange={(e) => setRule(e.target.value)} placeholder="Bash(kommando:*)" spellCheck={false} />
          <select value={scope} onChange={(e) => setScope(e.target.value as 'team' | 'global')}>
            <option value="team">det här projektet</option>
            <option value="global">alla projekt</option>
          </select>
          <button type="button" className="btn btn-primary" onClick={() => void add()} disabled={!rule.trim()}>
            Lägg till
          </button>
        </div>
        {error && <p className="settings-note">{error}</p>}
      </Section>
      <Section title="Standard för roller som ändrar kod" note="Rutin i agentens egen worktree: tillåtet utan att fråga. Release, deploy och merge är fortfarande spärrade.">
        {list.defaults.map((g) => (
          <p key={g.group}>
            <strong>{g.group}</strong>: {g.rules.map((r) => <code key={r}>{r} </code>)}
          </p>
        ))}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- people

type Person = Team['people'][number] & { /** A suggestion's grounds, not saved. */ evidence?: string };

/**
 * The people in the project: who merges, decides and reviews. Kept in
 * team.json (everyone who runs the project shares it); every agent is told,
 * and roles can write {{people}} for their names.
 */
function People({ team }: { team: Team }) {
  const [people, setPeople] = useState<Person[]>(team.people ?? []);
  const save = useAction();
  const find = useAction();
  // Suggestions from GitHub or Azure DevOps, added below those already there (not twice).
  const identify = () =>
    void find.run(async () => {
      const found = (await post(`/api/teams/${team.id}/people/suggest`)) as Person[];
      const same = (a: Person, b: Person) =>
        (a.account && b.account && a.account.toLowerCase() === b.account.toLowerCase()) || a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
      let added = 0;
      setPeople((list) => {
        const fresh = found.filter((f) => !list.some((p) => same(p, f)));
        added = fresh.length;
        return [...list, ...fresh];
      });
      return added;
    }, 'Förslagen står sist. Ändra, ta bort det som inte stämmer och spara.');
  const set = (i: number, patch: Partial<Person>) => setPeople((list) => list.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  return (
    <Section
      title="Människorna i projektet"
      note={
        <>
          Vilka som jobbar i projektet och vad de gör, till exempel vem som mergar eller tar designbeslut. Agenterna får listan, så att frågor och beslut går till rätt person. Står i teams/{team.id}/team.json och delas med alla som kör projektet. I rollernas text blir <code>{'{{people}}'}</code> deras namn.
        </>
      }
    >
      <div className="form">
        {people.length === 0 && <p className="settings-muted">Ingen ännu: agenterna vänder sig då till dig.</p>}
        {people.map((p, i) => (
          <div className="form-row people-row" key={i}>
            <label className="field">
              <span>Namn</span>
              <input value={p.name} onChange={(e) => set(i, { name: e.target.value })} />
            </label>
            <label className="field">
              <span>GitHub eller e-post i Azure DevOps</span>
              <input value={p.account ?? ''} placeholder="valfritt" onChange={(e) => set(i, { account: e.target.value })} />
            </label>
            <label className="field">
              <span>Gör i projektet</span>
              <input value={p.does ?? ''} placeholder="mergar PR:er, tar designbeslut …" onChange={(e) => set(i, { does: e.target.value })} />
            </label>
            <button type="button" className="btn btn-quiet" aria-label={`Ta bort ${p.name || 'personen'}`} onClick={() => setPeople((list) => list.filter((_, k) => k !== i))}>
              Ta bort
            </button>
            {p.evidence && <small className="people-evidence">Förslag: {p.evidence}</small>}
          </div>
        ))}
        <div className="settings-actions">
          {(save.error ?? find.error) && <span className="composer-error">{save.error ?? find.error}</span>}
          {(save.done ?? find.done) && <span className="saved">{save.done ?? find.done}</span>}
          <button type="button" className="btn" disabled={find.busy} onClick={identify}>
            {find.busy ? 'Letar …' : 'Identifiera människorna i projektet'}
          </button>
          <button type="button" className="btn" onClick={() => setPeople((list) => [...list, { name: '' }])}>
            Lägg till person
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={save.busy}
            onClick={() => void save.run(() => put(`/api/teams/${team.id}/settings`, { people: people.filter((p) => p.name.trim()).map(({ name, account, does }) => ({ name, account, does })) }), 'Sparat. Gäller från agenternas nästa tur.')}
          >
            Spara
          </button>
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- checks

const CHECK_ICON: Record<Check['status'], string> = { ok: '✓', warn: '!', fail: '✕' };

/** The project's checks, with a fix button on each that can be fixed from here. */
export function Checks({
  target,
  onResult,
  auto = true,
  hide = [],
  only,
  withMcp = false,
}: {
  target: CheckFor;
  onResult?: (checks: Check[]) => void;
  auto?: boolean;
  /** Checks that cannot apply yet, such as the repo before it is cloned. */
  hide?: string[];
  /** auth: logins and access (account, git host, MCP servers). repo: the rest. */
  only?: 'auth' | 'repo';
  /** Start the MCP servers on every run (logins step), not only on request. */
  withMcp?: boolean;
}) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const act = useAction();
  const key = JSON.stringify(target);
  const runChecks = useCallback(
    (mcp = false) =>
      void act.run(async () => {
        const auth = (c: Check) => c.id === 'account' || c.id.startsWith('host') || c.id.startsWith('push') || c.id.startsWith('mcp');
        const result = ((await post('/api/checks', { ...target, mcp: mcp || withMcp })) as Check[])
          .filter((c) => !hide.includes(c.id))
          .filter((c) => !only || (only === 'auth') === auth(c));
        setChecks(result);
        onResult?.(result);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  useEffect(() => {
    if (auto) runChecks();
  }, [auto, runChecks]);
  const fix = (id: string) =>
    void act.run(async () => {
      const { message: m } = (await post('/api/checks/fix', { ...target, fix: id })) as { message: string };
      setMessage(m);
    });

  /** An MCP server's OAuth, from a button: the browser opens, the page waits, then checks again. */
  const [auth, setAuth] = useState<{ server: string; session: string; url: string; message: string; failed?: boolean } | null>(null);
  const [pasted, setPasted] = useState('');
  const authenticate = (server: string) =>
    void act.run(async () => {
      const { session, url } = (await post('/api/mcp-login', { ...target, server })) as { session: string; url: string };
      setAuth({ server, session, url, message: 'Logga in i webbläsaren. Sidan märker själv när det är klart.' });
      setPasted('');
      window.open(url, '_blank', 'noopener');
    });
  useEffect(() => {
    if (!auth || auth.failed) return;
    const timer = window.setInterval(() => {
      void fetch(`/api/mcp-login/${auth.session}`)
        .then((r) => r.json())
        .then((st: { status: string; message: string }) => {
          if (st.status === 'done') {
            setAuth(null);
            setMessage(st.message);
            runChecks(true);
          } else if (st.status === 'failed') {
            setAuth((a) => (a ? { ...a, message: st.message, failed: true } : a));
          }
        })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.session, auth?.failed]);
  return (
    <div className="checks">
      <ul className="checks-list">
        {checks?.map((c) => (
          <li key={c.id} className={`check check-${c.status}`}>
            <span className="check-icon" aria-label={c.status === 'ok' ? 'Klart' : c.status === 'fail' ? 'Fel' : 'Varning'}>
              {CHECK_ICON[c.status]}
            </span>
            <strong>{c.label}</strong>
            <span className="settings-muted">
              {c.detail}
              {c.required && c.status === 'fail' ? ' (krävs)' : ''}
            </span>
            {c.fix ? (
              <button
                type="button"
                className={`btn ${c.fix.kind === 'auth' ? 'btn-primary' : 'btn-quiet'}`}
                disabled={act.busy || Boolean(auth && !auth.failed)}
                onClick={() => (c.fix!.kind === 'auth' ? authenticate(c.fix!.id) : fix(c.fix!.id))}
              >
                {c.fix.label}
              </button>
            ) : (
              <span />
            )}
            {auth && c.fix?.kind === 'auth' && c.fix.id === auth.server && (
              <div className="auth-wait">
                <p className={auth.failed ? 'composer-error' : 'settings-muted'}>
                  {!auth.failed && <span className="pulse" aria-hidden="true" />} {auth.message}{' '}
                  <a href={auth.url} target="_blank" rel="noreferrer">
                    Öppna inloggningen igen
                  </a>
                </p>
                {!auth.failed && (
                  <div className="settings-add">
                    <input
                      className="grow"
                      value={pasted}
                      onChange={(e) => setPasted(e.target.value)}
                      placeholder="Fastnade webbläsaren på en sida som inte laddar? Klistra in adressen här."
                      aria-label="Adressen webbläsaren hamnade på"
                    />
                    <button
                      type="button"
                      className="btn"
                      disabled={!pasted.trim()}
                      onClick={() => void post(`/api/mcp-login/${auth.session}/paste`, { url: pasted }).catch((err: Error) => setAuth((a) => (a ? { ...a, message: err.message } : a)))}
                    >
                      Skicka
                    </button>
                    <button type="button" className="btn btn-quiet" onClick={() => void post(`/api/mcp-login/${auth.session}/cancel`).then(() => setAuth(null))}>
                      Avbryt
                    </button>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
        {!checks && act.busy && <li className="settings-muted">Kontrollerar…</li>}
      </ul>
      <div className="settings-actions">
        {message && <span className="saved">{message}</span>}
        {act.error && <span className="composer-error">{act.error}</span>}
        <button type="button" className="btn" disabled={act.busy} onClick={() => runChecks(false)}>
          Kör igen
        </button>
        {only !== 'repo' && !withMcp && (
          <button type="button" className="btn" disabled={act.busy} onClick={() => runChecks(true)} title="Startar agenternas MCP-servrar en gång och ser vilka som ansluter. Kostar ett kort Haiku-svar.">
            Kontrollera MCP
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- new project

type SourceKind = 'existing' | 'clone' | 'new';

const SIGNALS: { id: string; label: string }[] = [
  { id: 'web', label: 'Webbapp' },
  { id: 'backend', label: 'Backend/API' },
  { id: 'ios', label: 'iOS' },
  { id: 'android', label: 'Android' },
  { id: 'mac', label: 'Mac' },
  { id: 'windows', label: 'Windows' },
  { id: 'infra', label: 'Infra/CI' },
];

interface RoleChoice {
  on: boolean;
  owns: string;
  mcp: 'all' | string[];
  /** Several repos: the ones it works in, comma separated, its own first. */
  repos: string;
}

/**
 * The guide for a new project: where the repo is (here, to clone, or new on
 * GitHub or Azure DevOps), which account, which agents, skills and MCP
 * servers, a logo, and checks that it all works. Suggestions are filled in
 * from what the repo holds, so the defaults are usually right.
 */
export function NewProjectGuide({ board }: { board: Board }) {
  const library = useLibrary();
  const [kind, setKind] = useState<SourceKind>('existing');
  const [path, setPath] = useState('');
  const [cloneUrl, setCloneUrl] = useState('');
  const [into, setInto] = useState('~/Dev');
  const [host, setHost] = useState<'github' | 'azure'>('github');
  const [owner, setOwner] = useState('');
  const [azureProject, setAzureProject] = useState('');
  const [repoName, setRepoName] = useState('');
  const [priv, setPriv] = useState(true);
  const [signals, setSignals] = useState<string[]>([]);
  const [scan, setScan] = useState<Scan | null>(null);
  const [name, setName] = useState('');
  const [account, setAccount] = useState(board.accounts.find((a) => a.isDefault)?.id ?? board.accounts[0]?.id ?? '');
  const [roles, setRoles] = useState<Record<string, RoleChoice>>({});
  const [skills, setSkills] = useState<Record<string, 'off' | 'local' | 'commit'>>({});
  const [teamPrompt, setTeamPrompt] = useState('');
  const [logo, setLogo] = useState<{ name: string; data: string } | { generate: string } | null>(null);
  const [onboarding, setOnboarding] = useState(true);
  /** A folder of several repos: which belong to the project. */
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [azureDir, setAzureDir] = useState('');
  /** Several repos: base branch per repo where it was changed. */
  const [bases, setBases] = useState<Record<string, string>>({});
  /** Existing skills and commands the agents should not use. */
  const [offSkills, setOffSkills] = useState<string[]>([]);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [authChecks, setAuthChecks] = useState<Check[] | null>(null);
  const reading = useAction();
  const creating = useAction();
  // The accounts arrive with the board, maybe after the first render.
  useEffect(() => {
    if (!account && board.accounts.length) setAccount(board.accounts.find((a) => a.isDefault)?.id ?? board.accounts[0].id);
  }, [account, board.accounts]);

  /** Fills in the suggestions: every template, the suggested ones on. */
  const apply = (suggested: Suggested) => {
    if (!library) return;
    const next: Record<string, RoleChoice> = {};
    for (const t of library.templates) {
      const s = suggested.roles.find((r) => r.template === t.id);
      next[t.id] = { on: Boolean(s), owns: (s?.owns ?? t.owns).join(', '), mcp: t.mcp, repos: (s?.repos ?? []).join(', ') };
    }
    setRoles(next);
    setSkills(Object.fromEntries(library.skills.map((s) => [s.id, suggested.skills.includes(s.id) ? 'local' : 'off'])));
  };

  const readRepo = (at = path) =>
    void reading.run(async () => {
      const result = (await post('/api/projects/scan', { path: at })) as Scan;
      if (!result.exists) throw new Error('mappen finns inte');
      if (!result.isGit && !result.repos.length) throw new Error('mappen är inget git-repo och har inga repon under sig. Kör git init, eller välj Skapa nytt.');
      setScan(result);
      setPicked(Object.fromEntries(result.repos.map((r) => [r.id, !r.duplicateOf])));
      setOffSkills([]);
      // The project's own Claude settings may already name its az profile.
      // Every Azure project gets its own az profile, never the shared ~/.azure.
      setAzureDir(result.azureConfigDir ?? (result.host === 'azure' ? `~/.azure-${result.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : ''));
      setName((n) => n || result.name.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()));
      setTeamPrompt(`## ${result.name}\n\n- Läs \`CLAUDE.md\` innan du ändrar något.\n`);
      apply(result.suggested);
    });

  // A repo still to clone or create: suggestions from what it will hold.
  useEffect(() => {
    if (kind === 'existing' || !library) return;
    void post('/api/projects/suggest', { signals }).then((s) => apply(s as Suggested));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, signals.join(','), library]);
  useEffect(() => {
    if (kind === 'clone' && !name) {
      const n = /([^/:]+?)(?:\.git)?\/?$/.exec(cloneUrl)?.[1];
      if (n) setName(n);
    }
    if (kind === 'new' && repoName && !name) setName(repoName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, cloneUrl, repoName]);

  const ready = kind === 'existing' ? Boolean(scan) : kind === 'clone' ? Boolean(cloneUrl.trim()) : Boolean(repoName.trim() && owner.trim() && (host === 'github' || azureProject.trim()));
  const chosen = library?.templates.filter((t) => roles[t.id]?.on) ?? [];
  const servers = [...new Set(chosen.flatMap((t) => (roles[t.id].mcp === 'all' ? [] : (roles[t.id].mcp as string[]))))];
  const many = Boolean(scan && scan.repos.length);
  const chosenRepos = scan?.repos.filter((r) => picked[r.id]) ?? [];
  const onAzure =
    kind === 'existing'
      ? Boolean(scan && (scan.host === 'azure' || chosenRepos.some((r) => r.host === 'azure')))
      : kind === 'new'
        ? host === 'azure'
        : /azure\.com|visualstudio\.com/.test(cloneUrl);
  const slugName = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'projekt';
  // What the checks look at: the folder and its repos, or (before cloning or creating) only the account and host.
  const draft: CheckFor | null =
    kind === 'existing'
      ? scan
        ? {
            draft: {
              repo: scan.path,
              repos: many ? chosenRepos.map((r) => ({ id: r.id, path: r.path, baseBranch: bases[r.id] || r.baseBranch, host: r.host })) : undefined,
              account,
              azureConfigDir: azureDir || null,
              host: scan.host,
              baseBranch: scan.baseBranch,
              servers,
              tools: scan.tools,
            },
          }
        : null
      : {
          draft: {
            repo: into,
            account,
            azureConfigDir: azureDir || null,
            host: kind === 'new' ? host : /github\.com/.test(cloneUrl) ? 'github' : /azure\.com|visualstudio\.com/.test(cloneUrl) ? 'azure' : 'none',
            baseBranch: 'main',
            servers,
            tools: [],
          },
        };
  const failing = (list: Check[] | null) => !list || list.some((c) => c.required && c.status === 'fail');
  const blocked = kind === 'existing' && (failing(checks) || failing(authChecks));
  const splitList = (v: string) =>
    v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  const accountInfo = board.accounts.find((a) => a.id === account);

  const create = () =>
    void creating.run(async () => {
      const source =
        kind === 'existing'
          ? { kind, path: scan!.path }
          : kind === 'clone'
            ? { kind, url: cloneUrl, into }
            : { kind, host, owner, project: azureProject || undefined, name: repoName, private: priv, into };
      const result = (await post('/api/projects', {
        name,
        source,
        account,
        baseBranch: scan?.baseBranch,
        roles: chosen.map((t) => ({
          template: t.id,
          owns: many ? [] : splitList(roles[t.id].owns),
          mcp: roles[t.id].mcp,
          repos: many ? splitList(roles[t.id].repos).filter((x) => picked[x]) : undefined,
        })),
        repos: many ? chosenRepos.map((r) => r.id) : undefined,
        baseBranches: many ? bases : undefined,
        skills: Object.entries(skills)
          .filter(([, mode]) => mode !== 'off')
          .map(([id, mode]) => ({ id, mode })),
        teamPrompt,
        logo,
        onboarding,
        azureConfigDir: azureDir || null,
        disabledSkills: offSkills,
      })) as { teamId: string; card: number | null };
      location.hash = `#/${result.teamId}/settings`;
    });

  return (
    <div className="project-settings">
      <header className="settings-head">
        <div>
          <p className="eyebrow">Nytt projekt</p>
          <h2>Lägg till ett repo</h2>
        </div>
      </header>

      <Section title="1. Repot">
        <div className="segmented" role="tablist" aria-label="Var repot finns">
          {(
            [
              ['existing', 'Finns på Macen'],
              ['clone', 'Klona'],
              ['new', 'Skapa nytt'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>
              {label}
            </button>
          ))}
        </div>
        {kind === 'existing' && (
          <div className="settings-add">
            <FolderField value={path} onChange={setPath} placeholder="~/Dev/mitt-repo" label="Sökväg till repot" onPicked={(p) => readRepo(p)} onEnter={() => readRepo()} />
            <button type="button" className="btn btn-primary" disabled={!path.trim() || reading.busy} onClick={() => readRepo()}>
              {reading.busy ? 'Läser…' : 'Läs in'}
            </button>
            {reading.error && <span className="composer-error">{reading.error}</span>}
          </div>
        )}
        {kind === 'clone' && (
          <div className="form-row">
            <label className="field">
              <span>URL</span>
              <input value={cloneUrl} onChange={(e) => setCloneUrl(e.target.value)} placeholder="git@github.com:org/repo.git" />
            </label>
            <label className="field">
              <span>Klona till</span>
              <FolderField value={into} onChange={setInto} label="Klona till" />
            </label>
          </div>
        )}
        {kind === 'new' && (
          <div className="form">
            <div className="form-row">
              <label className="field">
                <span>Var</span>
                <select value={host} onChange={(e) => setHost(e.target.value as 'github' | 'azure')}>
                  <option value="github">GitHub</option>
                  <option value="azure">Azure DevOps</option>
                </select>
              </label>
              <label className="field">
                <span>{host === 'github' ? 'Ägare (användare eller organisation)' : 'Organisation'}</span>
                <input value={owner} onChange={(e) => setOwner(e.target.value)} />
              </label>
              {host === 'azure' && (
                <label className="field">
                  <span>Projekt</span>
                  <input value={azureProject} onChange={(e) => setAzureProject(e.target.value)} />
                </label>
              )}
            </div>
            <div className="form-row">
              <label className="field">
                <span>Repots namn</span>
                <input value={repoName} onChange={(e) => setRepoName(e.target.value.replace(/[^\w.-]+/g, '-'))} />
              </label>
              <label className="field">
                <span>Klona till</span>
                <FolderField value={into} onChange={setInto} label="Klona till" />
              </label>
              {host === 'github' && (
                <label className="field field-check">
                  <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
                  <span>Privat</span>
                </label>
              )}
            </div>
          </div>
        )}
        {kind !== 'existing' && (
          <fieldset className="field mcp-picker">
            <span>Vad ska byggas? (för förslagen nedan)</span>
            <div className="mcp-list">
              {SIGNALS.map((s) => (
                <label key={s.id} className="field-check">
                  <input type="checkbox" checked={signals.includes(s.id)} onChange={(e) => setSignals((v) => (e.target.checked ? [...v, s.id] : v.filter((x) => x !== s.id)))} />
                  <span>{s.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {scan && (
          <div className="scan">
            <p>
              <strong>{scan.host === 'github' ? 'GitHub' : scan.host === 'azure' ? 'Azure DevOps' : 'Ingen känd git-värd'}</strong>
              {scan.remote && <span className="settings-muted"> · {scan.remote}</span>} · basbranch <code>{scan.baseBranch}</code>
            </p>
            {many ? (
              <>
                <p className="settings-muted">Mappen är inget repo i sig, men har {scan.repos.length} under sig. Kryssa i de som hör till projektet:</p>
                <ul className="settings-list">
                  {scan.repos.map((r) => (
                    <li key={r.id}>
                      <label className="field-check">
                        <input type="checkbox" checked={Boolean(picked[r.id])} onChange={(e) => setPicked((v) => ({ ...v, [r.id]: e.target.checked }))} />
                        <strong>{r.id}</strong>
                      </label>
                      <span className="settings-muted">{r.duplicateOf ? `Ännu en klon av ${r.duplicateOf}` : r.found.join(' · ') || 'inget särskilt'}</span>
                      <span className="settings-muted">{r.host === 'none' ? 'ingen värd' : r.host === 'github' ? 'GitHub' : 'Azure DevOps'}</span>
                      <input
                        className="base-input"
                        value={bases[r.id] ?? r.baseBranch}
                        onChange={(e) => setBases((v) => ({ ...v, [r.id]: e.target.value }))}
                        aria-label={`Basbranch för ${r.id}`}
                        title="Branchen kort utgår från och PR:er går till"
                        disabled={!picked[r.id]}
                      />
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              scan.found.length > 0 && <p className="settings-muted">Hittade: {scan.found.join(' · ')}</p>
            )}
            <p className="settings-muted">
              {scan.claudeMd ? 'CLAUDE.md finns och följer med.' : 'Ingen CLAUDE.md: onboarding-kortet skriver en.'}
              {scan.mcpJson.length > 0 && ` .mcp.json har ${scan.mcpJson.join(', ')}; de kan väljas per agent.`}
            </p>
          </div>
        )}
      </Section>

      {ready && library && (
        <>
          <Section title="2. Namn och konto">
            <div className="form-row">
              <label className="field">
                <span>Projektets namn</span>
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field">
                <span>Claude-konto</span>
                <select value={account} onChange={(e) => setAccount(e.target.value)}>
                  {board.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.loggedIn ? '' : ' (inte inloggat)'}
                    </option>
                  ))}
                </select>
                <small>
                  {accountInfo?.loggedIn ? (
                    `${accountInfo.email}. Agenterna, gh och az körs som det här kontot.`
                  ) : (
                    <button type="button" className="link-btn" onClick={() => void post(`/api/accounts/${account}/login`)}>
                      Inte inloggat. Logga in i Terminal
                    </button>
                  )}
                </small>
              </label>
            </div>
            {onAzure && <AzureProfile value={azureDir} onChange={setAzureDir} suggestion={`~/.azure-${slugName}`} />}
          </Section>

          <Section
            title="3. Inloggningar"
            note="Det som måste vara inloggat för att agenterna ska komma igång, för kontot ovan. Varje inloggning öppnar Terminal och skriver först ut vilket konto den gäller. MCP-servrarna kommer från agenterna i nästa steg."
          >
            {draft && <Checks only="auth" withMcp={servers.length > 0} hide={kind === 'existing' ? [] : ['push']} target={draft} onResult={setAuthChecks} />}
          </Section>

          <Section title="4. Agenter" note="Förslagen kommer från vad repot innehåller. Fler går att lägga till senare under Inställningar.">
            <ul className="settings-list guide-roles">
              {library.templates.map((t) => {
                const r = roles[t.id];
                if (!r) return null;
                return (
                  <li key={t.id}>
                    <input type="checkbox" checked={r.on} aria-label={t.name} onChange={(e) => setRoles((v) => ({ ...v, [t.id]: { ...r, on: e.target.checked } }))} disabled={t.id === 'teamleader'} />
                    <strong>{t.name}</strong>
                    <span className="settings-muted">{t.title}</span>
                    {many && t.kind !== 'lead' && t.kind !== 'architect' && t.kind !== 'bug' ? (
                      <input
                        value={r.repos}
                        placeholder={`Repon, t.ex. ${chosenRepos[0]?.id ?? 'Web'}`}
                        aria-label={`${t.name} arbetar i`}
                        title="Repona agenten arbetar i, kommaseparerade. Det första är dess eget; korten får worktree där."
                        onChange={(e) => setRoles((v) => ({ ...v, [t.id]: { ...r, repos: e.target.value } }))}
                      />
                    ) : t.kind === 'app' && !many ? (
                      <input value={r.owns} placeholder="Äger (tomt = hela repot)" aria-label={`${t.name} äger`} onChange={(e) => setRoles((v) => ({ ...v, [t.id]: { ...r, owns: e.target.value } }))} />
                    ) : (
                      <span className="settings-muted">{many ? 'Hela projektet' : ''}</span>
                    )}
                    <span className="settings-muted">{r.mcp === 'all' ? 'MCP: kontots alla' : r.mcp.length ? `MCP: ${r.mcp.join(', ')}` : ''}</span>
                  </li>
                );
              })}
            </ul>
          </Section>

          <Section title="5. Skills och instruktioner" note="Det som redan finns följer med och är ikryssat. Det nya kommer från kontrollrummets bibliotek.">
            <h4>Finns redan i projektet</h4>
            {scan ? (
              <ExistingList
                existing={scan.existing}
                enabled={(id) => !offSkills.includes(id)}
                onToggle={(id, on) => setOffSkills((v) => (on ? v.filter((x) => x !== id) : [...v, id]))}
              />
            ) : (
              <p className="settings-muted">Repot klonas eller skapas först; det som finns i det följer med.</p>
            )}
            <h4>Nya från biblioteket</h4>
            <ul className="settings-list">
              {library.skills
                .filter((sk) => !scan?.existing.skills.some((e) => e.id === sk.id))
                .map((sk) => (
                  <li key={sk.id}>
                    <span>
                      <span className="badge badge-running">Ny</span> <strong>{sk.label}</strong>
                    </span>
                    <span className="settings-muted">{sk.description}</span>
                    <select value={skills[sk.id] ?? 'off'} onChange={(e) => setSkills((v) => ({ ...v, [sk.id]: e.target.value as 'off' | 'local' | 'commit' }))} aria-label={sk.label}>
                      <option value="off">Inte</option>
                      <option value="local">Lägg till lokalt</option>
                      <option value="commit">Checka in (PR)</option>
                    </select>
                    <span />
                  </li>
                ))}
            </ul>
            <label className="field">
              <span>Regler för hela teamet (shared.md)</span>
              <textarea className="prompt" rows={5} value={teamPrompt} onChange={(e) => setTeamPrompt(e.target.value)} placeholder={'## Projektet\n\n- Vem som mergar, vad som aldrig får göras …'} />
            </label>
            <label className="field field-check">
              <input type="checkbox" checked={onboarding} onChange={(e) => setOnboarding(e.target.checked)} />
              <span>Första kortet: teamet läser in sig, skriver CLAUDE.md om den saknas och checkar in valda skills i en PR</span>
            </label>
          </Section>

          <Section title="6. MCP-servrar" note="Det agenterna får från start, enligt mallarna. Ändras per agent i Kontoret.">
            <p className="settings-muted">{servers.length ? servers.join(', ') : 'Inga utöver kontrollrummets.'}</p>
          </Section>

          <Section title="7. Logga">
            <div className="logo-actions">
              <label className="btn">
                {logo && 'name' in logo ? logo.name : 'Ladda upp'}
                <input type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" hidden onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) setLogo({ name: file.name, data: await readFile(file) });
                }} />
              </label>
              {board.images.available && (
                <span className="logo-generate">
                  <input placeholder="…eller beskriv den så ritas den" aria-label="Beskrivning av loggan" onChange={(e) => setLogo(e.target.value.trim() ? { generate: e.target.value } : null)} />
                </span>
              )}
              <span className="settings-muted">Valfri. Utan logga visas initialen.</span>
            </div>
          </Section>

          <Section title="8. Repo och verktyg" note={kind === 'existing' ? 'Det som krävs måste vara grönt innan projektet skapas.' : 'Körs under Inställningar när repot har klonats eller skapats.'}>
            {kind === 'existing' && draft ? <Checks only="repo" target={draft} onResult={setChecks} /> : <p className="settings-muted">Repot finns inte här än.</p>}
          </Section>

          <div className="settings-actions">
            {creating.error && <span className="composer-error">{creating.error}</span>}
            <button type="button" className="btn btn-primary" disabled={creating.busy || blocked || !name.trim()} onClick={create}>
              {creating.busy ? 'Skapar…' : 'Skapa projekt'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
