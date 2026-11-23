import type { Progress } from './consultations.ts';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, HOST, PORT, TEAMS_DIR } from './config.ts';
import { generateImage, IMAGE_MODEL, IMAGES_DIR, type GeneratedImage } from './images.ts';
import { getTeam, type Team } from './roles.ts';
import { readSecret } from './secrets.ts';
import { slug } from './worktree.ts';

/**
 * Consultants: specialists the agents ask over an API instead of colleagues in
 * the office. A lawyer on a model that is good at law, an illustrator that
 * draws. Each has a face, a name, what it does and its own instructions; it
 * answers one question at a time, and the agent that asked carries on with
 * the answer (writes the policy into the repo, puts the picture in place).
 *
 * teams/<id>/consultants/<id>.md: front matter, then the instructions.
 * library/consultants/<id>.md: the templates.
 */

/**
 * Models and services outside Claude: the point of a consultant is another
 * model's strengths. Some are asked over their API by the control room; the
 * rest through an MCP server the asking agent is given.
 */
export type ApiProvider = 'openai' | 'gemini' | 'grok' | 'perplexity';
export type Provider = ApiProvider | 'runway' | 'elevenlabs' | 'suno' | 'meshy' | 'kling' | 'tripo' | 'rodin' | 'flux' | 'deepl' | 'stability';

export interface Service {
  id: Provider;
  label: string;
  /** api: the control room calls it with a key; mcp: through an MCP server the agent is given. */
  via: 'api' | 'mcp';
  /** What it is good at, for the picker. */
  note: string;
  kinds: ConsultantKind[];
}

export const SERVICES: Service[] = [
  { id: 'openai', label: 'OpenAI', via: 'api', note: 'GPT och GPT Image', kinds: ['text', 'image'] },
  { id: 'gemini', label: 'Google Gemini', via: 'api', note: 'Gemini och Nano Banana', kinds: ['text', 'image'] },
  { id: 'grok', label: 'xAI Grok', via: 'api', note: 'Grok och Grok Imagine', kinds: ['text', 'image'] },
  { id: 'perplexity', label: 'Perplexity', via: 'api', note: 'Sonar: svar med webbkällor', kinds: ['text'] },
  { id: 'runway', label: 'Runway', via: 'mcp', note: 'Video och bilder', kinds: ['image', 'text'] },
  { id: 'elevenlabs', label: 'ElevenLabs', via: 'mcp', note: 'Röst, musik och ljudeffekter', kinds: ['text', 'image'] },
  { id: 'suno', label: 'Suno', via: 'mcp', note: 'Musik med sång', kinds: ['text', 'image'] },
  { id: 'meshy', label: 'Meshy', via: 'mcp', note: '3D-modeller', kinds: ['image', 'text'] },
  { id: 'kling', label: 'Kling', via: 'mcp', note: 'Video', kinds: ['image', 'text'] },
  { id: 'tripo', label: 'Tripo', via: 'mcp', note: '3D-modeller', kinds: ['image', 'text'] },
  { id: 'rodin', label: 'Rodin', via: 'mcp', note: 'Detaljerade 3D-modeller', kinds: ['image', 'text'] },
  { id: 'flux', label: 'FLUX', via: 'mcp', note: 'Bilder', kinds: ['image'] },
  { id: 'deepl', label: 'DeepL', via: 'mcp', note: 'Översättning', kinds: ['text'] },
  { id: 'stability', label: 'Stability', via: 'mcp', note: 'Bilder och ljud', kinds: ['image', 'text'] },
];
export const serviceOf = (id: string) => SERVICES.find((s) => s.id === id);
const isApi = (p: Provider): p is ApiProvider => serviceOf(p)?.via === 'api';
export type ConsultantKind = 'text' | 'image';
/** When the owner is asked before an agent consults: every time, once per card, or never. */
export type Consent = 'always' | 'session' | 'never';
export const CONSENTS: Consent[] = ['always', 'session', 'never'];

