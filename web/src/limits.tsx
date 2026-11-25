import { useEffect, useState } from 'react';
import { put, type Account, type Board, type Team } from './api.ts';
import { Section, useAction } from './project.tsx';

const clamp = (n: number) => Math.min(99, Math.max(1, Math.floor(n) || 1));

/** A cap as "Tak" with a stepper, or "Ingen gräns". Saves when changed. */
export function CapField({ value, onSave, busy, label }: { value: number | null; onSave: (cap: number | null) => void; busy: boolean; label: string }) {
  const [last, setLast] = useState(value ?? 2);
  useEffect(() => {
    if (value !== null) setLast(value);
  }, [value]);
  const off = value === null;
  return (
    <div className="cap-field" role="group" aria-label={label}>
      <div className="segmented">
        <button type="button" aria-selected={!off} disabled={busy} onClick={() => off && onSave(last)}>
          Tak
        </button>
        <button type="button" aria-selected={off} disabled={busy} onClick={() => !off && onSave(null)}>
          Ingen gräns
        </button>
      </div>
      <div className="stepper" aria-disabled={off}>
        <button type="button" aria-label="Minska" disabled={busy || value === null || value <= 1} onClick={() => value !== null && onSave(clamp(value - 1))}>
          −
        </button>
        <input
          className="num"
          type="number"
          min={1}
          max={99}
          aria-label="Högst så många agenter samtidigt"
          key={value ?? 'off'}
          defaultValue={value ?? ''}
          disabled={busy || off}
          onBlur={(e) => {
            const n = clamp(Number(e.target.value));
            if (n !== value) onSave(n);
            else e.target.value = String(value);
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <button type="button" aria-label="Öka" disabled={busy || value === null || value >= 99} onClick={() => value !== null && onSave(clamp(value + 1))}>
          +
        </button>
      </div>
    </div>
  );
}

function Warning({ children }: { children: string }) {
  return (
    <p className="cap-warning" role="note">
      <span aria-hidden="true">⚠</span> {children}
    </p>
  );
}

function AccountCap({ account, teams }: { account: Account; teams: Team[] }) {
  const save = useAction();
  const open = teams.some((t) => t.account === account.id && t.maxAgents === null);
  return (
    <li className="cap-card">
      <div className="cap-card-head">
        <div>
          <strong>{account.email ?? account.name}</strong>
          {account.email && <small className="settings-muted"> {account.name}</small>}
        </div>
        {account.loggedIn && <span className="badge badge-done">Inloggad</span>}
      </div>
      <div className="cap-row">
        <div>
          <div className="cap-title">Agenter samtidigt</div>
          <small className="settings-muted">Så många kort får köra på kontot åt gången.</small>
        </div>
        <CapField label={`Agenter samtidigt på ${account.name}`} value={account.maxAgents} busy={save.busy} onSave={(cap) => void save.run(() => put(`/api/accounts/${account.id}/limit`, { maxAgents: cap }))} />
      </div>
      {account.maxAgents === null && open && <Warning>Inget tak på kontot. Slår du också av taket per projekt kan abonnemangets egna gränser nås och agenterna pausas.</Warning>}
      {save.error && <span className="composer-error">{save.error}</span>}
    </li>
  );
}

/** The app's own settings, outside the projects: how many agents may work at once per Claude account. */
export function AppSettings({ board }: { board: Board }) {
  return (
    <div className="settings">
      <Section title="Claude-konton">
        <ul className="cap-cards">
          {board.accounts.map((a) => (
            <AccountCap key={a.id} account={a} teams={board.teams} />
          ))}
        </ul>
        <p className="settings-note">Taket gäller kontot över alla projekt. Det gäller samtidigt med projektets tak: ett kort startar bara om båda har plats.</p>
      </Section>
    </div>
  );
}

/** The project's own cap, under its settings. */
export function TeamCap({ board, team }: { board: Board; team: Team }) {
  const save = useAction();
  const account = board.accounts.find((a) => a.id === team.account);
  return (
    <Section title="Agenter samtidigt i projektet" note="Standard: ingen gräns. Räcker det med taket per Claude-konto behöver du inte ställa in något här.">
      <div className="cap-card">
        <div className="cap-row">
          <div className="cap-title">Agenter samtidigt i projektet</div>
          <CapField label="Agenter samtidigt i projektet" value={team.maxAgents} busy={save.busy} onSave={(cap) => void save.run(() => put(`/api/teams/${team.id}/settings`, { maxAgents: cap }))} />
        </div>
        {team.maxAgents === null && account?.maxAgents === null && <Warning>Varken konto eller projekt har något tak. Abonnemangets gränser kan nås och agenterna pausas tills kvoten förnyas.</Warning>}
        {save.error && <span className="composer-error">{save.error}</span>}
      </div>
      {account && account.maxAgents !== null && (
        <p className="settings-note">
          Kontot {account.email ?? account.name} har tak {account.maxAgents}. Båda gäller: ett kort startar bara om både kontot och projektet har plats.
        </p>
      )}
    </Section>
  );
}
