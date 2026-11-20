import { useEffect, useMemo, useState } from 'react';
import { post, put, type Account, type Board, type Conversation, type Role } from './api.ts';
import { ApprovalCard, Composer, Log, uploadTo } from './ui.tsx';
import { FolderField } from './folders.tsx';

/**
 * Gudfadern: the owner's own Claude, with no team. Conversations on the left,
 * the open one on the right: its folder, account, model and log, and a line
 * to write in.
 */

const GODFATHER: Role = {
  id: 'gudfadern',
  kind: 'lead',
  vibe: '',
  name: 'Gudfadern',
  nick: '',
  title: '',
  model: '',
  wakeModel: '',
  mcp: [],
  owns: [],
  repos: [],
  worktree: false,
  permission: 'auto',
  prompt: '',
};

const MODELS = [
  { id: 'opus', label: 'Opus 5.5' },
  { id: 'sonnet', label: 'Sonnet 5.5' },
  { id: 'haiku', label: 'Haiku 5.5' },
  { id: 'fable', label: 'Fable 5.2' },
];

const EFFORTS = [
  { id: 'low', label: 'Låg' },
  { id: 'medium', label: 'Medel' },
  { id: 'high', label: 'Hög' },
  { id: 'xhigh', label: 'Mycket hög' },
];

const STATUS: Record<Conversation['status'], string> = {
  idle: 'Väntar på dig',
  running: 'Arbetar',
  quota: 'Kvotstopp',
  error: 'Fel',
};

interface Folder {
  path: string;
  label: string;
  account: string | null;
  worktree?: boolean;
}

const LAST_ACCOUNT = 'gudfadern.account';
const remembered = () => {
  try {
    return localStorage.getItem(LAST_ACCOUNT);
  } catch {
    return null;
  }
};
const remember = (id: string) => {
  try {
    localStorage.setItem(LAST_ACCOUNT, id);
  } catch {
    // Only a convenience.
  }
};

function AccountSelect({ accounts, value, onChange, disabled }: { accounts: Account[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label="Claude-konto">
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
          {a.loggedIn ? '' : ' (inte inloggat)'}
        </option>
      ))}
    </select>
  );
}

function NewConversation({ board }: { board: Board }) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folder, setFolder] = useState('');
  const [custom, setCustom] = useState('');
  const [account, setAccount] = useState('');
  const [model, setModel] = useState('opus');
  const [effort, setEffort] = useState('medium');
  const [mcp, setMcp] = useState<'none' | 'all'>('none');
  const [worktree, setWorktree] = useState(false);
  const [created, setCreated] = useState<number | null>(null);

  useEffect(() => {
    void fetch('/api/folders')
      .then((r) => r.json())
      .then((list: Folder[]) => {
        setFolders(list);
        setFolder(list[0]?.path ?? '');
      });
  }, []);

  const chosen = folders.find((f) => f.path === folder);
  // The account: the project's own for its repo, else the last one used, else the default.
  useEffect(() => {
    const def = board.accounts.find((a) => a.isDefault)?.id ?? board.accounts[0]?.id ?? '';
    const last = remembered();
    setAccount(chosen?.account ?? (last && board.accounts.some((a) => a.id === last) ? last : def));
    setWorktree(Boolean(chosen?.worktree));
  }, [chosen, board.accounts]);

  const accountInfo = board.accounts.find((a) => a.id === account);
  const create = async () => {
    if (created) return created;
    const c = (await post('/api/conversations', {
      cwd: folder === '__custom' ? custom : folder,
      account,
      model,
      effort,
      mcp,
      worktree,
    })) as Conversation;
    remember(account);
    setCreated(c.id);
    return c.id;
  };

  return (
    <section className="plan gf-new" aria-label="Nytt samtal">
      <p className="eyebrow">Nytt samtal</p>
      <h2>Vad ska vi göra?</h2>
      <div className="form">
        <div className="form-row">
          <label className="field">
            <span>Mapp</span>
            <select value={folder} onChange={(e) => setFolder(e.target.value)}>
              {folders.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.label} · {f.path.replace(/^\/Users\/[^/]+/, '~')}
                </option>
              ))}
              <option value="__custom">Annan mapp…</option>
            </select>
            {folder === '__custom' && <FolderField value={custom} onChange={setCustom} placeholder="~/Dev/något" label="Sökväg" />}
          </label>
          <label className="field">
            <span>Claude-konto</span>
            <AccountSelect accounts={board.accounts} value={account} onChange={setAccount} />
            <small>
              {accountInfo?.loggedIn ? (
                `Inloggat som ${accountInfo.email}`
              ) : (
                <button type="button" className="link-btn" onClick={() => void post(`/api/accounts/${account}/login`)}>
                  Inte inloggat. Logga in i Terminal
                </button>
              )}
            </small>
          </label>
        </div>
        <div className="form-row">
          <label className="field">
            <span>Modell</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Tankenivå</span>
            <select value={effort} onChange={(e) => setEffort(e.target.value)}>
              {EFFORTS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>MCP-servrar</span>
            <select value={mcp} onChange={(e) => setMcp(e.target.value as 'none' | 'all')}>
              <option value="none">Bara kontrollrummets</option>
              <option value="all">Kontots alla (Figma, webbläsaren …)</option>
            </select>
            <small>Kontots alla läses in vid varje steg och kostar därefter.</small>
          </label>
        </div>
        <label className="field field-check">
          <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
          <span>Egen worktree och branch (för git-repon; ändringar tas i bruk med en knapp)</span>
        </label>
      </div>
      <Composer
        rows={4}
        placeholder="Skriv till Gudfadern…"
        submitLabel="Starta"
        onUpload={async (file) => uploadTo(`/api/conversations/${await create()}/upload`)(file)}
        onSubmit={async (text) => {
          const id = await create();
          await post(`/api/conversations/${id}/messages`, { text });
          location.hash = `#/gudfadern/${id}`;
        }}
      />
    </section>
  );
}

