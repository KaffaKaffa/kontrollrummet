import { execFile, spawn } from './proc.ts';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CLAUDE_BIN, DATA_DIR } from './config.ts';
import { accountEnv, accountStatus, getAccount, identityEnv, identityTerminal, type Identity } from './accounts.ts';
import { provider } from './git.ts';
import { serversFor } from './mcp-servers.ts';
import { getTeam, type Team } from './roles.ts';
import { infraLogin } from './infra.ts';
import { scanRepo, type GitHost } from './scan.ts';
import { openTerminal, shellQuote } from './terminal.ts';
import { IS_WINDOWS } from './proc.ts';

const run = promisify(execFile);

/**
 * What must be in place for a project to work, checked rather than hoped for:
 * the account is logged in, git and its host's CLI are signed in with push
 * rights, the tools the stack needs are installed, and every MCP server an
 * agent is given connects. Each failure says how to fix it, and most can be
 * fixed from here: a Terminal opens with the command, or the server runs it.
 */

export interface Check {
  id: string;
  label: string;
  required: boolean;
  status: 'ok' | 'fail' | 'warn';
  detail: string;
  /** auth: an MCP server logged in from the page (mcp-login.ts), id is the server. */
  fix?: { label: string; kind: 'terminal' | 'run' | 'auth'; id: string };
}

export interface CheckTarget {
  /** The project's folder: a checkout, or a folder of several. */
  repo: string;
  /** The checkouts to check; one is the folder itself. */
  repos: { id: string; path: string; baseBranch: string; host: GitHost }[];
  account: string;
  /** The project's own az profile, if it has one. */
  azureConfigDir?: string | null;
  /** Its az profile for the Azure portal, when another login than DevOps'. */
  azurePortalConfigDir?: string | null;
  /** The project, when it exists (not for a draft in the guide). */
  teamId?: string;
  /** MCP servers the agents are given, by id. */
  servers: Record<string, Record<string, unknown>>;
  tools: string[];
}

export function targetForTeam(teamId: string): CheckTarget {
  const team = getTeam(teamId);
  if (!team) throw new Error('teamet finns inte');
  const servers: Record<string, Record<string, unknown>> = {};
  for (const role of team.roles) Object.assign(servers, serversFor(team, role));
  const scans = team.repos.map((r) => ({ r, scan: scanRepo(r.path) }));
  return {
    repo: team.repo,
    repos: scans.map(({ r, scan }) => ({ id: r.id, path: r.path, baseBranch: r.baseBranch, host: scan.host })),
    account: team.account,
    azureConfigDir: team.azureConfigDir,
    azurePortalConfigDir: team.azurePortalConfigDir,
    teamId: team.id,
    servers,
    tools: [...new Set(scans.flatMap(({ scan }) => scan.tools))],
  };
}

const git = (repo: string, args: string[]) => run('git', args, { cwd: repo }).then((r) => r.stdout.trim());

async function which(tool: string): Promise<boolean> {
  try {
    // A login shell on macOS: the server may run with a short PATH (launchd).
    if (IS_WINDOWS) await run('where.exe', [tool]);
    else await run('/bin/zsh', ['-lc', `command -v ${shellQuote(tool)}`]);
    return true;
  } catch {
    return false;
  }
}

const INSTALL: Record<string, string[][]> = {
  node: [['brew', 'install', 'node']],
  gh: [['brew', 'install', 'gh']],
  az: [['brew', 'install', 'azure-cli']],
  docker: [['brew', 'install', '--cask', 'docker']],
  dotnet: [['brew', 'install', '--cask', 'dotnet-sdk']],
  go: [['brew', 'install', 'go']],
  python3: [['brew', 'install', 'python']],
  java: [['brew', 'install', 'openjdk@21']],
  cargo: [['brew', 'install', 'rustup'], ['rustup-init']],
  xcodebuild: [['xcode-select', '--install']],
};

const winget = (id: string) => [['winget', 'install', '--id', id, '--exact', '--accept-source-agreements', '--accept-package-agreements']];
const INSTALL_WINDOWS: Record<string, string[][]> = {
  node: winget('OpenJS.NodeJS.LTS'),
  gh: winget('GitHub.cli'),
  az: winget('Microsoft.AzureCLI'),
  docker: winget('Docker.DockerDesktop'),
  dotnet: winget('Microsoft.DotNet.SDK.8'),
  go: winget('GoLang.Go'),
  python3: winget('Python.Python.3.12'),
  java: winget('Microsoft.OpenJDK.21'),
  cargo: winget('Rustlang.Rustup'),
};

