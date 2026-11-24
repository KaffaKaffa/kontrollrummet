import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { post } from './api.ts';

/**
 * Pictures on a card: thumbnails that open a lightbox to page through. Used for
 * an agent's file:// link to a folder of screenshots (or one image), and for
 * the images shown on the card itself.
 */

export interface Picture {
  src: string;
  name: string;
}

const localSrc = (path: string) => `/local-image?path=${encodeURIComponent(path)}`;

/** Full size, one at a time: arrows, swipe or ← → to page, Esc or a click outside to close. */
export function Lightbox({ pictures, start, onClose }: { pictures: Picture[]; start: number; onClose: () => void }) {
  const [at, setAt] = useState(start);
  const touch = useRef<number | null>(null);
  const go = useCallback((step: number) => setAt((i) => (i + step + pictures.length) % pictures.length), [pictures.length]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', key);
      document.body.style.overflow = overflow;
    };
  }, [go, onClose]);
  const pic = pictures[at];
  const many = pictures.length > 1;
  return createPortal(
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={pic.name}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touch.current == null) return;
        const dx = e.changedTouches[0].clientX - touch.current;
        touch.current = null;
        if (many && Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
      }}
    >
      <div className="lightbox-top">
        <span className="lightbox-name">
          {pic.name}
          {many && <span className="lightbox-count"> · {at + 1} av {pictures.length}</span>}
        </span>
        <a className="lightbox-btn" href={pic.src} target="_blank" rel="noreferrer" title="Öppna i ny flik">
          ↗
        </a>
        <button type="button" className="lightbox-btn" onClick={onClose} aria-label="Stäng" autoFocus>
          ✕
        </button>
      </div>
      <div className="lightbox-stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {many && (
          <button type="button" className="lightbox-nav lightbox-prev" onClick={() => go(-1)} aria-label="Föregående">
            ‹
          </button>
        )}
        <img key={pic.src} src={pic.src} alt={pic.name} />
        {many && (
          <button type="button" className="lightbox-nav lightbox-next" onClick={() => go(1)} aria-label="Nästa">
            ›
          </button>
        )}
      </div>
      {many && (
        <div className="lightbox-strip">
          {pictures.map((p, i) => (
            <button key={p.src} type="button" className={i === at ? 'is-current' : ''} onClick={() => setAt(i)} aria-label={p.name}>
              <img src={p.src} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

/** A row of thumbnails; a click opens the lightbox on that picture. */
export function Thumbs({ pictures }: { pictures: Picture[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <span className="thumbs">
        {pictures.map((p, i) => (
          <button key={p.src} type="button" className="thumb" onClick={() => setOpen(i)} title={p.name}>
            <img src={p.src} alt={p.name} loading="lazy" />
          </button>
        ))}
      </span>
      {open != null && <Lightbox pictures={pictures} start={open} onClose={() => setOpen(null)} />}
    </>
  );
}

interface Found {
  dir: string;
  images: { path: string; name: string }[];
  more: number;
}

/** What a file:// link points at, asked once per page load. */
const found = new Map<string, Promise<Found | null>>();

/**
 * An agent's file:// link: the folder or file by name, a button to show it in
 * Finder, and its pictures as thumbnails. Not a picture, or not readable: just
 * the name, so the text still reads.
 */
export function LocalLink({ path, title }: { path: string; title: string | null }) {
  const [pics, setPics] = useState<Found | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    if (!found.has(path)) {
      found.set(
        path,
        fetch(`/api/local-images?path=${encodeURIComponent(path)}`)
          .then((r) => (r.ok ? (r.json() as Promise<Found>) : null))
          .catch(() => null),
      );
    }
    void found.get(path)!.then((f) => live && setPics(f));
    return () => {
      live = false;
    };
  }, [path]);
  const name = title ?? path.replace(/\/$/, '').split('/').pop() ?? path;
  const pictures = (pics?.images ?? []).map((i) => ({ src: localSrc(i.path), name: i.name }));
  return (
    <span className="local-link">
      <button type="button" className="link-chip" title={`${path}\nVisa i Finder`} onClick={() => void post('/api/reveal', { path }).catch(() => undefined)}>
        <span aria-hidden="true">📁</span>
        <span>{name}</span>
        {pictures.length > 1 && <span className="local-count">{pictures.length + (pics?.more ?? 0)} bilder</span>}
      </button>
      {pictures.length > 0 && <Thumbs pictures={pictures} />}
    </span>
  );
}
