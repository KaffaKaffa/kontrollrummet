import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';

/**
 * GitHub Copilot as a consultant provider, through GitHub's official SDK
 * (@github/copilot-sdk, which drives the official Copilot CLI over JSON-RPC).
 * The versions are pinned in package.json: the SDK needs a matching CLI, and
 * some RPCs are experimental. Auto-update of the CLI is switched off.
 *
 * A consultant only ever answers a question. Every session is created with no
 * tools and no MCP servers, in an empty temporary directory, so a consultant
 * can never read or write a worktree. The owner's own ~/.copilot is not used:
 * COPILOT_HOME lives under the control room's data.
 */

type Sdk = typeof import('@github/copilot-sdk');
type Client = InstanceType<Sdk['CopilotClient']>;

export const COPILOT_HOME = join(DATA_DIR, 'copilot');
const TMP = join(COPILOT_HOME, 'tmp');
/** Default time to wait for an answer. */
export const TIMEOUT_MS = 180_000;
const IDLE_MS = 10 * 60_000;
const MODELS_TTL_MS = 60 * 60_000;

export interface CopilotModel {
  id: string;
  name: string;
  /** Credits per million tokens, when the model publishes token prices. */
  price?: { input: number; output: number };
}

export interface CopilotAnswer {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** AI credits (1 credit = 0.01 USD). */
  credits: number;
  /** Whether credits come from GitHub's own figure (otherwise tokens × price, or 0 if unknown). */
  creditsExact: boolean;
  ms: number;
}

export interface CopilotQuota {
  plan?: string;
  /** Percent of the month left. */
  remainingPercent?: number;
  resetDate?: string;
  unlimited: boolean;
  used?: number;
  entitlement?: number;
}

// ---------------------------------------------------------------- client

let sdk: Promise<Sdk> | null = null;
let current: { token: string; client: Client; starting: Promise<void>; idle?: NodeJS.Timeout } | null = null;

const loadSdk = () => (sdk ??= import('@github/copilot-sdk'));

function touch() {
  if (!current) return;
  clearTimeout(current.idle);
  const held = current;
  held.idle = setTimeout(() => void close(held), IDLE_MS);
  held.idle.unref();
}

async function close(held: NonNullable<typeof current>) {
  if (current === held) current = null;
  clearTimeout(held.idle);
  try {
    await held.client.stop();
  } catch {
    await held.client.forceStop().catch(() => {});
  }
}

/** Stops the CLI process, e.g. when the token changes or the server shuts down. */
export async function stopCopilot() {
  if (current) await close(current);
}

async function clientFor(token: string): Promise<Client> {
  if (current && current.token !== token) await close(current);
  if (!current) {
    mkdirSync(TMP, { recursive: true });
    const { CopilotClient } = await loadSdk();
    const client = new CopilotClient({
      baseDirectory: COPILOT_HOME,
      gitHubToken: token,
      useLoggedInUser: false,
      logLevel: 'error',
      // Replaces the inherited environment's tokens and keeps the CLI from updating itself.
      env: { ...process.env, COPILOT_HOME, COPILOT_AUTO_UPDATE: 'false', COPILOT_GITHUB_TOKEN: token },
      connection: (await loadSdk()).RuntimeConnection.forStdio({ args: ['--no-auto-update'] }),
    });
    current = { token, client, starting: client.start() };
    current.starting.catch(() => {
      if (current?.client === client) current = null;
    });
  }
  await current.starting;
  touch();
  return current.client;
}

// ---------------------------------------------------------------- models

let modelCache: { token: string; at: number; models: CopilotModel[] } | null = null;

/** Credits per million tokens from a model's per-batch price. */
const perMillion = (price: number | undefined, batch: number | undefined) => (price != null && batch ? (price / batch) * 1_000_000 : undefined);

