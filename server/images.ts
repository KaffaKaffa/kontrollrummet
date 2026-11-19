import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, normalize, resolve } from 'node:path';
import { DATA_DIR, HOST, PORT } from './config.ts';
import { slug } from './worktree.ts';

export const IMAGES_DIR = join(DATA_DIR, 'images');
export const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2';

export const imagesAvailable = () => Boolean(process.env.OPENAI_API_KEY);

export interface GeneratedImage {
  /** Where the image is on disk, in the control room's own store. */
  path: string;
  /** Served by the control room, for the board and for a quick look. */
  url: string;
  /** Set when the agent asked for a copy inside its worktree. */
  copiedTo?: string;
}

type Size = '1024x1024' | '1536x1024' | '1024x1536' | 'auto';

/**
 * One image from OpenAI's image API. The prompt goes to OpenAI, so it must not
 * carry personal or customer data; the tool description says so to the agent.
 */
export async function generateImage(opts: {
  team: string;
  prompt: string;
  name?: string;
  size?: Size;
  /** A path relative to the agent's worktree to copy the result to. */
  saveTo?: string;
  worktree?: string | null;
}): Promise<GeneratedImage> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY saknas för kontrollrummets server');

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt: opts.prompt,
      size: opts.size ?? '1024x1024',
      n: 1,
    }),
  });
  const data = (await res.json()) as { data?: { b64_json?: string }[]; error?: { message?: string } };
  const b64 = data.data?.[0]?.b64_json;
  if (!res.ok || !b64) throw new Error(`OpenAI: ${data.error?.message ?? `HTTP ${res.status}`}`);

  const file = `${slug(opts.name ?? opts.prompt)}-${Date.now()}.png`;
  const dir = join(IMAGES_DIR, opts.team);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, Buffer.from(b64, 'base64'));

  const image: GeneratedImage = { path, url: `http://${HOST}:${PORT}/images/${opts.team}/${file}` };
  if (opts.saveTo && opts.worktree) {
    const target = normalize(resolve(opts.worktree, opts.saveTo));
    if (!target.startsWith(opts.worktree)) throw new Error('save_to måste ligga i din worktree');
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(path, target);
    image.copiedTo = target;
  }
  return image;
}

/**
 * Puts a picture the agent made itself (a simulator screenshot, a Playwright
 * capture) on its card. Copied into the control room's store, so it survives
 * the worktree being removed.
 */
/**
 * A file the owner pasted or dropped into a card's message: saved with the
 * team's images, so the board shows it and the agent reads it by its path.
 */
export function saveCardUpload(team: string, name: string, base64: string): GeneratedImage {
  const data = Buffer.from(base64, 'base64');
  if (data.length > 20 * 1024 * 1024) throw new Error('filen är större än 20 MB');
  const ext = (extname(name).toLowerCase() || '.png').replace(/[^.\w]/g, '').slice(0, 10);
  const dir = join(IMAGES_DIR, team);
  mkdirSync(dir, { recursive: true });
  const file = `${slug(basename(name, extname(name))) || 'bild'}-${Date.now()}${ext}`;
  const path = join(dir, file);
  writeFileSync(path, data);
  return { path, url: `http://${HOST}:${PORT}/images/${team}/${file}` };
}

export function attachImage(opts: { team: string; path: string; worktree?: string | null }): GeneratedImage {
  const source = resolve(opts.worktree ?? '/', opts.path);
  if (!existsSync(source)) throw new Error(`hittar inte ${source}`);
  const ext = extname(source).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) throw new Error('bara png, jpg, webp eller gif');
  if (statSync(source).size > 15 * 1024 * 1024) throw new Error('bilden är större än 15 MB; krymp den med sips -Z 1600');
  const dir = join(IMAGES_DIR, opts.team);
  mkdirSync(dir, { recursive: true });
  const file = `${slug(basename(source, ext))}-${Date.now()}${ext}`;
  const path = join(dir, file);
  copyFileSync(source, path);
  return { path, url: `http://${HOST}:${PORT}/images/${opts.team}/${file}` };
}

/** The block the board's message box adds after the text: the agent reads the files by these paths. */
const ATTACHED = /\n*Bifogat \(läs med Read\):\n((?:- .*(?:\n|$))+)\s*$/;
const ONLY_FILES = /^Se (den bifogade bilden|de bifogade bilderna)\.$/;

/**
 * A message as the owner sees it in the log: what he wrote, without the
 * paths meant for the agent. With names, the files are named in one short line
 * (where no thumbnail shows them); empty when there is nothing left to show.
 */
export function shownText(text: string, { names = false } = {}): string {
  const m = ATTACHED.exec(text);
  if (!m) return text;
  const body = text.slice(0, m.index).trim();
  const files = m[1].split('\n').map((l) => l.replace(/^- /, '').trim()).filter(Boolean);
  const own = ONLY_FILES.test(body) ? '' : body;
  if (!names) return own;
  const line = `Bifogat: ${files.map((f) => basename(f)).join(', ')}`;
  return own ? `${own}\n\n${line}` : line;
}
