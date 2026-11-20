import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { avatarUrl, nameOf, type Role, type RoleKind, type Team } from './api.ts';
import { defaultCharacter, portraitUrl, useWardrobe } from './office3d/characters.ts';
import { Avatar } from './ui.tsx';

/** The 3D character up close: three.js only loads when the appearance tab is open. */
const Preview = lazy(() => import('./office3d/Preview.tsx'));

/** A dialog that closes on Escape and on the backdrop, and keeps focus inside while open. */
export function Modal({
  label,
  onClose,
  children,
  wide,
  drawer,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Slides in from the right edge instead of sitting in the middle. */
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Callers pass a new onClose every render (a card drawer re-renders on each line an agent writes);
  // focus must move only when the dialog opens, not on every render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key !== 'Tab' || !ref.current) return;
      const focusable = [...ref.current.querySelectorAll<HTMLElement>('a, button, input, textarea, select')].filter((el) => !el.hasAttribute('disabled'));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);
  return (
    <div className={`scrim ${drawer ? 'scrim-drawer' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && closeRef.current()}>
      <div className={drawer ? 'drawer' : `modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={label} ref={ref}>
        {children}
      </div>
    </div>
  );
}

const MODELS = [
  { id: 'opus', label: 'Opus 5.5', note: 'Bäst omdöme. Dyrast.' },
  { id: 'sonnet', label: 'Sonnet 5.5', note: 'Snabb och kunnig. Billigare än Opus.' },
  { id: 'haiku', label: 'Haiku 5.5', note: 'Billigast. För enkla, väldefinierade steg.' },
  { id: 'fable', label: 'Fable 5.2', note: '' },
];

const KINDS: { id: RoleKind; label: string }[] = [
  { id: 'lead', label: 'Teamleader: delar ut och följer upp' },
  { id: 'architect', label: 'Arkitekt: planerar' },
  { id: 'bug', label: 'Bug: triagerar fynd' },
  { id: 'designer', label: 'Designer' },
  { id: 'app', label: 'Utvecklare' },
  { id: 'tester', label: 'Testare' },
];

const PERMISSIONS = [
  { id: 'auto', label: 'Auto: bedömer själv, frågar dig vid tveksamhet' },
  { id: 'manual', label: 'Manuell: allt som kräver lov går till Inkorgen' },
  { id: 'acceptEdits', label: 'Godkänn redigeringar, fråga om resten' },
];

function ModelSelect({ value, onChange, allowSame }: { value: string; onChange: (v: string) => void; allowSame?: boolean }) {
  const known = MODELS.some((m) => m.id === value) || (allowSame && value === '');
  return (
    <select value={known ? value : '__custom'} onChange={(e) => onChange(e.target.value === '__custom' ? value : e.target.value)}>
      {allowSame && <option value="">Samma som ovan</option>}
      {MODELS.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
      {!known && <option value="__custom">{value}</option>}
    </select>
  );
}

/**
 * Which MCP servers the agent gets. Each one's instructions are read on every
 * step, so the default is none, and "all" (the account's whole set, claude.ai
 * connectors included) is the expensive exception.
 */
function McpPicker({ team, value, onChange }: { team: Team; value: 'all' | string[]; onChange: (v: 'all' | string[]) => void }) {
  const picked = value === 'all' ? [] : value;
  const toggle = (id: string) => onChange(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  return (
    <fieldset className="field mcp-picker">
      <span>MCP-servrar</span>
      <label className="field-check">
        <input type="checkbox" checked={value === 'all'} onChange={(e) => onChange(e.target.checked ? 'all' : [])} />
        <span>Kontots alla, även claude.ai-connectors (dyrast: alla läses vid varje steg)</span>
      </label>
      {value !== 'all' && (
        <div className="mcp-list">
          {team.mcpServers.map((s) => (
            <label key={s.id} className="field-check" title={s.note}>
              <input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} />
              <span>
                {s.label} <small>· {s.source}{s.auth === 'oauth' ? ' · loggas in med OAuth' : ''}</small>
              </span>
            </label>
          ))}
          {picked
            .filter((id) => !team.mcpServers.some((s) => s.id === id))
            .map((id) => (
              <label key={id} className="field-check">
                <input type="checkbox" checked onChange={() => toggle(id)} />
                <span>
                  {id} <small>· finns inte längre</small>
                </span>
              </label>
            ))}
        </div>
      )}
      <small>Utan val får agenten bara kontrollrummets verktyg.</small>
    </fieldset>
  );
}

async function put(path: string, body: unknown) {
  const res = await fetch(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
}

/** Everything about one agent, editable. Saved straight to its file in teams/<team>/roles/. */
export function AgentSettings({ team, role, onClose }: { team: Team; role: Role; onClose: () => void }) {
  const [tab, setTab] = useState<'agent' | 'looks' | 'notes' | 'team'>('agent');
  // What the role has learned: loaded when the tab opens.
  const [notes, setNotes] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== 'notes' || notes !== null) return;
    fetch(`/api/teams/${team.id}/notes/${role.id}`)
      .then((r) => r.json())
      .then((d: { text: string }) => setNotes(d.text))
      .catch(() => setNotes(''));
  }, [tab, notes, team.id, role.id]);
  const [draft, setDraft] = useState({ ...role, owns: role.owns.join(', '), repos: role.repos.join(', ') });
  const [teamPrompt, setTeamPrompt] = useState(team.teamPrompt);
  const [state, setState] = useState<{ busy: boolean; error: string | null; saved: boolean }>({ busy: false, error: null, saved: false });
  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setState((s) => ({ ...s, saved: false }));
  };
  const model = MODELS.find((m) => m.id === draft.model);

  const save = async () => {
    setState({ busy: true, error: null, saved: false });
    try {
      if (tab === 'agent' || tab === 'looks') {
        await put(`/api/teams/${team.id}/roles/${role.id}`, {
          ...draft,
          owns: draft.owns
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          repos: draft.repos
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        });
      } else if (tab === 'notes') {
        await put(`/api/teams/${team.id}/notes/${role.id}`, { text: notes ?? '' });
      } else {
        await put(`/api/teams/${team.id}/shared`, { text: teamPrompt });
      }
      setState({ busy: false, error: null, saved: true });
    } catch (err) {
      setState({ busy: false, error: (err as Error).message, saved: false });
    }
  };

  return (
    <Modal label={`Inställningar för ${nameOf(role)}`} onClose={onClose} wide>
      <header className="modal-head">
        <Avatar team={team.id} role={role} size="xl" />
        <div>
          <p className="eyebrow">teams/{team.id}/roles/{role.id}.md</p>
          <h2>{nameOf(role)}</h2>
          <p className="desk-title">{role.nick ? `${role.name} · ${role.title}` : role.title}</p>
        </div>
        <button type="button" className="btn btn-quiet modal-close" onClick={onClose} aria-label="Stäng">
          Stäng
        </button>
      </header>
      <div className="segmented" role="tablist" aria-label="Inställningar">
        <button type="button" role="tab" aria-selected={tab === 'agent'} onClick={() => setTab('agent')}>
          {nameOf(role)}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'looks'} onClick={() => setTab('looks')}>
          Utseende
        </button>
        <button type="button" role="tab" aria-selected={tab === 'notes'} onClick={() => setTab('notes')}>
          Lärdomar
        </button>
        <button type="button" role="tab" aria-selected={tab === 'team'} onClick={() => setTab('team')}>
          Teamets regler
        </button>
      </div>

      {tab === 'agent' ? (
        <div className="form">
          <div className="form-row">
            <label className="field">
              <span>Namn</span>
              <input value={draft.nick} onChange={(e) => set('nick', e.target.value)} placeholder={draft.name} maxLength={30} />
              <small>Vad agenten heter. Hela teamet får veta det och kan nämna agenten vid namn. Tomt: rollen.</small>
            </label>
            <label className="field">
              <span>Roll</span>
              <input value={draft.name} onChange={(e) => set('name', e.target.value)} />
            </label>
          </div>
          <label className="field">
            <span>Uppdrag (en rad)</span>
            <input value={draft.title} onChange={(e) => set('title', e.target.value)} />
          </label>
          <div className="form-row">
            <label className="field">
              <span>Typ</span>
              <select value={draft.kind} onChange={(e) => set('kind', e.target.value as RoleKind)}>
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              <span>Modell</span>
              <ModelSelect value={draft.model} onChange={(v) => set('model', v)} />
              {model?.note && <small>{model.note}</small>}
            </label>
            <label className="field">
              <span>Modell vid uppföljning</span>
              <ModelSelect value={draft.wakeModel} onChange={(v) => set('wakeModel', v)} allowSame />
              <small>När den väcks av sina kort eller standup, inte när den planerar.</small>
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              <span>Behörighet</span>
              <select value={draft.permission} onChange={(e) => set('permission', e.target.value)}>
                {PERMISSIONS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field field-check">
              <input type="checkbox" checked={draft.worktree} onChange={(e) => set('worktree', e.target.checked)} />
              <span>Egen worktree och branch per kort</span>
            </label>
          </div>
          <McpPicker team={team} value={draft.mcp} onChange={(v) => set('mcp', v)} />
          {team.repos.length > 1 && (
            <label className="field">
              <span>Repon (det första är agentens eget; korten får worktree där)</span>
              <input value={draft.repos} onChange={(e) => set('repos', e.target.value)} placeholder={team.repos.map((r) => r.id).join(', ')} />
              <small>Finns: {team.repos.map((r) => r.id).join(', ')}. Tomt: {team.repos[0].id}.</small>
            </label>
          )}
          <label className="field">
            <span>Äger (sökvägar, kommaseparerade)</span>
            <input value={draft.owns} onChange={(e) => set('owns', e.target.value)} placeholder="Tomt = hela repot" />
          </label>
          <label className="field">
            <span>Personlighet (till kontoret och porträttet)</span>
            <input value={draft.vibe} onChange={(e) => set('vibe', e.target.value)} />
          </label>
          <label className="field">
            <span>Instruktioner</span>
            <textarea className="prompt" value={draft.prompt} onChange={(e) => set('prompt', e.target.value)} rows={16} />
            <small>Läggs till efter de gemensamma reglerna och teamets regler. Gäller från agentens nästa tur.</small>
          </label>
        </div>
      ) : tab === 'looks' ? (
        <Looks
          team={team}
          role={role}
          character={draft.character ?? ''}
          onChange={(p) => {
            setDraft((d) => ({ ...d, ...p }));
            setState((st) => ({ ...st, saved: false }));
          }}
        />
      ) : tab === 'notes' ? (
        <div className="form">
          <label className="field">
            <span>Det {nameOf(role)} har lärt sig i {team.name} (teams/{team.id}/notes/{role.id}.md)</span>
            <textarea
              className="prompt"
              value={notes ?? ''}
              placeholder={notes === null ? 'Hämtar …' : 'Inget ännu. Agenten sparar lärdomar med save_note: kommandon som fungerar, fallgropar, och rättelser du ger.'}
              onChange={(e) => {
                setNotes(e.target.value);
                setState((s) => ({ ...s, saved: false }));
              }}
              rows={18}
            />
            <small>Följer med i varje nytt kort för rollen. Stryk det som inte stämmer längre, eller skriv in en regel själv.</small>
          </label>
        </div>
      ) : (
        <div className="form">
          <label className="field">
            <span>Gäller alla i {team.name} (teams/{team.id}/shared.md)</span>
            <textarea
              className="prompt"
              value={teamPrompt}
              onChange={(e) => {
                setTeamPrompt(e.target.value);
                setState((s) => ({ ...s, saved: false }));
              }}
              rows={18}
            />
            <small>Regler för alla team står i shared.md i kontrollrummets rot.</small>
          </label>
        </div>
      )}

      <footer className="modal-foot">
        {state.error && <span className="composer-error">{state.error}</span>}
        {state.saved && <span className="saved">Sparat. Gäller från nästa tur.</span>}
        <button type="button" className="btn" onClick={onClose}>
          Stäng
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={state.busy}>
          Spara
        </button>
      </footer>
    </Modal>
  );
}

