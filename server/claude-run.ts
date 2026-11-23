import { accountEnv } from './accounts.ts';

/**
 * What every `claude -p` process the control room starts has in common,
 * cards and Gudfadern's conversations alike: the release block list, the
 * account's environment and the settings that keep the conversation small.
 */

/**
 * Rules that block running a script, not touching it. Claude Code matches each
 * part of a command (a && b; c | d) on its own, so these hit `./x/release.sh`,
 * `bash release.sh` and `cd native && node scripts/upload-play.mjs`, but not
 * `sed -n 1,80p release.sh`, `grep` or `git checkout` on the file. A rule that
 * hits a file an agent only reads stops a card with no way for the owner to say yes.
 */
function runs(file: string): string[] {
  const how = ['bash', 'sh', 'zsh', 'node', 'pwsh', 'powershell', 'source', '.', 'exec'];
  return [
    `Bash(${file}*)`,
    `Bash(./*${file}*)`,
    `Bash(/*${file}*)`,
    `Bash(native/*${file}*)`,
    `Bash(scripts/*${file}*)`,
    ...how.map((h) => `Bash(${h} *${file}*)`),
  ];
}

/**
 * Releases go out through the Releases panel's buttons and nowhere else, so no
 * agent can ship on its own, whatever it is asked.
 */
export const NEVER = [
  // npm run, npm --prefix … run, npm run-script: any spelling of the release scripts.
  // Only when a package manager runs them: grep release: package.json is fine.
  ...['npm', 'pnpm', 'yarn', 'bun', 'npx'].flatMap((pm) => [`Bash(${pm} *release:*)`, `Bash(${pm} *upload:android*)`]),
  ...runs('release-ios.sh'),
  ...runs('release-android.sh'),
  ...runs('upload-play.mjs'),
  ...runs('release.sh'),
  ...runs('release.ps1'),
  'Bash(altool*)',
  'Bash(xcrun altool*)',
  // Web and backend deploy from GitHub, never from here.
  ...runs('deploy.sh'),
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

/** How long a call to the control room's own tools may take: an approval (30 min) and then the work. */
export const CONTROL_ROOM_TOOL_MS = 35 * 60 * 1000;

/**
 * A process for this account: its login and gh, the compaction window, and
 * tool output cut short, since whatever a tool prints is read on every later step.
 */
export function claudeEnv(account: string, context: number, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...accountEnv(account),
    ...extra,
    // An approval can wait for the owner for half an hour; the tool call must outlive that.
    MCP_TOOL_TIMEOUT: String(CONTROL_ROOM_TOOL_MS),
    // A call is also cut after 300 s with no word from the server: waiting for the owner's
    // yes and then a consultant's answer is exactly that, so the answer came and was lost.
    CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: String(CONTROL_ROOM_TOOL_MS),
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
