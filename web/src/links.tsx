import { useEffect, useState, type ReactNode } from 'react';

/**
 * Text from agents with its links made usable: a Figma link shows as the
 * file's name behind Figma's logo, a GitHub PR as "PR #123", anything else as
 * a plain link. Markdown links ([title](url)) keep their title. Built as React
 * elements, never HTML.
 */

const LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?])/g;

function FigmaLogo() {
  return (
    <svg viewBox="0 0 38 57" width="10" height="15" aria-hidden="true">
      <path fill="#1abcfe" d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z" />
      <path fill="#0acf83" d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z" />
      <path fill="#ff7262" d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19z" />
      <path fill="#f24e1e" d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z" />
      <path fill="#a259ff" d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z" />
    </svg>
  );
}

function GitHubLogo() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

/** Names already asked for, so each link is asked about once per page load. */
const titles = new Map<string, Promise<string | null>>();

function FigmaChip({ href, fallback }: { href: string; fallback: string }) {
  const [name, setName] = useState(fallback);
  useEffect(() => {
    let live = true;
    if (!titles.has(href)) {
      titles.set(
        href,
        fetch(`/api/link-title?url=${encodeURIComponent(href)}`)
          .then((r) => r.json() as Promise<{ title: string | null }>)
          .then((r) => r.title)
          .catch(() => null),
      );
    }
    void titles.get(href)!.then((t) => live && t && setName(t));
    return () => {
      live = false;
    };
  }, [href]);
  return (
    <a href={href} target="_blank" rel="noreferrer" className="link-chip" title={href}>
      <FigmaLogo />
      <span>{name}</span>
    </a>
  );
}

/** "Mitt Design System" from figma.com/design/<key>/Mitt-Design-System?node-id=… */
function figmaName(url: URL): string {
  const slug = url.pathname.split('/')[3];
  if (!slug) return 'Figma';
  try {
    return decodeURIComponent(slug).replace(/-/g, ' ').trim() || 'Figma';
  } catch {
    return slug;
  }
}

function link(href: string, title: string | null, key: number): ReactNode {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  const common = { key, href, target: '_blank', rel: 'noreferrer' } as const;
  if (/(^|\.)figma\.com$/.test(url.hostname)) {
    return <FigmaChip key={key} href={href} fallback={title ?? figmaName(url)} />;
  }
  const pr = url.hostname === 'github.com' ? /^\/[^/]+\/[^/]+\/(pull|issues)\/(\d+)/.exec(url.pathname) : null;
  if (pr) {
    return (
      <a {...common} className="link-chip" title={href}>
        <GitHubLogo />
        <span>{title ?? `${pr[1] === 'pull' ? 'PR' : 'Issue'} #${pr[2]}`}</span>
      </a>
    );
  }
  return (
    <a {...common} className="link-plain">
      {title ?? href}
    </a>
  );
}

/** Splits text into strings and links; strings are left for the caller to style further. */
export function linkify(text: string, rest: (part: string, key: number) => ReactNode = (p) => p): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    if (m.index > last) out.push(rest(text.slice(last, m.index), last));
    out.push(m[2] ? link(m[2], m[1], m.index) : link(m[3], null, m.index));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(rest(text.slice(last), last));
  return out;
}

export function Linked({ text }: { text: string }) {
  return <>{linkify(text)}</>;
}