/** Which character an agent is drawn as in the office. */
function Looks({
  team,
  role,
  character,
  onChange,
}: {
  team: Team;
  role: Role;
  character: string;
  onChange: (p: Partial<Pick<Role, 'character'>>) => void;
}) {
  const wardrobe = useWardrobe();
  const own = defaultCharacter(role);
  const chosen = character || own;
  if (!wardrobe) return <p className="settings-muted">Hämtar garderoben …</p>;
  if (!wardrobe.characters.length)
    return <p className="settings-muted">Garderoben är tom. Den byggs med node scripts/characters.mjs build.</p>;
  // The role's own first, then the templates, then the wardrobe.
  const list = [...wardrobe.characters].sort((a, b) => Number(b.id === own) - Number(a.id === own));
  const built = wardrobe.characters.find((c) => c.id === chosen)?.built;
  return (
    <div className="form">
      {built && (
        <Suspense fallback={<div className="looks-preview" />}>
          <Preview character={chosen} />
        </Suspense>
      )}
      <fieldset className="field looks">
        <span>Gubbe</span>
        <div className="looks-grid" role="radiogroup" aria-label="Gubbe">
          {list.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={chosen === c.id}
              className="looks-pick"
              title={c.built ? c.label : `${c.label} (ritas i lera tills 3D-modellen finns)`}
              onClick={() => onChange({ character: c.id === own ? '' : c.id })}
            >
              <img src={c.id === own && !character ? avatarUrl(team.id, role) : portraitUrl(c.id)} alt="" loading="lazy" />
              <span>{c.id === own ? `${c.label} (standard)` : c.label}</span>
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
