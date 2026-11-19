import { accountEnv } from './accounts.ts';

/**
 * What every `claude -p` process the control room starts has in common,
 * cards and Gudfadern's conversations alike: the release block list, the
 * account's environment and the settings that keep the conversation small.
 */

/**
 * Releases go out through the Releases panel's buttons and nowhere else, so no
 * agent can ship on its own, whatever it is asked.
 */
export const NEVER = [
  // npm run, npm --prefix … run, npm run-script: any spelling of the release scripts.
  'Bash(*release:*)',
  'Bash(*upload:android*)',
  'Bash(*release-ios.sh*)',
  'Bash(*release-android.sh*)',
  'Bash(*upload-play.mjs*)',
  'Bash(*release.sh*)',
  'Bash(*release.ps1*)',
  'Bash(*altool*)',
  // Web and backend deploy from GitHub, never from here.
  'Bash(*deploy.sh*)',
  'Bash(gh workflow run*)',
  'Bash(gh api *dispatches*)',
  'Bash(az deployment*)',
  'Bash(az containerapp update*)',
  'Bash(az acr build*)',
  'Bash(az pipelines run*)',
  // People merge, not agents.
  'Bash(gh pr merge*)',
  'Bash(az repos pr update*completed*)',
];

/**
 * The window Claude summarises the conversation in. Sonnet and Opus get a
 * million tokens by default, so a card never compacts and every step re-reads
 * all of it; a designer card grew to 220k and used a third of a five-hour
 * window in an hour. Compaction starts about 33k before the window is full.
 */
export const CONTEXT_WINDOW = 140_000;

/**
 * A process for this account: its login and gh, the compaction window, and
 * tool output cut short, since whatever a tool prints is read on every later step.
 */
export function claudeEnv(account: string, context: number, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...accountEnv(account),
    ...extra,
    // An approval can wait for the owner for half an hour; the tool call must outlive that.
    MCP_TOOL_TIMEOUT: String(35 * 60 * 1000),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(context || CONTEXT_WINDOW),
    BASH_MAX_OUTPUT_LENGTH: '15000',
    MAX_MCP_OUTPUT_TOKENS: '10000',
  };
}

/** One line per tool call: enough to follow along, not the whole input. */
export function describeTool(name: string, input: Record<string, unknown>): string {
  const pick = input.command ?? input.file_path ?? input.pattern ?? input.skill ?? input.url ?? input.description;
  return pick ? `${name}: ${String(pick).slice(0, 300)}` : name;
}

export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : '')).join('\n');
  return '';
}

/** Tokens read on a call: how big the conversation is. */
export function contextOf(usage: Record<string, number> | undefined): number | null {
  if (!usage) return null;
  return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

/** A user turn on stream-json stdin. */
export const userLine = (text: string) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