/**
 * Starts claude with exactly these servers and reads which connect, from the
 * session's first message. It needs a prompt to get there, so it costs one
 * very short Haiku answer, and is stopped as soon as the status is in.
 */
export function probeMcp(account: string, cwd: string, servers: Record<string, Record<string, unknown>>): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const child = spawn(
      CLAUDE_BIN,
      ['-p', '--model', 'haiku', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: servers })],
      { cwd, env: accountEnv(account), stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let buffer = '';
    let done = false;
    const finish = (result: Record<string, string>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(result);
    };
    const timer = setTimeout(() => finish(Object.fromEntries(Object.keys(servers).map((k) => [k, 'timeout']))), 60_000);
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'system' && msg.subtype === 'init') {
            finish(Object.fromEntries((msg.mcp_servers ?? []).map((s: { name: string; status: string }) => [s.name, s.status])));
          }
        } catch {
          // not a JSON line
        }
      }
    });
    child.on('close', () => finish({}));
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'ok' } })}\n`);
  });
}

export async function runChecks(t: CheckTarget, opts: { mcp?: boolean } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const who = { account: t.account, azureConfigDir: t.azureConfigDir };
  const add = (c: Check) => checks.push(c);
  const account = getAccount(t.account);

  const status = accountStatus(account);
  add({
    id: 'account',
    label: `Claude-kontot ${account.name}`,
    required: true,
    status: status.loggedIn ? 'ok' : 'fail',
    detail: status.loggedIn ? `Inloggat som ${status.email}` : 'Inte inloggat',
    fix: status.loggedIn ? undefined : { label: 'Logga in', kind: 'terminal', id: 'login-claude' },
  });

  const many = t.repos.length > 1;
  if (!t.repos.length) add({ id: 'repo', label: 'Repon', required: true, status: 'fail', detail: `Inga git-repon i ${t.repo}` });
  for (const r of t.repos) {
    // With several repos, each check carries the repo's name; fixes name it too.
    const tag = many ? `${r.id}: ` : '';
    const key = many ? `:${r.id}` : '';
    const ok = existsSync(join(r.path, '.git'));
    add({ id: `repo${key}`, label: `${tag}Repot`, required: true, status: ok ? 'ok' : 'fail', detail: ok ? r.path : `${r.path} är inget git-repo` });
    if (!ok) continue;
    const base = await git(r.path, ['rev-parse', '--verify', '--quiet', `origin/${r.baseBranch}`]).catch(() => '');
    add({
      id: `base${key}`,
      label: `${tag}Basbranchen origin/${r.baseBranch}`,
      required: r.host !== 'none',
      status: base ? 'ok' : r.host === 'none' ? 'warn' : 'fail',
      detail: base ? 'Finns. Kort utgår från den.' : 'Saknas lokalt. Hämta från origin, eller pusha den först om repot är nytt.',
      fix: base ? undefined : { label: 'Hämta', kind: 'run', id: `fetch${key}` },
    });
  }

  // Signed in once per host; write access per repo.
  const hosts = [...new Set(t.repos.map((r) => r.host))];
  for (const h of hosts) {
    const host = provider(h);
    if (!host) {
      const which = t.repos.filter((r) => r.host === 'none').map((r) => r.id);
      add({ id: 'host', label: 'Git-värd', required: false, status: 'warn', detail: `Ingen GitHub- eller Azure DevOps-remote${many ? ` i ${which.join(', ')}` : ''}. Agenterna kan inte öppna PR:er förrän origin finns.` });
      continue;
    }
    const installed = await which(host.cli);
    const me = installed ? await host.whoami(who) : null;
    add({
      id: `host-login:${h}`,
      label: `${host.label} (${host.cli})`,
      required: true,
      status: me ? 'ok' : 'fail',
      detail: !installed
        ? `${host.cli} är inte installerat`
        : me
          ? `Inloggat som ${me}${h === 'azure' ? (t.azureConfigDir ? ` (profil ${t.azureConfigDir})` : ' (standardprofilen ~/.azure)') : ''}`
          : 'Inte inloggat för det här kontot',
      fix: !installed ? { label: 'Installera', kind: 'terminal', id: `install-${host.cli}` } : me ? undefined : { label: 'Logga in', kind: 'terminal', id: `login-host:${h}` },
    });
    if (!me) continue;
    for (const r of t.repos.filter((x) => x.host === h && existsSync(join(x.path, '.git')))) {
      const push = await host.canPush(r.path, who);
      add({
        id: `push${many ? `:${r.id}` : ''}`,
        label: `${many ? `${r.id}: ` : ''}Skrivrätt`,
        required: true,
        status: push ? 'ok' : 'fail',
        detail: push
          ? 'Agenterna kan pusha och öppna PR:er'
          : h === 'azure'
            ? `${me} kommer inte åt repot. Ge projektet en egen Azure-profil under Projektet och logga in där med rätt konto.`
            : 'Kontot saknar skrivrätt, eller repot hittas inte',
        fix: !push && h === 'azure' ? { label: 'Logga in i projektets profil', kind: 'terminal', id: 'azure-profile' } : undefined,
      });
    }
  }

  for (const tool of t.tools.filter((x) => x !== 'git' && x !== 'gh' && x !== 'az')) {
    const ok = await which(tool);
    add({
      id: `tool-${tool}`,
      label: tool,
      required: false,
      status: ok ? 'ok' : 'warn',
      detail: ok ? 'Installerat' : 'Behövs för att bygga och testa delar av repot',
      fix: ok || !(IS_WINDOWS ? INSTALL_WINDOWS : INSTALL)[tool] ? undefined : { label: 'Installera', kind: 'terminal', id: `install-${tool}` },
    });
  }

  const ids = Object.keys(t.servers);
  if (ids.length) {
    if (!opts.mcp) {
      add({ id: 'mcp', label: `MCP-servrar (${ids.join(', ')})`, required: false, status: 'warn', detail: 'Inte kontrollerade. "Kontrollera MCP" startar dem en gång (kostar ett kort Haiku-svar).' });
    } else {
      const result = await probeMcp(t.account, existsSync(t.repo) ? t.repo : process.cwd(), t.servers);
      for (const id of ids) {
        const s = result[id] ?? 'saknas';
        add({
          id: `mcp-${id}`,
          label: `MCP: ${id}`,
          required: false,
          status: s === 'connected' ? 'ok' : 'fail',
          detail: s === 'connected' ? 'Ansluter' : s === 'needs-auth' ? 'Behöver loggas in' : s === 'failed' ? 'Startar inte' : s,
          fix:
            s === 'needs-auth'
              ? IS_WINDOWS
                ? { label: 'Logga in i Terminal', kind: 'terminal', id: `mcp-${id}` }
                : { label: 'Authenticate', kind: 'auth', id }
              : s === 'failed'
                ? { label: 'Öppna i Terminal', kind: 'terminal', id: `mcp-${id}` }
                : undefined,
        });
      }
    }
  }
  return checks;
}

/** Runs a check's fix: a Terminal for what needs the owner at the keyboard, otherwise here. */
export async function fixCheck(t: CheckTarget, fixId: string): Promise<string> {
  const who = { account: t.account, azureConfigDir: t.azureConfigDir };
  // Which account a login was opened for, in the server log, for when it looks wrong.
  console.log(`[checks] ${fixId} som ${t.account}${t.azureConfigDir ? ` (az ${t.azureConfigDir})` : ''} i ${t.repo}`);
  const cwd = existsSync(t.repo) ? t.repo : undefined;
  const as = (what: string, w: Identity = who) => identityTerminal(w, what);
  if (fixId === 'login-claude') {
    openTerminal({ ...as('logga in Claude'), steps: [[CLAUDE_BIN, '/login']] });
    return 'Logga in i Terminal-fönstret och kör kontrollerna igen.';
  }
  if (fixId.startsWith('login-host:')) {
    const host = provider(fixId.slice('login-host:'.length) as GitHost);
    if (!host) throw new Error('ingen git-värd');
    openTerminal({ ...as(`logga in ${host.label}`), cwd, steps: host.loginCommand.split(' && ').map((c) => c.split(' ')) });
    return 'Logga in i Terminal-fönstret och kör kontrollerna igen.';
  }
  if (fixId === 'azure-profile') {
    // Never az login in the shared ~/.azure for one project: it would switch every other project's az too.
    if (!t.azureConfigDir) throw new Error('Ge först projektet en egen Azure-profil (under Infrastruktur → Azure), och logga sedan in där.');
    openTerminal({
      ...as('logga in Azure DevOps i projektets profil'),
      steps: [['az', 'login'], ['az', 'extension', 'add', '--name', 'azure-devops', '--only-show-errors']],
    });
    return `Logga in med kontot som har tillgång till repot. Profilen är ${t.azureConfigDir}.`;
  }
  if (fixId === 'azure-portal') {
    const dir = t.azurePortalConfigDir ?? t.azureConfigDir;
    if (!dir) throw new Error('Ge först projektet en egen Azure-profil (under Infrastruktur → Azure), och logga sedan in där.');
    openTerminal({ ...as('logga in Azure-portalen i projektets profil', { account: t.account, azureConfigDir: dir }), steps: [['az', 'login']] });
    return `Logga in med kontot som når portalens resurser. Profilen är ${dir}.`;
  }
  if (fixId.startsWith('infra:')) {
    const team = t.teamId ? getTeam(t.teamId) : null;
    if (!team) throw new Error('projektet finns inte');
    return infraLogin(team, fixId.slice('infra:'.length));
  }
  if (fixId.startsWith('install-')) {
    const steps = (IS_WINDOWS ? INSTALL_WINDOWS : INSTALL)[fixId.slice('install-'.length)];
    if (!steps) throw new Error('vet inte hur det installeras');
    openTerminal({ banner: `Kontrollrummet: installerar ${fixId.slice('install-'.length)}.`, steps });
    return 'Installationen körs i Terminal.';
  }
  if (fixId.startsWith('mcp-')) {
    const id = fixId.slice(4);
    const config = t.servers[id];
    if (!config) throw new Error('servern finns inte');
    // A file, not JSON on the command line: PowerShell 5.1 mangles quotes in arguments.
    const file = join(DATA_DIR, `mcp-login-${id.replace(/[^\w.-]/g, '_')}.json`);
    writeFileSync(file, JSON.stringify({ mcpServers: { [id]: config } }));
    openTerminal({
      ...as(`logga in MCP-servern ${id}: skriv /mcp, välj ${id} och logga in, avsluta med /exit`),
      cwd,
      steps: [[CLAUDE_BIN, '--strict-mcp-config', '--mcp-config', file]],
    });
    return `Logga in på ${id} med /mcp i Terminal-fönstret.`;
  }
  // fetch, with :<repo id> when there are several.
  const [action, repoId] = fixId.split(':');
  const target = repoId ? t.repos.find((r) => r.id === repoId) : t.repos[0];
  if (action === 'fetch' && !target) throw new Error('repot finns inte');
  if (action === 'fetch') {
    await git(target!.path, ['fetch', 'origin', '--quiet']);
    return 'Hämtat.';
  }
  throw new Error(`okänd åtgärd ${fixId}`);
}

/** Who an az profile is logged in as. */
export interface AzLogin {
  profile: string;
  user: string | null;
  subscription: string | null;
}

export interface AzureStatus {
  devops: AzLogin;
  /** Null when the portal uses the DevOps profile. */
  portal: AzLogin | null;
  /** Whether the portal's login reaches App Insights' subscription, when the project has one. */
  appInsights: { ok: boolean; detail: string } | null;
}

async function azLogin(account: string, dir: string | null): Promise<AzLogin> {
  const env = identityEnv({ account, azureConfigDir: dir });
  try {
    const { stdout } = await run('az', ['account', 'show', '--query', '{user:user.name, sub:name}', '-o', 'json'], { env, timeout: 20_000 });
    const a = JSON.parse(stdout) as { user?: string; sub?: string };
    return { profile: dir ?? '~/.azure', user: a.user ?? null, subscription: a.sub ?? null };
  } catch {
    // Logged out, or az missing.
    return { profile: dir ?? '~/.azure', user: null, subscription: null };
  }
}

/** Who the project's az is, as its agents and monitors see it. Runs az, no model. */
export async function azureStatus(team: Team): Promise<AzureStatus> {
  const [devops, portal] = await Promise.all([
    azLogin(team.account, team.azureConfigDir),
    team.azurePortalConfigDir ? azLogin(team.account, team.azurePortalConfigDir) : Promise.resolve(null),
  ]);
  const ai = team.monitors?.appInsights;
  let appInsights: AzureStatus['appInsights'] = null;
  if (ai) {
    const env = identityEnv({ account: team.account, azureConfigDir: team.azurePortalConfigDir ?? team.azureConfigDir });
    try {
      await run('az', ['account', 'get-access-token', '--subscription', ai.subscription, '--resource', 'https://api.applicationinsights.io', '--query', 'expiresOn', '-o', 'tsv'], { env, timeout: 20_000 });
      appInsights = { ok: true, detail: `Når ${ai.name ?? ai.appId}.` };
    } catch (err) {
      const msg = String((err as { stderr?: string }).stderr || (err as Error).message).split('\n').map((l) => l.trim()).find(Boolean) ?? 'okänt fel';
      appInsights = { ok: false, detail: msg.slice(0, 300) };
    }
  }
  return { devops, portal, appInsights };
}
