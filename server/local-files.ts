import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import { spawn } from './proc.ts';

/**
 * Pictures an agent points at with a file:// link (a folder of screenshots, one
 * image), shown on the card as thumbnails. Only image files, and only under the
 * home folder or the temp folders: the board can look at what agents save, not
 * at the whole disk.
 */

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
};

/** At most this many pictures from one folder. */
const MAX = 80;

const ROOTS = [homedir(), tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'].flatMap((r) => {
  try {
    return [realpathSync(r)];
  } catch {
    return [];
  }
});

/** The real path when it is under a root the board may show; null otherwise. */
function allowed(path: string): string | null {
  let real: string;
  try {
    real = realpathSync(resolve(path));
  } catch {
    return null;
  }
  return ROOTS.some((r) => real === r || real.startsWith(r + sep)) ? real : null;
}

const isImage = (file: string) => extname(file).toLowerCase() in IMAGE_TYPES;

export interface LocalImages {
  /** The folder the pictures are in. */
  dir: string;
  images: { path: string; name: string }[];
  /** More pictures than shown. */
  more: number;
}

/** The pictures a link points at: the file itself, or the images in the folder, by name. */
export function localImages(path: string): LocalImages | null {
  const real = allowed(path);
  if (!real || !existsSync(real)) return null;
  const st = statSync(real);
  if (st.isFile()) return isImage(real) ? { dir: dirname(real), images: [{ path: real, name: basename(real) }], more: 0 } : null;
  if (!st.isDirectory()) return null;
  const all = readdirSync(real, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && isImage(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'sv', { numeric: true }));
  return { dir: real, images: all.slice(0, MAX).map((name) => ({ path: join(real, name), name })), more: Math.max(0, all.length - MAX) };
}

/** One picture's bytes, or 404 for anything that is not an image the board may show. */
export function serveLocalImage(res: ServerResponse, path: string) {
  const real = allowed(path);
  if (!real || !isImage(real) || !existsSync(real) || !statSync(real).isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': IMAGE_TYPES[extname(real).toLowerCase()], 'cache-control': 'no-cache' });
  res.end(readFileSync(real));
}

/** Shows the folder (or the file in its folder) in Finder or Explorer. */
export function reveal(path: string): boolean {
  const real = allowed(path);
  if (!real || !existsSync(real)) return false;
  const child =
    process.platform === 'win32'
      ? spawn('explorer', [statSync(real).isDirectory() ? real : `/select,${real}`], { stdio: 'ignore', detached: true })
      : spawn('open', statSync(real).isDirectory() ? [real] : ['-R', real], { stdio: 'ignore', detached: true });
  child.unref();
  return true;
}
