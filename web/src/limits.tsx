import { useEffect, useState } from 'react';
import { put, type Account, type Board, type Team } from './api.ts';
import { Section, useAction } from './project.tsx';
import { FoundryForm, FoundryRow, KindBadge } from './foundry.tsx';

const WARNING = 'Utan tak kan prenumerationens egna gränser nås, och då pausar agenterna tills kvoten har återställts.';
const FOUNDRY_WARNING = 'Utan tak kan kostnaden bli hög och resursens tokengräns (TPM) nås.';
const warningFor = (a?: Account) => (a?.kind === 'foundry' ? FOUNDRY_WARNING : WARNING);

/** A cap as a number or "Ingen gräns". Saves when changed. */
function CapField({ value, onSave, busy }: { value: number | null; onSave: (cap: number | null) => void; busy: boolean }) {
  const [text, setText] = useState(value === null ? '' : String(value));
  // Keep the last number when "Ingen gräns" is ticked, so unticking restores it.
  useEffect(() => {
    if (value !== null) setText(String(value));
  }, [value]);
  const commit = () => {
    const n = Math.floor(Number(text));
    if (Number.isFinite(n) && n >= 1 && n !== value) onSave(Math.min(n, 99));
    else if (value !== null) setText(String(value));
  };
  return (
    <div className="field-inline">
      <label className="field-inline">
        <input
          type="checkbox"
          checked={value === null}
          disabled={busy}
          onChange={(e) => onSave(e.target.checked ? null : Math.max(1, Math.floor(Number(text)) || 2))}
        />
        <span>Ingen gräns</span>
      </label>
      <input
        className="num"
        type="number"
        min={1}
        max={99}
        style={{ width: '5rem' }}
        aria-label="Högst så många agenter samtidigt"
        value={text}
        disabled={busy || value === null}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
    </div>
  );
}

function AccountCap({ account, teams }: { account: Account; teams: Team[] }) {
  const save = useAction();
  const open = teams.filter((t) => t.account === account.id && t.maxAgents === null);
  return (
    <li className="settings-row">
      <strong>{account.name}</strong>
      <KindBadge account={account} />
      {account.email && <small> {account.email}</small>}
      <CapField value={account.maxAgents} busy={save.busy} onSave={(cap) => void save.run(() => put(`/api/accounts/${account.id}/limit`, { maxAgents: cap }))} />
      {account.maxAgents === null && open.length > 0 && <small className="settings-muted">{warningFor(account)}</small>}
      {save.error && <span className="composer-error">{save.error}</span>}
    </li>
  );
}

/** The app's own settings, outside the projects: how many agents may work at once per account. */
export function AppSettings({ board }: { board: Board }) {
  // 'new', or the id of the Foundry account being edited.
  const [form, setForm] = useState<string | null>(null);
  const editing = board.accounts.find((a) => a.id === form);
  return (
    <div className="settings">
      <Section
        title="Konton"
        note="Högst så många agenter arbetar samtidigt på kontot, för alla projekt som använder det. Gudfaderns samtal räknas med. Ändringen gäller direkt, och kön sätter igång när taket höjs. Ett projekt kan ha ett eget tak under sina inställningar, och båda gäller. Ett konto är en Claude-prenumeration eller en Microsoft Foundry-resurs."
      >
        <ul className="settings-list">
          {board.accounts.map((a) => (
            <div key={a.id}>
              <AccountCap account={a} teams={board.teams} />
              {a.kind === 'foundry' && <FoundryRow account={a} onEdit={() => setForm(a.id)} />}
            </div>
          ))}
        </ul>
        {form === null ? (
          <button type="button" className="btn btn-quiet" onClick={() => setForm('new')}>
            + Lägg till Foundry-konto
          </button>
        ) : (
          <FoundryForm key={form} account={editing} onDone={() => setForm(null)} />
        )}
      </Section>
    </div>
  );
}

/** The project's own cap, under its settings. */
export function TeamCap({ board, team }: { board: Board; team: Team }) {
  const save = useAction();
  const account = board.accounts.find((a) => a.id === team.account);
  return (
    <Section title="Agenttak" note="Högst så många av projektets agenter arbetar samtidigt. Ett kort startar bara när både projektet och Claude-kontot har plats. Standard är ingen gräns.">
      <CapField value={team.maxAgents} busy={save.busy} onSave={(cap) => void save.run(() => put(`/api/teams/${team.id}/settings`, { maxAgents: cap }))} />
      {team.maxAgents === null && account?.maxAgents === null && <p className="settings-muted">{warningFor(account)}</p>}
      {save.error && <span className="composer-error">{save.error}</span>}
    </Section>
  );
}