export interface Consultant {
  id: string;
  /** What it is, e.g. "Jurist". */
  name: string;
  /** What it is called, e.g. "Lagman"; empty: it goes by its role. */
  nick: string;
  /** One line on what to ask it. */
  title: string;
  kind: ConsultantKind;
  provider: Provider;
  model: string;
  /** For a service reached through MCP: the MCP server (its id) the asking agents are given. */
  mcp: string;
  /** May look things up on the web while answering (text only). */
  web: boolean;
  /** Appearance, for the portrait. */
  look: string;
  vibe: string;
  /** Who may ask it: 'all', or the team's role ids. */
  askers: 'all' | string[];
  consent: Consent;
  /** Services and models that are good at this, as tips: service id, model, why. */
  tips: Tip[];
  instructions: string;
}

export interface Tip {
  service: string;
  model: string;
  why: string;
}

const parseTips = (raw: string | undefined): Tip[] =>
  (raw ?? '')
    .split(';')
    .map((t) => t.split('|').map((x) => x.trim()))
    .filter(([service, model]) => service && model)
    .map(([service, model, why]) => ({ service, model, why: why ?? '' }));

const LIBRARY = join(import.meta.dirname, '..', 'library', 'consultants');
const PORTRAITS = join(import.meta.dirname, '..', 'web', 'public', 'avatars');
export const PROVIDERS: Provider[] = SERVICES.map((s) => s.id);
export const API_PROVIDERS: ApiProvider[] = ['openai', 'gemini', 'grok', 'perplexity'];
export const PROVIDER_LABEL = Object.fromEntries(SERVICES.map((s) => [s.id, s.label])) as Record<Provider, string>;
/** Where a key is made, opened in the browser when the owner adds one. */
export const KEY_PAGE: Record<ApiProvider, string> = {
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/apikey',
  grok: 'https://console.x.ai',
  perplexity: 'https://www.perplexity.ai/account/api/keys',
};
/** Where each provider's key lives: an environment variable, else the keychain (macOS) or DPAPI (Windows). */
export const KEY_SERVICE: Record<ApiProvider, { env: string; service: string }> = {
  openai: { env: 'OPENAI_API_KEY', service: 'control-room-openai' },
  gemini: { env: 'GEMINI_API_KEY', service: 'control-room-gemini' },
  grok: { env: 'XAI_API_KEY', service: 'control-room-grok' },
  perplexity: { env: 'PERPLEXITY_API_KEY', service: 'control-room-perplexity' },
};

function keyOf(provider: ApiProvider): string | null {
  const k = KEY_SERVICE[provider];
  return process.env[k.env] || readSecret(k.service);
}

/** Which API providers can be asked on this machine: those with a key. */
export function providerStatus(): Record<ApiProvider, boolean> {
  return Object.fromEntries(API_PROVIDERS.map((p) => [p, Boolean(keyOf(p))])) as Record<ApiProvider, boolean>;
}

// ---------------------------------------------------------------- files

const dirOf = (teamId: string) => join(TEAMS_DIR, teamId, 'consultants');

