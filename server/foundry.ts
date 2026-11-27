import { CLAUDE_BIN } from './config.ts';
import { readSecret } from './secrets.ts';
import { accountEnv, forgetEntra, foundryKeyService, getAccount, identityTerminal, isFoundry, tierDeployments, TIERS, type Tier } from './accounts.ts';
import { execFile } from './proc.ts';
import { openTerminal } from './terminal.ts';

/** The Terminal that gets a Foundry account in: paste the API key, or az login. */
export function foundryLogin(id: string): string {
  const a = getAccount(id);
  if (a.id !== id || !isFoundry(a)) throw new Error('Foundry-kontot finns inte');
  const f = a.foundry!;
  forgetEntra(id);
  if (f.auth === 'key') {
    openTerminal({
      ...identityTerminal(id, 'spara Foundry-nyckeln'),
      secret: { service: foundryKeyService(id), prompt: 'Klistra in API-nyckeln från Foundry (den syns inte när du klistrar) och tryck Enter:' },
    });
    return 'Klistra in nyckeln i Terminal-fönstret.';
  }
  openTerminal({ ...identityTerminal(id, 'logga in i Azure'), steps: [['az', 'login', ...(f.tenant ? ['--tenant', f.tenant] : [])]] });
  return 'Logga in i Terminal-fönstret och testa anslutningen igen.';
}

export interface TierResult {
  tier: Tier;
  deployment: string;
  /** False when the tier has no deployment of its own and runs another one. */
  own: boolean;
  ok: boolean;
  ms: number;
  /** What went wrong, in words the owner can act on; or the model that answered. */
  message: string;
}

/** Turns what claude printed into one cause the owner can act on. */
export function classifyFoundryError(text: string, deployment: string): string {
  const t = text.toLowerCase();
  if (/enotfound|getaddrinfo|econnrefused|fetch failed|unable to connect|could not resolve|connection error|eai_again/.test(t))
    return 'Resursen finns inte (adressen gick inte att nå). Kontrollera resursnamnet eller adressen.';
  if (/chainedtokencredential|azureadtokenprovider|defaultazurecredential|az login|no credential|authentication failed.*azure/.test(t))
    return 'Inte inloggad i Azure. Använd "Logga in i Azure" på kontot.';
  if (/\b401\b|unauthorized|invalid api key|invalid x-api-key|incorrect api key|access denied due to invalid subscription key/.test(t))
    return 'Nyckeln stämmer inte (401). Ange nyckeln igen med "Ange nyckel".';
  if (/\b403\b|permissiondenied|forbidden|does not have permission/.test(t))
    return 'Saknar behörighet (403). Identiteten behöver rollen Foundry User (eller Cognitive Services User) på resursen.';
  if (/deploymentnotfound|\b404\b|not found|model_not_found|does not exist/.test(t)) return `Deploymenten ${deployment} finns inte på resursen (404). Kontrollera namnet.`;
  if (/\b429\b|rate limit|too many requests/.test(t)) return 'Tokengränsen nåddes (429). Höj kvoten för deploymenten i Azure eller försök igen strax.';
  return `Oväntat fel: ${text.trim().split('\n').find(Boolean)?.slice(0, 200) ?? 'inget svar'}`;
}

/**
 * One quick HTTP call before claude is started: claude retries DNS and 401 errors
 * silently until its timeout. Returns an error message, or null when the call got through
 * (or could not be judged here).
 */
async function preflight(id: string, deployment: string): Promise<string | null> {
  const a = getAccount(id);
  const f = a.foundry!;
  if (f.auth !== 'key') return null;
  const env = accountEnv(id);
  const base = (env.ANTHROPIC_FOUNDRY_BASE_URL || (env.ANTHROPIC_FOUNDRY_RESOURCE ? `https://${env.ANTHROPIC_FOUNDRY_RESOURCE}.services.ai.azure.com/anthropic` : '')).replace(/\/+$/, '');
  const key = env.ANTHROPIC_FOUNDRY_API_KEY;
  if (!base || !key) return null;
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: deployment, max_tokens: 1, messages: [{ role: 'user', content: 'OK?' }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 429) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      // A 404 from the gateway itself means the path is wrong; only trust it when it names the deployment.
      return classifyFoundryError(`${res.status} ${body}`, deployment);
    }
    return null;
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const text = `${cause?.code ?? ''} ${cause?.message ?? ''} ${(e as Error).message}`;
    if ((e as Error).name === 'TimeoutError') return 'Inget svar på 10 sekunder. Resursen svarar inte.';
    return classifyFoundryError(text, deployment);
  }
}

async function probe(id: string, tier: Tier, deployment: string, own: boolean): Promise<TierResult> {
  const started = Date.now();
  const early = await preflight(id, deployment);
  if (early) return { tier, deployment, own, ok: false, ms: Date.now() - started, message: early };
  return new Promise((resolve) => {
    const done = (ok: boolean, message: string) => resolve({ tier, deployment, own, ok, ms: Date.now() - started, message });
    // The cheapest question there is: no tools, no MCP servers, a one-line system prompt.
    execFile(
      CLAUDE_BIN,
      ['-p', 'OK?', '--model', tier, '--output-format', 'json', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--system-prompt', 'Svara med OK.', '--no-session-persistence'],
      { env: { ...accountEnv(id), CLAUDE_CODE_MAX_RETRIES: '0', ANTHROPIC_MAX_RETRIES: '0' }, timeout: 30_000, maxBuffer: 4_000_000 },
      (err, stdout, stderr) => {
        const out = String(stdout);
        let parsed: { is_error?: boolean; result?: string; modelUsage?: Record<string, unknown> } | null = null;
        try {
          parsed = JSON.parse(out);
        } catch {
          // Not JSON: the error text is in stderr.
        }
        if (!err && parsed && !parsed.is_error) return done(true, `Svarade (${Object.keys(parsed.modelUsage ?? {})[0] ?? deployment})`);
        if (err && (err as { killed?: boolean }).killed) return done(false, 'Inget svar på 30 sekunder. Resursen svarar inte.');
        done(false, classifyFoundryError(`${parsed?.result ?? ''}\n${String(stderr)}\n${out}`, deployment));
      },
    );
  });
}

/** One short question per tier with a deployment. Costs a few tokens each; nothing is saved. */
export async function testFoundry(id: string): Promise<TierResult[]> {
  const a = getAccount(id);
  if (a.id !== id || !isFoundry(a)) throw new Error('Foundry-kontot finns inte');
  const f = a.foundry!;
  const eff = tierDeployments(f);
  if (f.auth === 'key' && !readSecret(foundryKeyService(id)))
    return TIERS.map((t) => ({ tier: t, deployment: eff[t], own: Boolean(f.deployments[t]), ok: false, ms: 0, message: 'Ingen nyckel sparad. Använd "Ange nyckel" på kontot.' }));
  return Promise.all(TIERS.map((t) => probe(id, t, eff[t], Boolean(f.deployments[t]))));
}