function ConversationView({ board, conversation, loadConvEvents }: { board: Board; conversation: Conversation; loadConvEvents: (id: number) => Promise<void> }) {
  const c = conversation;
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(c.title);
  useEffect(() => setTitle(c.title), [c.title]);
  useEffect(() => {
    void loadConvEvents(c.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id, board.generation]);
  const running = c.status === 'running';
  const set = (patch: Partial<Conversation>) =>
    void put(`/api/conversations/${c.id}`, patch)
      .then(() => setError(null))
      .catch((err: Error) => setError(err.message));
  const act = (action: string, then?: (r: unknown) => void) => () =>
    void post(`/api/conversations/${c.id}/${action}`)
      .then((r) => {
        setError(null);
        then?.(r);
      })
      .catch((err: Error) => setError(err.message));
  const approvals = board.approvals.filter((a) => a.conversationId === c.id);
  const account = board.accounts.find((a) => a.id === c.account);

  return (
    <section className="detail gf-detail" aria-label={c.title}>
      <header className="gf-head">
        <input
          className="gf-title"
          value={title}
          aria-label="Samtalets namn"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== c.title && set({ title })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className={`badge badge-${running ? 'running' : c.status === 'idle' ? 'done' : c.status === 'quota' ? 'quota' : 'failed'}`}>{STATUS[c.status]}</span>
      </header>
      <div className="detail-facts">
        <code className="filename" title={c.cwd}>
          {c.cwd.replace(/^\/Users\/[^/]+/, '~')}
        </code>
        {c.branch && <code className="filename">{c.branch}</code>}
        {c.costUsd > 0 && <span className="num">${c.costUsd.toFixed(2)}</span>}
        {c.contextTokens > 0 && (
          <span className="num" title="Hur mycket Claude läser om vid varje steg. Ny session börjar om med det senaste.">
            {Math.round(c.contextTokens / 1000)}k sammanhang
          </span>
        )}
      </div>
      <div className="gf-settings">
        <label className="select">
          <span>Konto</span>
          <AccountSelect accounts={board.accounts} value={c.account} onChange={(account) => set({ account })} disabled={running} />
        </label>
        <label className="select">
          <span>Modell</span>
          <select value={c.model} onChange={(e) => set({ model: e.target.value })}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            {!MODELS.some((m) => m.id === c.model) && <option value={c.model}>{c.model}</option>}
          </select>
        </label>
        <label className="select">
          <span>Tänker</span>
          <select value={c.effort} onChange={(e) => set({ effort: e.target.value })}>
            {EFFORTS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="select">
          <span>MCP</span>
          <select value={c.mcp} onChange={(e) => set({ mcp: e.target.value as 'none' | 'all' })}>
            <option value="none">Kontrollrummets</option>
            <option value="all">Kontots alla</option>
          </select>
        </label>
        {account && !account.loggedIn && (
          <button type="button" className="btn btn-quiet" onClick={() => void post(`/api/accounts/${account.id}/login`)}>
            Logga in {account.name}
          </button>
        )}
      </div>
      {approvals.map((a) => (
        <ApprovalCard key={a.id} approval={a} team="" role={GODFATHER} />
      ))}
      <Log events={board.convEvents[c.id] ?? []} team="control-room" role={GODFATHER} />
      {error && <p className="composer-error">{error}</p>}
      <Composer
        rows={3}
        placeholder={running ? 'Skriv, så blir det nästa tur…' : 'Skriv till Gudfadern…'}
        submitLabel="Skicka"
        onUpload={uploadTo(`/api/conversations/${c.id}/upload`)}
        onSubmit={(text) => post(`/api/conversations/${c.id}/messages`, { text })}
      >
        <button type="button" className="btn btn-quiet" onClick={act('stop')} disabled={!running}>
          Stoppa
        </button>
        <button type="button" className="btn btn-quiet" onClick={act('new-session')} disabled={running || !c.sessionId} title="Börja om med en ny session som får med sig det senaste">
          Ny session
        </button>
        <button type="button" className="btn btn-quiet" onClick={act('terminal')} disabled={!c.sessionId}>
          Terminal
        </button>
        {c.branch && (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={act('apply', (r) => {
              const { restart } = r as { restart: boolean };
              if (restart) setError('Tagen i bruk. Servern startar om när inga agenter arbetar.');
            })}
            disabled={running}
            title={`Mergar ${c.branch} in i ${c.repo}`}
          >
            Ta i bruk
          </button>
        )}
        <button type="button" className="btn btn-quiet" onClick={() => set({ archived: !c.archived })} disabled={running}>
          {c.archived ? 'Återställ' : 'Arkivera'}
        </button>
      </Composer>
    </section>
  );
}

export function Godfather({ board, openId, loadConvEvents }: { board: Board; openId: number | null; loadConvEvents: (id: number) => Promise<void> }) {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const list = useMemo(
    () =>
      board.conversations
        .filter((c) => c.archived === showArchived)
        .filter((c) => !query.trim() || c.title.toLowerCase().includes(query.trim().toLowerCase()))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [board.conversations, query, showArchived],
  );
  const open = openId != null ? board.conversations.find((c) => c.id === openId) : undefined;

  return (
    <div className="plans gf">
      <nav className="plan-list" aria-label="Samtal">
        <a className={`plan-item ${!open ? 'is-open' : ''}`} href="#/gudfadern">
          <span className="plan-item-title">+ Nytt samtal</span>
        </a>
        <input className="gf-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Sök samtal" aria-label="Sök samtal" />
        {list.map((c) => (
          <a key={c.id} className={`plan-item ${open?.id === c.id ? 'is-open' : ''}`} href={`#/gudfadern/${c.id}`}>
            <span className="plan-item-title">{c.title}</span>
            <span className="gf-item-meta">
              {c.status === 'running' && <span className="pulse" aria-hidden="true" />}
              {board.accounts.find((a) => a.id === c.account)?.name ?? c.account} · {c.cwd.split('/').filter(Boolean).at(-1)}
            </span>
          </a>
        ))}
        <button type="button" className="link-btn" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? 'Visa aktiva' : 'Visa arkiverade'}
        </button>
      </nav>
      {open ? <ConversationView key={open.id} board={board} conversation={open} loadConvEvents={loadConvEvents} /> : <NewConversation board={board} />}
    </div>
  );
}