function parse(id: string, source: string): Consultant {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source.replace(/\r\n/g, '\n'));
  const meta = new Map<string, string>();
  for (const line of (match?.[1] ?? '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const provider = meta.get('provider') as Provider;
  return {
    id,
    name: meta.get('name') ?? id,
    nick: meta.get('nick') ?? '',
    title: meta.get('title') ?? '',
    kind: meta.get('kind') === 'image' ? 'image' : 'text',
    provider: PROVIDERS.includes(provider) ? provider : 'openai',
    mcp: meta.get('mcp') ?? '',
    model: meta.get('model') ?? '',
    web: meta.get('web') === 'true',
    look: meta.get('look') ?? '',
    vibe: meta.get('vibe') ?? '',
    askers: !meta.get('askers') || meta.get('askers') === 'all' ? 'all' : meta.get('askers')!.split(',').map((x) => x.trim()).filter(Boolean),
    consent: CONSENTS.includes(meta.get('consent') as Consent) ? (meta.get('consent') as Consent) : 'session',
    tips: parseTips(meta.get('tips')),
    instructions: (match?.[2] ?? source).trim(),
  };
}

function serialize(c: Consultant): string {
  const one = (s: string) => s.replace(/\s+/g, ' ').trim();
  const lines = [
    `name: ${one(c.name)}`,
    c.nick ? `nick: ${one(c.nick)}` : '',
    `title: ${one(c.title)}`,
    `kind: ${c.kind}`,
    `provider: ${c.provider}`,
    c.model ? `model: ${one(c.model)}` : '',
    c.mcp ? `mcp: ${one(c.mcp)}` : '',
    c.web ? 'web: true' : '',
    c.look ? `look: ${one(c.look)}` : '',
    c.vibe ? `vibe: ${one(c.vibe)}` : '',
    `askers: ${c.askers === 'all' ? 'all' : c.askers.join(', ')}`,
    `consent: ${c.consent}`,
    c.tips.length ? `tips: ${c.tips.map((t) => [t.service, t.model, t.why].map((x) => one(x).replace(/[|;]/g, ',')).join('|')).join('; ')}` : '',
  ].filter(Boolean);
  return `---\n${lines.join('\n')}\n---\n${c.instructions.trim()}\n`;
}

export function loadConsultants(teamId: string): Consultant[] {
  const dir = dirOf(teamId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => parse(f.slice(0, -3), readFileSync(join(dir, f), 'utf8')));
}

export function consultantTemplates(): Consultant[] {
  if (!existsSync(LIBRARY)) return [];
  return readdirSync(LIBRARY)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => parse(f.slice(0, -3), readFileSync(join(LIBRARY, f), 'utf8')));
}

/** A consultant named by a tool: its id, its name or its role, in any case. */
export function findConsultant(teamId: string, ref: string): Consultant | undefined {
  const want = ref.trim().toLowerCase();
  const all = loadConsultants(teamId);
  return all.find((c) => c.id === want) ?? all.find((c) => c.nick.toLowerCase() === want) ?? all.find((c) => c.name.toLowerCase() === want);
}

export const consultantWho = (c: Pick<Consultant, 'name' | 'nick'>) => (c.nick ? `${c.nick} (${c.name})` : c.name);

const clean = (s: unknown, max: number) => String(s ?? '').trim().slice(0, max);

export function saveConsultant(teamId: string, id: string, input: Partial<Consultant>): Consultant {
  if (!getTeam(teamId)) throw new Error('teamet finns inte');
  if (!/^[\w-]+$/.test(id)) throw new Error('ogiltigt id');
  const file = join(dirOf(teamId), `${id}.md`);
  if (!existsSync(file)) throw new Error('konsulten finns inte');
  const before = parse(id, readFileSync(file, 'utf8'));
  const next: Consultant = {
    ...before,
    ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
    id,
  };
  next.name = clean(next.name, 40) || before.name;
  next.nick = clean(next.nick, 30).replace(/[,:()]/g, '');
  next.title = clean(next.title, 160);
  next.kind = next.kind === 'image' ? 'image' : 'text';
  next.provider = PROVIDERS.includes(next.provider) ? next.provider : 'openai';
  next.mcp = isApi(next.provider) ? '' : clean(next.mcp, 80).replace(/[^\w.@-]/g, '');
  next.model = clean(next.model, 80);
  next.web = next.web === true && next.kind === 'text';
  next.look = clean(next.look, 400);
  next.vibe = clean(next.vibe, 200);
  next.askers = Array.isArray(next.askers) ? next.askers.map(String).filter((x) => /^[\w-]+$/.test(x)) : 'all';
  next.consent = CONSENTS.includes(next.consent) ? next.consent : 'session';
  next.tips = before.tips;
  next.instructions = String(next.instructions ?? '').slice(0, 20000);
  writeFileSync(file, serialize(next));
  return next;
}

