import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const APP_ROOT = resolve(here, '..');
/** One folder per team: team.json, roles/*.md and an optional shared.md. */
export const TEAMS_DIR = join(APP_ROOT, 'teams');
export const WEB_DIST = join(APP_ROOT, 'web/dist');

/** State lives outside the repo and is never committed. */
export const DATA_DIR = process.env.CONTROL_ROOM_DATA ?? join(homedir(), '.control-room');
export const DB_PATH = join(DATA_DIR, 'state.db');

export const PORT = Number(process.env.CONTROL_ROOM_PORT ?? 4317);
/** Loopback only. Remote access comes through Tailscale later, never the open LAN. */
export const HOST = '127.0.0.1';

/** The default cap per Claude account when none is saved in the app: the teams on one account share its subscription's limits. */
export const MAX_CONCURRENT = Number(process.env.CONTROL_ROOM_MAX_AGENTS ?? 2);

export const CLAUDE_BIN = process.env.CONTROL_ROOM_CLAUDE ?? 'claude';

export const DEV = process.argv.includes('--dev');

export const expandHome = (p: string) => (/^~[\\/]/.test(p) ? join(homedir(), p.slice(2)) : p);
