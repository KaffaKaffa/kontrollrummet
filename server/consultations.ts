import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.ts';
import { bus } from './bus.ts';

/**
 * One question to a consultant, as it happens: who asked, what, how the
 * consultant reasoned and searched, its sources, and the answer. Shown in the
 * consultant's panel, live while it works. Kept for the latest ones only.
 */
export interface Consultation {
  id: string;
  team: string;
  consultant: string;
  subtaskId: number | null;
  /** The role that asked. */
  asker: string;
  question: string;
  status: 'running' | 'done' | 'failed';
  /** The consultant's reasoning, as far as the service shows it (OpenAI: a summary of it). */
  thinking: string;
  /** What it searched the web for. */
  searches: string[];
  sources: { url: string; title?: string }[];
  answer: string;
  error?: string;
  startedAt: string;
  endedAt: string | null;
}

/** What a service says while it works, piece by piece. */
export interface Progress {
  thinking?: string;
  search?: string;
  source?: { url: string; title?: string };
  answer?: string;
}

const FILE = join(DATA_DIR, 'consultations.json');
const KEEP = 200;
/** Live pieces go to the browser at most this often, not per token. */
const PUSH_MS = 400;

function load(): Consultation[] {
  try {
    const list = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as Consultation[]) : [];
    // A restart ends what was running: it never answers now.
    return list.map((c) => (c.status === 'running' ? { ...c, status: 'failed' as const, error: 'Kontrollrummet startades om under frågan.', endedAt: c.endedAt ?? c.startedAt } : c));
  } catch {
    return [];
  }
}

const all = load();
const timers = new Map<string, NodeJS.Timeout>();

const save = () => {
  try {
    writeFileSync(FILE, JSON.stringify(all.slice(-KEEP)));
  } catch {
    // Looking back is nice to have; never in the way of an answer.
  }
};

const push = (c: Consultation) => bus.emit({ type: 'consultation', consultation: c });

/** The latest ones, for the board's first load. */
export const listConsultations = (limit = 100): Consultation[] => all.slice(-limit);

export function startConsultation(fields: Pick<Consultation, 'team' | 'consultant' | 'subtaskId' | 'asker' | 'question'>): Consultation {
  const c: Consultation = { id: randomUUID(), ...fields, status: 'running', thinking: '', searches: [], sources: [], answer: '', startedAt: new Date().toISOString(), endedAt: null };
  all.push(c);
  if (all.length > KEEP * 2) all.splice(0, all.length - KEEP);
  save();
  push(c);
  return c;
}

/** A piece of what the consultant is doing; pushed to the browser a few times a second. */
export function progress(c: Consultation, p: Progress) {
  if (p.thinking) c.thinking += p.thinking;
  if (p.search && !c.searches.includes(p.search)) c.searches.push(p.search);
  if (p.source && !c.sources.some((s) => s.url === p.source!.url)) c.sources.push(p.source);
  if (p.answer) c.answer += p.answer;
  if (timers.has(c.id)) return;
  timers.set(
    c.id,
    setTimeout(() => {
      timers.delete(c.id);
      push(c);
    }, PUSH_MS),
  );
}

export function finishConsultation(c: Consultation, result: { answer?: string; error?: string }) {
  clearTimeout(timers.get(c.id));
  timers.delete(c.id);
  c.status = result.error ? 'failed' : 'done';
  if (result.answer != null) c.answer = result.answer;
  if (result.error) c.error = result.error;
  c.endedAt = new Date().toISOString();
  save();
  push(c);
}
