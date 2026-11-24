import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { NEVER } from './claude-run.ts';

/**
 * What the owner has allowed a card after Claude Code said no on its own: a
 * hard rule (NEVER) or auto mode's classifier. Neither asks the permission
 * prompt tool, so without this the agent just stops with "denied" and the
 * owner has no button to say yes. A grant lives on the card and applies from
 * its next turn: the command is allowed outright, and a NEVER rule it hit is
 * left out for that card.
 */
export interface Grant {
  tool: string;
  /** The Bash command, or the tool input as JSON for other tools. */
  what: string;
  /** The NEVER rules this grant lifts for the card. */
  lifts: string[];
  at: string;
}

const FILE = join(DATA_DIR, 'grants.json');

function load(): Record<string, Grant[]> {
  try {
    return existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, Grant[]>) : {};
  } catch {
    return {};
  }
}

const grants = load();

export const grantsFor = (subtaskId: number): Grant[] => grants[subtaskId] ?? [];

export function addGrant(subtaskId: number, tool: string, what: string): Grant {
  const grant: Grant = { tool, what, lifts: tool === 'Bash' ? neverRulesHit(what) : [], at: new Date().toISOString() };
  grants[subtaskId] = [...grantsFor(subtaskId).filter((g) => !(g.tool === grant.tool && g.what === grant.what)), grant];
  writeFileSync(FILE, JSON.stringify(grants, null, 2));
  return grant;
}

/** The NEVER rules a card still has: all of them minus what the owner lifted. */
export function neverFor(subtaskId: number): string[] {
  const lifted = new Set(grantsFor(subtaskId).flatMap((g) => g.lifts));
  return NEVER.filter((r) => !lifted.has(r));
}

/** Allow rules for the card's granted commands, for --allowedTools. */
export function allowedFor(subtaskId: number): string[] {
  return grantsFor(subtaskId).map((g) => (g.tool === 'Bash' ? `Bash(${g.what})` : g.tool));
}

/** The NEVER rules a command hits, matched per part like Claude Code does (a && b; c | d). */
export function neverRulesHit(command: string): string[] {
  const parts = command
    .split(/&&|\|\||;|\||\n/)
    .map((p) => p.trim().replace(/^(?:\w+=\S*\s+)+/, ''))
    .filter(Boolean);
  return NEVER.filter((rule) => {
    const glob = /^Bash\((.*)\)$/.exec(rule)?.[1];
    if (!glob) return false;
    const re = new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
    return parts.some((p) => re.test(p));
  });
}