/** The models this token's licence offers, cached for an hour. */
export async function models(token: string): Promise<CopilotModel[]> {
  if (modelCache && modelCache.token === token && Date.now() - modelCache.at < MODELS_TTL_MS) return modelCache.models;
  const client = await clientFor(token);
  const list = (await client.listModels())
    // Only models the organisation's policy has switched on.
    .filter((m) => !m.policy || m.policy.state === 'enabled')
    .map((m): CopilotModel => {
      const p = m.billing?.tokenPrices;
      const input = perMillion(p?.inputPrice, p?.batchSize);
      const output = perMillion(p?.outputPrice, p?.batchSize);
      return { id: m.id, name: m.name, price: input != null && output != null ? { input, output } : undefined };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  modelCache = { token, at: Date.now(), models: list };
  return list;
}

// ---------------------------------------------------------------- asking

/**
 * One question, one new session: no tools, no MCP servers, an empty working
 * directory that is removed afterwards. Aborts on timeout or when `signal`
 * fires. What was used before an abort still counts, and is returned in the
 * error's `partial`.
 */
export async function ask(opts: {
  token: string;
  model: string;
  system: string;
  question: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CopilotAnswer> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const started = Date.now();
  const list = await models(opts.token).catch(() => [] as CopilotModel[]);
  const price = list.find((m) => m.id === opts.model)?.price;
  const client = await clientFor(opts.token);
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, 'q-'));
  let session: Awaited<ReturnType<Client['createSession']>> | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let nano = 0;
  let exact = false;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    session = await client.createSession({
      model: opts.model,
      workingDirectory: dir,
      // No tools at all, no MCP servers, nothing from the machine's own config.
      availableTools: [],
      mcpServers: {},
      enableConfigDiscovery: false,
      infiniteSessions: { enabled: false },
      systemMessage: { mode: 'replace', content: opts.system },
      // If anything were ever asked for, the answer is no.
      onPermissionRequest: () => ({ kind: 'reject' }),
    });
    session.on((event) => {
      if (event.type !== 'assistant.usage') return;
      const d = event.data;
      inputTokens += d.inputTokens ?? 0;
      outputTokens += d.outputTokens ?? 0;
      if (d.copilotUsage?.totalNanoAiu != null) {
        nano += d.copilotUsage.totalNanoAiu;
        exact = true;
      }
    });
    const live = session;
    const stop = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void live.abort().catch(() => {});
        reject(new CopilotError(`Inget svar inom ${Math.round(timeoutMs / 1000)} s från Copilot`, 'timeout'));
      }, timeoutMs);
      onAbort = () => {
        void live.abort().catch(() => {});
        reject(new CopilotError('Avbruten', 'aborted'));
      };
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
    const reply = await Promise.race([live.sendAndWait({ prompt: opts.question }, timeoutMs + 5_000), stop]);
    const text = (reply?.data.content ?? '').trim();
    return finish(text);
  } catch (err) {
    const e = err instanceof CopilotError ? err : new CopilotError(err instanceof Error ? err.message : String(err), 'failed');
    e.partial = finish('');
    throw e;
  } finally {
    clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
    await session?.disconnect().catch(() => {});
    if (session) await client.deleteSession(session.sessionId).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    touch();
  }

  function finish(text: string): CopilotAnswer {
    const fallback = price ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : 0;
    return {
      text,
      model: opts.model,
      inputTokens,
      outputTokens,
      credits: exact ? nano / 1e9 : fallback,
      creditsExact: exact,
      ms: Date.now() - started,
    };
  }
}

export class CopilotError extends Error {
  partial?: CopilotAnswer;
  reason: 'timeout' | 'aborted' | 'failed';
  constructor(message: string, reason: 'timeout' | 'aborted' | 'failed') {
    super(message);
    this.reason = reason;
  }
}

// ---------------------------------------------------------------- quota

/** What is left of the month on this token's plan. */
export async function quota(token: string): Promise<CopilotQuota> {
  const client = await clientFor(token);
  const result = await client.rpc.account.getQuota({});
  const snapshots = Object.values(result.quotaSnapshots).filter((s) => s !== undefined);
  // Token-based billing reports one snapshot for AI credits; older plans one for premium requests.
  const s = snapshots.find((x) => !x.isUnlimitedEntitlement) ?? snapshots[0];
  return {
    plan: (result as { plan?: string }).plan,
    remainingPercent: s?.remainingPercentage,
    resetDate: s?.resetDate,
    unlimited: Boolean(s?.isUnlimitedEntitlement),
    used: s?.usedRequests,
    entitlement: s?.entitlementRequests,
  };
}
