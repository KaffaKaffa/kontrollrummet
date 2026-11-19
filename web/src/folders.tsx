import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from './settings.tsx';

/**
 * Picking a folder on the Mac from the page. A browser's own file picker never
 * tells a page the real path, so the server lists the folders instead; it works
 * the same in the app, in a browser and on the phone.
 */

interface Listing {
  path: string;
  parent: string | null;
  home: string;
  git: boolean;
  entries: { name: string; git: boolean }[];
}

const tilde = (p: string, home: string) => (p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

function FolderBrowser({ start, onPick, onClose, gitOnly }: { start: string; onPick: (path: string) => void; onClose: () => void; gitOnly?: boolean }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const open = (path: string) =>
    void fetch(`/api/fs?path=${encodeURIComponent(path)}${hidden ? '&hidden' : ''}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
        setListing(data as Listing);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => open(listing?.path ?? start), [hidden]);

  const crumbs = listing
    ? (() => {
        const shown = tilde(listing.path, listing.home);
        const base = shown.startsWith('~') ? listing.home : '';
        const parts = shown.replace(/^~/, '').split('/').filter(Boolean);
        return [
          { label: shown.startsWith('~') ? '~' : '/', path: base || '/' },
          ...parts.map((p, i) => ({ label: p, path: `${base}/${parts.slice(0, i + 1).join('/')}` })),
        ];
      })()
    : [];

  return (
    <Modal label="Välj mapp" onClose={onClose} wide>
      <header className="modal-head">
        <div>
          <p className="eyebrow">Välj mapp</p>
          <nav className="crumbs" aria-label="Sökväg">
            {crumbs.map((c, i) => (
              <span key={c.path}>
                {i > 0 && crumbs[0].label !== '/' ? <span className="crumb-sep">/</span> : i > 1 && <span className="crumb-sep">/</span>}
                <button type="button" className="link-btn" onClick={() => open(c.path)}>
                  {c.label}
                </button>
              </span>
            ))}
          </nav>
        </div>
        <button type="button" className="btn btn-quiet modal-close" onClick={onClose}>
          Stäng
        </button>
      </header>
      {error && <p className="composer-error">{error}</p>}
      <ul className="folder-list">
        {listing?.parent && (
          <li>
            <button type="button" onClick={() => open(listing.parent!)}>
              <span aria-hidden="true">↑</span> ..
            </button>
          </li>
        )}
        {listing?.entries.length === 0 && <li className="settings-muted">Inga mappar här.</li>}
        {listing?.entries.map((e) => (
          <li key={e.name}>
            <button type="button" onClick={() => open(`${listing.path}/${e.name}`)} onDoubleClick={() => e.git && onPick(`${listing.path}/${e.name}`)}>
              <span aria-hidden="true">📁</span> {e.name}
              {e.git && <span className="badge badge-done">git</span>}
            </button>
          </li>
        ))}
      </ul>
      <footer className="modal-foot">
        <label className="field-check">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          <span>Visa dolda</span>
        </label>
        {listing && gitOnly && !listing.git && <span className="settings-muted">Inget git-repo</span>}
        <button type="button" className="btn" onClick={onClose}>
          Avbryt
        </button>
        <button type="button" className="btn btn-primary" disabled={!listing || (gitOnly && !listing.git)} onClick={() => listing && onPick(listing.path)}>
          Välj {listing ? tilde(listing.path, listing.home).split('/').pop() || '~' : ''}
        </button>
      </footer>
    </Modal>
  );
}

/** A path field with a Bläddra button; typing still works. */
export function FolderField({
  value,
  onChange,
  placeholder,
  label,
  gitOnly,
  onPicked,
  onEnter,
}: {
  value: string;
  onChange: (path: string) => void;
  placeholder?: string;
  label: string;
  /** Only a git checkout can be chosen. */
  gitOnly?: boolean;
  /** After a folder is picked in the browser (not typed). */
  onPicked?: (path: string) => void;
  /** Enter in the field. */
  onEnter?: () => void;
}) {
  const [browsing, setBrowsing] = useState(false);
  return (
    <span className="folder-field">
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} onKeyDown={(e) => e.key === 'Enter' && onEnter?.()} />
      <button type="button" className="btn" onClick={() => setBrowsing(true)}>
        Bläddra…
      </button>
      {browsing &&
        // Outside the form's <label>, so clicks in the dialog are not passed on to the field.
        createPortal(
        <FolderBrowser
          start={value.trim() || '~/Dev'}
          gitOnly={gitOnly}
          onClose={() => setBrowsing(false)}
          onPick={(path) => {
            onChange(path);
            setBrowsing(false);
            onPicked?.(path);
          }}
        />,
        document.body,
      )}
    </span>
  );
}