export async function addConsultant(teamId: string, templateId: string | null): Promise<Consultant> {
  if (!getTeam(teamId)) throw new Error('teamet finns inte');
  const template = templateId ? consultantTemplates().find((t) => t.id === templateId) : undefined;
  if (templateId && !template) throw new Error(`mallen ${templateId} finns inte`);
  const base: Consultant = template ?? {
    id: 'konsult',
    name: 'Konsult',
    nick: '',
    title: '',
    kind: 'text',
    provider: 'openai',
    model: '',
    mcp: '',
    web: false,
    look: '',
    vibe: '',
    askers: 'all',
    consent: 'session',
    tips: [],
    instructions: 'Du är en konsult åt ett utvecklingsteam. Beskriv här vad du är expert på och hur du svarar.',
  };
  const dir = dirOf(teamId);
  mkdirSync(dir, { recursive: true });
  let id = base.id;
  for (let n = 2; existsSync(join(dir, `${id}.md`)); n++) id = `${base.id}-${n}`;
  const model = base.model || (isApi(base.provider) ? await defaultModel(base.provider, base.kind).catch(() => '') : '');
  const made = { ...base, id, model };
  writeFileSync(join(dir, `${id}.md`), serialize(made));
  // The template's face, until one of its own is drawn.
  const face = join(import.meta.dirname, '..', 'library', 'avatars', `consultant-${base.id}.png`);
  if (template && existsSync(face)) {
    mkdirSync(PORTRAITS, { recursive: true });
    writeFileSync(portraitFile(teamId, id), readFileSync(face));
  }
  return made;
}

export function removeConsultant(teamId: string, id: string) {
  if (!/^[\w-]+$/.test(id)) throw new Error('ogiltigt id');
  const file = join(dirOf(teamId), `${id}.md`);
  if (!existsSync(file)) throw new Error('konsulten finns inte');
  const removed = join(dirOf(teamId), '.removed');
  mkdirSync(removed, { recursive: true });
  renameSync(file, join(removed, `${id}-${Date.now()}.md`));
}

// ---------------------------------------------------------------- portraits

export const portraitFile = (teamId: string, id: string) => join(PORTRAITS, `${teamId}--consultant-${id}.png`);

const PORTRAIT =
  'Playful, warm 3D clay figurine portrait, chest up, centered, facing the viewer with a friendly expression. ' +
  'Affectionate office-sitcom character. Soft studio light, rounded shapes, saturated but tasteful colours. ' +
  'Plain soft pastel background in one flat colour. No text, no logos, no brand marks.';

/** A face for the consultant from its look, with OpenAI's image API, in the same clay style as the agents. */
export async function drawPortrait(teamId: string, id: string): Promise<string> {
  const c = loadConsultants(teamId).find((x) => x.id === id);
  if (!c) throw new Error('konsulten finns inte');
  if (!c.look) throw new Error('skriv först hur konsulten ser ut');
  const key = keyOf('openai');
  if (!key) throw new Error('ingen OpenAI-nyckel (control-room-openai i nyckelringen)');
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: IMAGE_MODEL, prompt: `${PORTRAIT}\n\nThe character: ${c.look}${c.vibe ? ` Personality: ${c.vibe}` : ''}`, size: '1024x1024', n: 1 }),
  });
  const data = (await res.json()) as { data?: { b64_json?: string }[]; error?: { message?: string } };
  const b64 = data.data?.[0]?.b64_json;
  if (!res.ok || !b64) throw new Error(`OpenAI: ${data.error?.message ?? `HTTP ${res.status}`}`);
  mkdirSync(PORTRAITS, { recursive: true });
  writeFileSync(portraitFile(teamId, id), Buffer.from(b64, 'base64'));
  // A big PNG is slow in the office; the agents' portraits are 384 px.
  await new Promise<void>((resolve) => {
    const p = spawn('sips', ['-Z', '384', portraitFile(teamId, id)], { stdio: 'ignore' });
    p.on('close', () => resolve());
    p.on('error', () => resolve());
  });
  return `/avatars/${teamId}--consultant-${id}.png?v=${Date.now()}`;
}

