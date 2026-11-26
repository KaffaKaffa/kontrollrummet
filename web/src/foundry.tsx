import { useState } from 'react';
import { del, post, put, type Account } from './api.ts';
import { useAction } from './project.tsx';

type Tier = 'opus' | 'sonnet' | 'haiku';
const TIERS: [Tier, string][] = [
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
];

interface TierResult {
  tier: Tier;
  deployment: string;
  own: boolean;
  ok: boolean;
  ms: number;
  message: string;
}

/** What each tier runs now, with the fallback spelled out. */
function runsNow(a: Account, tier: Tier, label: string) {
  const own = a.explicit?.[tier];
  if (own) return `${label} → ${own}`;
  const fallback = TIERS.find(([t]) => a.explicit?.[t] && a.models?.[t] === a.models?.[tier]);
  return `${label} → använder ${fallback?.[1] ?? '?'}`;
}

/** The kind of account, as a badge. */
export function KindBadge({ account }: { account: Account }) {
  return <small className="settings-muted">{account.kind === 'foundry' ? 'Microsoft Foundry' : 'Claude'}</small>;
}

/** Foundry accounts as a settings row: status, the login button, test and edit. */
export function FoundryRow({ account, onEdit }: { account: Account; onEdit: () => void }) {
  const act = useAction();
  const test = useAction();
  const [results, setResults] = useState<TierResult[] | null>(null);
  const runTest = () =>
    void test.run(async () => {
      setResults(null);
      setResults(((await post(`/api/accounts/${account.id}/test`)) as { results: TierResult[] }).results);
    });
  const key = account.auth === 'key';
  return (
    <>
      <div className="settings-row">
        <strong>{account.name}</strong> <KindBadge account={account} />
        <small className="settings-muted"> {account.detail}</small>
        {account.ready ? (
          <small> Redo</small>
        ) : (
          <button type="button" className="btn btn-quiet" onClick={() => void act.run(() => post(`/api/accounts/${account.id}/${key ? 'key' : 'login'}`))}>
            {key ? 'Ange nyckel' : 'Logga in i Azure'}
          </button>
        )}
        <button type="button" className="btn btn-quiet" disabled={test.busy} onClick={runTest}>
          {test.busy ? 'Testar …' : results ? 'Testa igen' : 'Testa anslutningen'}
        </button>
        <button type="button" className="link-btn" onClick={onEdit}>
          Ändra
        </button>
        {act.error && <span className="composer-error">{act.error}</span>}
      </div>
      <p className="settings-muted">
        Kör nu: {TIERS.map(([t, l]) => runsNow(account, t, l)).join(' · ')}
      </p>
      {test.busy && <p className="settings-muted">Kör en kort fråga per nivå (bråkdelar av en krona, Opus mest). Tar upp till en minut.</p>}
      {test.error && <span className="composer-error">{test.error}</span>}
      {results && (
        <ul className="settings-list">
          {results.map((r) => (
            <li key={r.tier} className="settings-row">
              <strong>{TIERS.find(([t]) => t === r.tier)?.[1]}</strong>
              <small className={r.ok ? '' : 'composer-error'}>
                {r.ok ? `OK · ${(r.ms / 1000).toFixed(1).replace('.', ',')} s · ${r.deployment}` : r.message}
                {!r.own && ` (${r.ok ? 'ingen egen deployment' : 'ingen egen deployment'}, använder en annan nivå)`}
              </small>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The form for adding a Foundry account, or editing one. */
export function FoundryForm({ account, onDone }: { account?: Account; onDone: () => void }) {
  const save = useAction();
  const [name, setName] = useState(account?.name ?? '');
  const [resource, setResource] = useState(account?.resource ?? account?.baseUrl ?? '');
  const [auth, setAuth] = useState<'key' | 'entra'>(account?.auth ?? 'entra');
  const [tenant, setTenant] = useState(account?.tenant ?? '');
  const [dep, setDep] = useState<Record<Tier, string>>({ opus: account?.explicit?.opus ?? '', sonnet: account?.explicit?.sonnet ?? '', haiku: account?.explicit?.haiku ?? '' });
  const remove = useAction();

  const submit = () =>
    void save.run(async () => {
      const body = { name, resource, auth, tenant, deployments: dep };
      if (account) await put(`/api/accounts/${account.id}`, body);
      else {
        const { id } = (await post('/api/accounts', body)) as { id: string };
        // The key is asked for in Terminal straight away; Entra ID waits for the button.
        if (auth === 'key') await post(`/api/accounts/${id}/key`);
      }
      onDone();
    });

  return (
    <form
      className="settings-section"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3>{account ? `Ändra ${account.name}` : 'Lägg till Foundry-konto'}</h3>
      <label className="field">
        <span>Namn</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Foundry" />
      </label>
      <label className="field">
        <span>Resurs eller endpoint</span>
        <input value={resource} onChange={(e) => setResource(e.target.value)} placeholder="min-resurs  eller  https://min-resurs.services.ai.azure.com" />
        <small>Resursnamnet, eller hela adressen. Servern rättar till formen.</small>
      </label>
      <fieldset className="field">
        <span>Autentisering</span>
        <label className="field-inline">
          <input type="radio" checked={auth === 'entra'} onChange={() => setAuth('entra')} />
          <span>Entra ID (az login), rekommenderas. Kräver rollen Foundry User på resursen. Ingen nyckel lagras.</span>
        </label>
        <label className="field-inline">
          <input type="radio" checked={auth === 'key'} onChange={() => setAuth('key')} />
          <span>API-nyckel. Ligger i nyckelringen, aldrig i en fil. Den frågas efter i Terminal efter att du sparat.</span>
        </label>
        {auth === 'entra' && (
          <label className="field">
            <span>Tenant (valfritt)</span>
            <input value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="t.ex. min-organisation.onmicrosoft.com" />
            <small>Kontot får en egen az-profil, så inloggningen krockar inte med din vanliga az.</small>
          </label>
        )}
      </fieldset>
      <fieldset className="field">
        <span>Deployments (minst en)</span>
        <div className="field-inline">
          {TIERS.map(([t, l]) => (
            <label key={t} className="field">
              <span>{l}</span>
              <input value={dep[t]} onChange={(e) => setDep({ ...dep, [t]: e.target.value })} placeholder={`claude-${t}-…`} />
            </label>
          ))}
        </div>
        <small>
          Namnet du gav deploymenten i Foundry. Döp den gärna till modellens id, så känner Claude Code igen den. En tom nivå använder en annan: Haiku Sonnet, Sonnet Opus, Opus Sonnet.
        </small>
      </fieldset>
      <div className="field-inline">
        <button type="submit" className="btn" disabled={save.busy}>
          Spara
        </button>
        <button type="button" className="btn btn-quiet" onClick={onDone}>
          Avbryt
        </button>
        {account && (
          <button
            type="button"
            className="btn btn-quiet"
            disabled={remove.busy}
            onClick={() => {
              if (confirm(`Ta bort ${account.name}? Nyckeln i nyckelringen raderas, profilmappen lämnas kvar.`))
                void remove.run(async () => {
                  await del(`/api/accounts/${account.id}`, {});
                  onDone();
                });
            }}
          >
            Ta bort
          </button>
        )}
        <small>
          <a href="https://github.com/KaffaKaffa/kontrollrummet/blob/main/docs/foundry.md" target="_blank" rel="noreferrer">
            Hur sätter jag upp Foundry?
          </a>
        </small>
      </div>
      {(save.error || remove.error) && <span className="composer-error">{save.error ?? remove.error}</span>}
    </form>
  );
}
