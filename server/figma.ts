import { execFile } from './proc.ts';
import { promisify } from 'node:util';
import { getMark, setMark } from './db.ts';
import { readSecretAsync } from './secrets.ts';

const run = promisify(execFile);

/**
 * The real names behind a Figma link, for the board's link chips: the file's
 * name and, when the link points at a node, that frame's. Read with a personal
 * access token in the keychain (control-room-figma, scope file_content:read)
 * and remembered, so each link costs one call ever. Without a token: null, and
 * the board shows the name from the URL.
 */

let token: string | null | undefined;

async function figmaToken(): Promise<string | null> {
  if (token !== undefined) return token;
  try {
    token = await readSecretAsync('control-room-figma');
  } catch {
    token = null;
  }
  // Looked up again in ten minutes, so adding the token needs no restart.
  setTimeout(() => (token = undefined), 10 * 60_000);
  return token;
}

export async function figmaTitle(href: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!/(^|\.)figma\.com$/.test(url.hostname)) return null;
  const [, , key] = url.pathname.split('/');
  if (!key) return null;
  const node = url.searchParams.get('node-id')?.replace(/-/g, ':') ?? null;
  const cacheKey = `${key}|${node ?? ''}`;
  const cached = getMark('figma-title', cacheKey);
  if (cached) return cached;

  const t = await figmaToken();
  if (!t) return null;
  const api = node
    ? `https://api.figma.com/v1/files/${key}/nodes?ids=${encodeURIComponent(node)}&depth=1`
    : `https://api.figma.com/v1/files/${key}?depth=1`;
  const res = await fetch(api, { headers: { 'X-Figma-Token': t } });
  if (!res.ok) return null;
  const body = (await res.json()) as { name?: string; nodes?: Record<string, { document?: { name?: string } } | null> };
  const file = body.name ?? null;
  const frame = node ? body.nodes?.[node]?.document?.name : undefined;
  const title = [file, frame].filter(Boolean).join(' · ') || null;
  if (title) setMark('figma-title', cacheKey, title);
  return title;
}