/** One of the library's faces (the wardrobe's portraits) instead of a drawn one. */
export function pickPortrait(teamId: string, id: string, from: string) {
  if (!/^[\w-]+$/.test(from)) throw new Error('ogiltigt porträtt');
  const source = join(import.meta.dirname, '..', 'library', 'avatars', `${from}.png`);
  if (!existsSync(source)) throw new Error('porträttet finns inte');
  mkdirSync(PORTRAITS, { recursive: true });
  writeFileSync(portraitFile(teamId, id), readFileSync(source));
}

export const libraryFaces = () =>
  existsSync(join(import.meta.dirname, '..', 'library', 'avatars'))
    ? readdirSync(join(import.meta.dirname, '..', 'library', 'avatars'))
        .filter((f) => f.endsWith('.png'))
        .map((f) => f.slice(0, -4))
        .sort()
    : [];

// ---------------------------------------------------------------- models

const version = (id: string) => Number(/(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
const newest = (ids: string[]) => [...ids].sort((a, b) => version(b) - version(a) || a.length - b.length)[0];

/** The provider's models, from its own API, so the list is never out of date. */
export async function listModels(provider: Provider): Promise<string[]> {
  if (!isApi(provider)) return [];
  const key = keyOf(provider);
  if (!key) throw new Error(`ingen nyckel för ${PROVIDER_LABEL[provider]}`);
  // Perplexity has no model list to ask; its Sonar models.
  if (provider === 'perplexity') return ['sonar', 'sonar-pro', 'sonar-reasoning-pro', 'sonar-deep-research'];
  if (provider === 'grok') {
    const res = await fetch('https://api.x.ai/v1/models', { headers: { authorization: `Bearer ${key}` } });
    const data = (await res.json()) as { data?: { id: string }[]; error?: string | { message?: string } };
    if (!res.ok) throw new Error(`xAI: ${typeof data.error === 'string' ? data.error : (data.error?.message ?? res.status)}`);
    return (data.data ?? []).map((m) => m.id).sort();
  }
  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` } });
    const data = (await res.json()) as { data?: { id: string }[]; error?: { message?: string } };
    if (!res.ok) throw new Error(`OpenAI: ${data.error?.message ?? res.status}`);
    return (data.data ?? []).map((m) => m.id).filter((id) => /^(gpt|o\d|chatgpt)/.test(id)).sort();
  }
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
  const data = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(`Gemini: ${data.error?.message ?? res.status}`);
  return (data.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .sort();
}

/** A sensible model for a new consultant: the newest flagship of its kind. */
export async function defaultModel(provider: Provider, kind: ConsultantKind): Promise<string> {
  const ids = await listModels(provider);
  if (provider === 'perplexity') return 'sonar-pro';
  if (provider === 'grok') return kind === 'image' ? (newest(ids.filter((id) => /imag/.test(id))) ?? '') : (newest(ids.filter((id) => /^grok-\d/.test(id) && !/imag|vision|mini|fast/.test(id))) ?? newest(ids.filter((id) => /^grok/.test(id))) ?? '');
  if (provider === 'openai') {
    if (kind === 'image') return newest(ids.filter((id) => /^gpt-image-[\d.]+$/.test(id))) ?? IMAGE_MODEL;
    return newest(ids.filter((id) => /^gpt-\d+(\.\d+)?$/.test(id))) ?? newest(ids.filter((id) => /^gpt-/.test(id))) ?? '';
  }
  if (kind === 'image') return newest(ids.filter((id) => /image/.test(id) && !/preview/.test(id))) ?? newest(ids.filter((id) => /image/.test(id))) ?? '';
  return newest(ids.filter((id) => /^gemini-[\d.]+-pro$/.test(id))) ?? newest(ids.filter((id) => /^gemini-[\d.]+-pro/.test(id))) ?? '';
}

// ---------------------------------------------------------------- asking

export interface Answer {
  text: string;
  images: GeneratedImage[];
}

const LOG = join(DATA_DIR, 'consultants.log');

/** Models that reason before they answer, and can show a summary of it. */
const REASONS = /^(o\d|gpt-([5-9]|\d{2}))/i;

/**
 * OpenAI's Responses API, streamed: the reasoning summary, the web searches and
 * the answer arrive piece by piece and go to the consultant's panel as they come.
 */
async function askOpenAi(c: Consultant, question: string, onProgress?: (p: Progress) => void): Promise<string> {
  const key = keyOf('openai');
  if (!key) throw new Error('ingen OpenAI-nyckel');
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: c.model,
      instructions: c.instructions,
      input: question,
      stream: true,
      ...(REASONS.test(c.model) ? { reasoning: { summary: 'auto' } } : {}),
      ...(c.web ? { tools: [{ type: 'web_search' }] } : {}),
    }),
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`OpenAI: ${data.error?.message ?? res.status}`);
  }
  let answer = '';
  let summaries = 0;
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut: number;
    // Server-sent events: blocks split by a blank line, the JSON on the data: line.
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const line = block.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let e: Record<string, any>;
      try {
        e = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      switch (e.type) {
        case 'response.reasoning_summary_part.added':
          if (summaries++ > 0) onProgress?.({ thinking: '\n\n' });
          break;
        case 'response.reasoning_summary_text.delta':
          onProgress?.({ thinking: String(e.delta ?? '') });
          break;
        case 'response.output_item.done':
          if (e.item?.type === 'web_search_call') {
            const q = e.item.action?.query ?? e.item.action?.queries?.[0];
            if (q) onProgress?.({ search: String(q) });
          }
          break;
        case 'response.output_text.annotation.added':
          if (e.annotation?.type === 'url_citation' && e.annotation.url) onProgress?.({ source: { url: String(e.annotation.url), title: e.annotation.title } });
          break;
        case 'response.output_text.delta':
          answer += String(e.delta ?? '');
          onProgress?.({ answer: String(e.delta ?? '') });
          break;
        case 'response.failed':
        case 'error':
          throw new Error(`OpenAI: ${e.response?.error?.message ?? e.message ?? 'fel under svaret'}`);
      }
    }
  }
  return answer.trim();
}

/** xAI and Perplexity speak OpenAI's chat completions. */
async function askChat(c: Consultant, question: string, url: string, key: string, label: string, onProgress?: (p: Progress) => void): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: c.model, messages: [{ role: 'system', content: c.instructions }, { role: 'user', content: question }] }),
  });
  const data = (await res.json()) as {
    choices?: { message?: { content?: string; reasoning_content?: string } }[];
    citations?: string[];
    search_results?: { url: string; title?: string }[];
    error?: string | { message?: string };
  };
  if (!res.ok) throw new Error(`${label}: ${typeof data.error === 'string' ? data.error : (data.error?.message ?? res.status)}`);
  const message = data.choices?.[0]?.message;
  // Reasoning models put their thinking beside the answer (xAI) or in <think> first (Perplexity).
  let text = (message?.content ?? '').trim();
  const think = /^<think>([\s\S]*?)<\/think>\s*/.exec(text);
  if (think) text = text.slice(think[0].length).trim();
  const thinking = (message?.reasoning_content ?? think?.[1] ?? '').trim();
  if (thinking) onProgress?.({ thinking });
  for (const r of data.search_results ?? []) onProgress?.({ source: { url: r.url, title: r.title } });
  if (!data.search_results?.length) for (const url of data.citations ?? []) onProgress?.({ source: { url } });
  return data.citations?.length ? `${text}\n\nKällor:\n${data.citations.map((u) => `- ${u}`).join('\n')}` : text;
}

async function grokImage(c: Consultant, question: string): Promise<Buffer> {
  const key = keyOf('grok');
  if (!key) throw new Error('ingen xAI-nyckel');
  const res = await fetch('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: c.model, prompt: `${c.instructions}\n\n${question}`, n: 1, response_format: 'b64_json' }),
  });
  const data = (await res.json()) as { data?: { b64_json?: string }[]; error?: string | { message?: string } };
  const b64 = data.data?.[0]?.b64_json;
  if (!res.ok || !b64) throw new Error(`xAI: ${typeof data.error === 'string' ? data.error : (data.error?.message ?? res.status)}`);
  return Buffer.from(b64, 'base64');
}

async function askGemini(c: Consultant, question: string, onProgress?: (p: Progress) => void): Promise<{ text: string; images: Buffer[] }> {
  const key = keyOf('gemini');
  if (!key) throw new Error('ingen Gemini-nyckel (control-room-gemini i nyckelringen)');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: c.instructions }] },
      contents: [{ role: 'user', parts: [{ text: question }] }],
      ...(c.web ? { tools: [{ google_search: {} }] } : {}),
      // A thinking model shows a summary of its thoughts, beside the answer.
      ...(c.kind === 'text' && THINKS.test(c.model) ? { generationConfig: { thinkingConfig: { includeThoughts: true } } } : {}),
    }),
  });
  const data = (await res.json()) as {
    candidates?: {
      content?: { parts?: { text?: string; thought?: boolean; inlineData?: { mimeType: string; data: string } }[] };
      groundingMetadata?: { webSearchQueries?: string[]; groundingChunks?: { web?: { uri: string; title?: string } }[] };
    }[];
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`Gemini: ${data.error?.message ?? res.status}`);
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const thoughts = parts.filter((p) => p.thought && p.text).map((p) => p.text!.trim());
  if (thoughts.length) onProgress?.({ thinking: thoughts.join('\n\n') });
  for (const q of candidate?.groundingMetadata?.webSearchQueries ?? []) onProgress?.({ search: q });
  for (const g of candidate?.groundingMetadata?.groundingChunks ?? []) if (g.web?.uri) onProgress?.({ source: { url: g.web.uri, title: g.web.title } });
  return {
    text: parts
      .filter((p) => !p.thought)
      .map((p) => p.text ?? '')
      .join('')
      .trim(),
    images: parts.filter((p) => p.inlineData?.mimeType.startsWith('image/')).map((p) => Buffer.from(p.inlineData!.data, 'base64')),
  };
}

function saveImage(teamId: string, name: string, png: Buffer, saveTo?: string, worktree?: string | null): GeneratedImage {
  const file = `${slug(name)}-${Date.now()}.png`;
  const dir = join(IMAGES_DIR, teamId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, png);
  const image: GeneratedImage = { path, url: `http://${HOST}:${PORT}/images/${teamId}/${file}` };
  if (saveTo && worktree) {
    const target = join(worktree, saveTo);
    if (target.startsWith(`${worktree}/`)) {
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, png);
      image.copiedTo = target;
    }
  }
  return image;
}

/** Gemini models that think first (2.5 and later). */
const THINKS = /gemini-(2\.5|[3-9])/i;

/** Asks the consultant one question and returns its answer: text, and pictures from an image consultant. */
export async function consult(
  teamId: string,
  ref: string,
  question: string,
  opts: { saveTo?: string; worktree?: string | null; size?: '1024x1024' | '1536x1024' | '1024x1536'; onProgress?: (p: Progress) => void } = {},
): Promise<{ consultant: Consultant; answer: Answer }> {
  const team = getTeam(teamId);
  if (!team) throw new Error('teamet finns inte');
  const c = findConsultant(teamId, ref);
  if (!c) throw new Error(`ingen konsult som heter ${ref}`);
  if (!isApi(c.provider)) throw new Error(`${consultantWho(c)} nås via MCP-servern ${c.mcp || '(ingen vald)'}, inte över API`);
  if (!c.model) throw new Error(`${consultantWho(c)} har ingen modell vald (Inställningar → Konsulter)`);
  let answer: Answer;
  if (c.kind === 'image') {
    if (c.provider === 'grok') {
      answer = { text: '', images: [saveImage(teamId, `${c.id}-${question}`, await grokImage(c, question), opts.saveTo, opts.worktree)] };
    } else if (c.provider === 'perplexity') {
      throw new Error('Perplexity gör inga bilder');
    } else if (c.provider === 'gemini') {
      const got = await askGemini(c, question);
      if (!got.images.length) throw new Error(got.text || 'Gemini gav ingen bild');
      answer = { text: got.text, images: got.images.map((png, i) => saveImage(teamId, `${c.id}-${question}`, png, i === 0 ? opts.saveTo : undefined, opts.worktree)) };
    } else {
      const image = await generateImage({
        team: teamId,
        prompt: `${c.instructions}\n\n${question}`,
        name: `${c.id}-${question}`,
        size: opts.size,
        saveTo: opts.saveTo,
        worktree: opts.worktree,
        model: c.model,
      });
      answer = { text: '', images: [image] };
    }
  } else {
    const key = (p: ApiProvider) => {
      const k = keyOf(p);
      if (!k) throw new Error(`ingen nyckel för ${PROVIDER_LABEL[p]} (Inställningar → Konsulter → API-nycklar)`);
      return k;
    };
    const text =
      c.provider === 'gemini'
        ? (await askGemini(c, question, opts.onProgress)).text
        : c.provider === 'grok'
          ? await askChat(c, question, 'https://api.x.ai/v1/chat/completions', key('grok'), 'xAI', opts.onProgress)
          : c.provider === 'perplexity'
            ? await askChat(c, question, 'https://api.perplexity.ai/chat/completions', key('perplexity'), 'Perplexity', opts.onProgress)
            : await askOpenAi(c, question, opts.onProgress);
    if (!text) throw new Error(`${consultantWho(c)} gav inget svar`);
    answer = { text, images: [] };
  }
  try {
    writeFileSync(LOG, `${new Date().toISOString()}\t${teamId}\t${c.id}\t${c.provider}/${c.model}\t${question.slice(0, 200).replace(/\s+/g, ' ')}\n`, { flag: 'a' });
  } catch {
    // The log is for looking back, never in the way.
  }
  return { consultant: c, answer };
}

/** MCP servers of the consultants a role may ask: the role is given them, so it can use them. */
export function consultantServers(teamId: string, roleId: string): string[] {
  return loadConsultants(teamId)
    .filter((c) => c.mcp && !isApi(c.provider) && (c.askers === 'all' || c.askers.includes(roleId)))
    .map((c) => c.mcp);
}

/** For the agents' prompt: who they can ask, and how. */
export function consultantsSection(teamId: string): string {
  const list = loadConsultants(teamId);
  if (!list.length) return '';
  const team = getTeam(teamId);
  const who = (c: Consultant) =>
    c.askers === 'all' ? '' : ` Bara ${c.askers.map((id) => team?.roles.find((r) => r.id === id)).filter(Boolean).map((r) => r!.nick || r!.name).join(', ') || 'ingen'} får fråga; andra ber dem.`;
  const consent = { always: ' Ägaren godkänner varje fråga.', session: ' Ägaren godkänner första frågan på kortet.', never: '' };
  const lines = list.map(
    (c) =>
      `- \`${c.id}\`: ${consultantWho(c)}${c.title ? `, ${c.title}` : ''}. ${isApi(c.provider) ? `${c.kind === 'image' ? 'Gör bilder.' : 'Svarar i text.'} (${PROVIDER_LABEL[c.provider]}${c.model ? ` ${c.model}` : ''}${c.web ? ', söker på webben' : ''})` : `${PROVIDER_LABEL[c.provider]} via MCP-servern \`${c.mcp || '?'}\`: kör \`consult\` först (för instruktionerna och ägarens samtycke), använd sedan serverns verktyg.`}${who(c)}${consent[c.consent]}`,
  );
  return `## Konsulter\n\nSpecialister utanför teamet som du frågar med \`consult\`: en fråga i taget, med allt de behöver veta i frågan (de ser inte repot eller kortet). Du gör sedan jobbet med svaret: skriver in texten i repot, lägger bilden på plats. Skicka aldrig personuppgifter, kunddata eller hemligheter till en konsult.\n\n${lines.join('\n')}`;
}

/** The consultant as the web app shows it. */
export function consultantView(teamId: string, c: Consultant) {
  return { ...c, portrait: existsSync(portraitFile(teamId, c.id)) ? `/avatars/${teamId}--consultant-${c.id}.png` : null };
}
