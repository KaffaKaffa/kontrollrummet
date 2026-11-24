import {
  addConsultant,
  consult,
  consultantTemplates,
  consultantView,
  drawPortrait,
  API_PROVIDERS,
  KEY_PAGE,
  SERVICES,
  KEY_SERVICE,
  PROVIDER_LABEL,
  libraryFaces,
  listModels,
  loadConsultants,
  pickPortrait,
  providerStatus,
  PROVIDERS,
  removeConsultant,
  saveConsultant,
  type Consultant,
  type ApiProvider,
  type Provider,
} from './consultants.ts';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { localImages, reveal, serveLocalImage } from './local-files.ts';
import { listConsultations } from './consultations.ts';
import { basename, dirname, extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { APP_ROOT, CLAUDE_BIN, DEV, HOST, MAX_CONCURRENT, PORT, TEAMS_DIR, WEB_DIST, expandHome } from './config.ts';
import { OWNER } from './owner.ts';
import { bus } from './bus.ts';
import {
  addEvent,
  closeNotice,
  getSubtask,
  setTaskTitle,
  listEvents,
  listSubtasks,
  listNotices,
  listPlans,
  listTasks,
  updateSubtask,
} from './db.ts';
import { decideApproval, handleMcp, listApprovals, lockHolders, lockQueues } from './mcp.ts';
import { IMAGE_MODEL, IMAGES_DIR, imagesAvailable, saveCardUpload } from './images.ts';
import { getUsage, pausedUntilIso } from './usage.ts';
import { accountsView, defaultAccountId, getAccount, identityTerminal } from './accounts.ts';
import { openTerminal } from './terminal.ts';
import { availableServers, sourceLabel } from './mcp-servers.ts';
import { existingIn, hostOfRepo, scanRepo, suggest, type GitHost } from './scan.ts';
import { suggestPeople } from './people.ts';
import { allDevApps, logText, ownerAnswer, ownerHold, ownerStart, ownerStop, saveDevApps } from './devapps.ts';
import { askDevApps, askInfra, cleanItems, infraLogin, infraStatus, setUpNewProject } from './infra.ts';
import { testMonitors } from './monitors.ts';
import { azureStatus, fixCheck, runChecks, targetForTeam, type CheckTarget } from './checks.ts';
import { cancelMcpLogin, mcpLoginStatus, pasteMcpRedirect, startMcpLogin } from './mcp-login.ts';
import {
  addRoleFromTemplate,
  generateLogo,
  installLocalSkill,
  librarySkillPath,
  librarySkills,
  listTemplates,
  logoPath,
  logoType,
  removeLocalSkill,
  removeLogo,
  removeRole,
  saveLogo,
  saveTeamSettings,
  createProject,
  type NewProject,
} from './project.ts';

interface DraftTarget {
  repo: string;
  /** The checkouts, when the folder holds several; otherwise the folder is the one. */
  repos?: { id: string; path: string; baseBranch: string; host: GitHost }[];
  account: string;
  azureConfigDir?: string | null;
  host: GitHost;
  baseBranch: string;
  /** MCP server ids the guide's agents are given. */
  servers: string[];
  tools: string[];
}

/** The project being set up in the guide, before it has a team folder. */
function draftTarget(d: DraftTarget): CheckTarget {
  const repos = d.repos?.length ? d.repos : [{ id: basename(d.repo), path: d.repo, baseBranch: d.baseBranch || 'main', host: d.host }];
  const available = new Map(availableServers({ repo: d.repo, repos, account: d.account, mcpServers: {} }).map((s) => [s.id, s.config]));
  return {
    repo: d.repo,
    repos,
    account: d.account,
    azureConfigDir: d.azureConfigDir || null,
    servers: Object.fromEntries(d.servers.filter((id) => available.has(id)).map((id) => [id, available.get(id)!])),
    tools: d.tools ?? [],
  };
}
import {
  applyConversation,
  handleGodfatherMcp,
  listConvEvents,
  listConversations,
  newConversation,
  newSession,
  openConversationInTerminal,
  recoverConversations,
  requestRestart,
  restartPending,
  saveUpload,
  sendMessage,
  stopAllConversations,
  stopConversation,
  updateSettings,
} from './godfather.ts';
import { delegateReview, planAction, submitTask, type PlanAction } from './actions.ts';
import { handleDesk } from './desk.ts';
import { getReleases } from './releases.ts';
import { deployProd, deployTest, listJobs, prodPreview, releaseApproved } from './deploy.ts';
import { checkPrNow, closerLookNow, ownerWroteTo, ownPrs } from './watch.ts';
import { figmaTitle } from './figma.ts';
import { runningCount, startAgent, stopAgent, stopAll } from './agent.ts';
import { startScheduler } from './orchestrator.ts';
import { cleanDevApps, getTeam, loadTeams, rawNotes, saveNotes, saveRole, saveTeamPrompt } from './roles.ts';

/**
 * Pages this server answers to. Anything else is a page on some other site
 * trying to drive the agents through the browser, and is refused.
 */
const HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`, 'localhost:5173', '127.0.0.1:5173']);
const ORIGINS = new Set([...HOSTS].map((h) => `http://${h}`));

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  // Requiring JSON forces a CORS preflight, which this server never grants.
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'JSON krävs');
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${key} saknas`);
  return value.trim();
}

/** This process: the page reloads when it sees another one, so a restart brings the new web app too. */
const BOOT = `${process.pid}-${Date.now()}`;

function state() {
  return {
    boot: BOOT,
    teams: loadTeams().map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      repo: t.repo,
      account: t.account,
      baseBranch: t.baseBranch,
      repos: t.repos,
      azureConfigDir: t.azureConfigDir,
      azurePortalConfigDir: t.azurePortalConfigDir,
      infraItems: t.infraItems,
      monitorEveryMinutes: t.monitors?.everyMinutes ?? 30,
      azure: t.repos.some((r) => hostOfRepo(r.path) === 'azure'),
      disabledSkills: t.disabledSkills,
      hasLogo: Boolean(logoPath(t.id)),
      mcpServers: availableServers(t).map(({ id, label, note, source, auth, suggestWhen }) => ({ id, label, note, source: sourceLabel(source), auth, suggestWhen })),
      teamPrompt: t.teamPrompt,
      hasReleases: Boolean(t.releases?.apps.length),
      people: t.people,
      roles: t.roles,
    })),
    tasks: listTasks(),
    subtasks: listSubtasks(),
    limits: { maxAgents: MAX_CONCURRENT, running: runningCount() },
    accounts: accountsView(),
    approvals: listApprovals(),
    consultations: listConsultations(),
    notices: listNotices(),
    locks: lockHolders(),
    lockQueues: lockQueues(),
    devApps: allDevApps(),
    ownPrs: ownPrs(),
    consultants: Object.fromEntries(loadTeams().map((t) => [t.id, loadConsultants(t.id).map((c) => consultantView(t.id, c))])),
    images: { available: imagesAvailable(), model: IMAGE_MODEL },
    plans: listPlans(),
    jobs: listJobs().map((j) => ({ ...j, log: j.log.slice(-20_000) })),
    usage: getUsage(),
    pausedUntil: pausedUntilIso(),
    conversations: listConversations(),
    restartPending: restartPending(),
    owner: OWNER,
  };
}

async function api(req: IncomingMessage, res: ServerResponse, path: string) {
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && !ORIGINS.has(origin)) throw new HttpError(403, 'fel ursprung');
  }

  if (req.method === 'GET' && path === '/api/state') return json(res, 200, state());

  if (req.method === 'GET' && path === '/api/accounts') return json(res, 200, accountsView());

  if (req.method === 'GET' && path === '/api/fs') {
    // The folder browser: one folder's sub-folders, git repos marked. Hidden folders only when asked.
    const params = new URL(req.url ?? '/', 'http://x').searchParams;
    const dir = resolve(expandHome(params.get('path') || '~/Dev'));
    const hidden = params.has('hidden');
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => (hidden || !e.name.startsWith('.')) && (e.isDirectory() || (e.isSymbolicLink() && existsSync(join(dir, e.name)) && statSync(join(dir, e.name)).isDirectory())))
        .map((e) => ({ name: e.name, git: existsSync(join(dir, e.name, '.git')) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'sv'));
      return json(res, 200, { path: dir, parent: dirname(dir) === dir ? null : dirname(dir), home: homedir(), git: existsSync(join(dir, '.git')), entries });
    } catch (err) {
      throw new HttpError(400, `kan inte läsa ${dir}: ${(err as Error).message}`);
    }
  }

  // Pictures behind an agent's file:// link: a folder of screenshots or one image.
  if (req.method === 'GET' && path === '/api/local-images') {
    const p = new URL(req.url ?? '/', 'http://x').searchParams.get('path') ?? '';
    const found = localImages(expandHome(p));
    if (!found) throw new HttpError(404, 'inga bilder där');
    return json(res, 200, found);
  }
  if (req.method === 'POST' && path === '/api/reveal') {
    const body = await readJson(req);
    if (!reveal(expandHome(text(body, 'path')))) throw new HttpError(404, 'finns inte');
    return json(res, 200, {});
  }

  if (req.method === 'POST' && path === '/api/restart') {
    await readJson(req);
    // Once nothing runs: launchd starts it again, and the start script builds the web app.
    requestRestart();
    return json(res, 202, {});
  }

  // ---- Gudfadern
  if (req.method === 'GET' && path === '/api/folders') {
    // Where a conversation usually starts: home, the control room, every team's repo.
    const teams = loadTeams();
    return json(res, 200, [
      { path: homedir(), label: 'Hemmappen', account: null },
      { path: APP_ROOT, label: 'Kontrollrummet', account: null, worktree: true },
      ...teams.map((t) => ({ path: t.repo, label: t.name, account: t.account })),
    ]);
  }
  if (req.method === 'POST' && path === '/api/conversations') {
    const body = await readJson(req);
    try {
      return json(res, 201, await newConversation(body as unknown as Parameters<typeof newConversation>[0]));
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }
  const conv = /^\/api\/conversations\/(\d+)(?:\/(events|messages|stop|new-session|terminal|apply|upload))?$/.exec(path);
  if (conv) {
    const id = Number(conv[1]);
    const action = conv[2];
    try {
      if (req.method === 'GET' && action === 'events') return json(res, 200, listConvEvents(id));
      if (req.method === 'PUT' && !action) return json(res, 200, updateSettings(id, (await readJson(req)) as Parameters<typeof updateSettings>[1]));
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (action === 'messages') {
          sendMessage(id, text(body, 'text'));
          return json(res, 202, {});
        }
        if (action === 'stop') return json(res, 200, { stopped: stopConversation(id) });
        if (action === 'new-session') return json(res, 200, newSession(id));
        if (action === 'terminal') {
          openConversationInTerminal(id);
          return json(res, 202, {});
        }
        if (action === 'apply') return json(res, 200, await applyConversation(id));
        if (action === 'upload') return json(res, 201, { path: saveUpload(id, text(body, 'name'), text(body, 'data')) });
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(409, (err as Error).message);
    }
  }
  const login = /^\/api\/accounts\/([\w.-]+)\/login$/.exec(path);
  if (req.method === 'POST' && login) {
    await readJson(req);
    const account = getAccount(login[1]);
    if (account.id !== login[1]) throw new HttpError(404, 'kontot finns inte');
    // Claude Code logs in interactively; a Terminal with the profile set is the way.
    console.log(`[accounts] logga in ${account.id}`);
    openTerminal({ ...identityTerminal(account.id, 'logga in Claude'), steps: [[CLAUDE_BIN, '/login']] });
    return json(res, 202, {});
  }

  if (req.method === 'POST' && path === '/api/tasks') {
    const body = await readJson(req);
    const agent = typeof body.agent === 'string' && body.agent ? body.agent : undefined;
    try {
      return json(res, 201, submitTask(text(body, 'team'), text(body, 'text'), agent));
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }

  const taskTitle = /^\/api\/tasks\/(\d+)$/.exec(path);
  if (req.method === 'PUT' && taskTitle) {
    const title = text(await readJson(req), 'title').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!title) throw new HttpError(400, 'tom titel');
    try {
      const task = setTaskTitle(Number(taskTitle[1]), title);
      bus.emit({ type: 'task', task });
      return json(res, 200, task);
    } catch (err) {
      throw new HttpError(404, (err as Error).message);
    }
  }

  if (req.method === 'GET' && path === '/api/link-title') {
    const href = new URL(req.url ?? '/', 'http://x').searchParams.get('url') ?? '';
    return json(res, 200, { title: await figmaTitle(href).catch(() => null) });
  }

  // ---- the project's local apps: the owner's buttons
  const dev = /^\/api\/dev\/([\w-]+)\/([\w-]+)\/(log|start|stop|hold|answer)$/.exec(path);
  if (dev) {
    const [, teamId, appId, action] = dev;
    try {
      if (req.method === 'GET' && action === 'log') return json(res, 200, { text: logText(teamId, appId) });
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (action === 'start') await ownerStart(teamId, appId, typeof body.from === 'number' ? body.from : null, body.force === true);
        if (action === 'stop') await ownerStop(teamId, appId);
        if (action === 'hold') await ownerHold(teamId, appId, body.held === true);
        if (action === 'answer') await ownerAnswer(teamId, appId, body.keep === true);
        return json(res, 200, {});
      }
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
  }

  const rel = /^\/api\/teams\/([\w-]+)\/releases$/.exec(path);
  if (req.method === 'GET' && rel) {
    const force = new URL(req.url ?? '/', 'http://x').searchParams.has('refresh');
    const data = await getReleases(rel[1], force);
    if (!data) throw new HttpError(404, 'teamet har inga store-appar i team.json');
    return json(res, 200, data);
  }

  const dep = /^\/api\/teams\/([\w-]+)\/apps\/([\w-]+)\/(test|prod-preview|prod|release)$/.exec(path);
  if (dep) {
    const [, teamId, appId, action] = dep;
    try {
      if (req.method === 'GET' && action === 'prod-preview') return json(res, 200, await prodPreview(teamId, appId));
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (action === 'test') return json(res, 202, deployTest(teamId, appId));
        if (action === 'release') return json(res, 202, releaseApproved(teamId, appId));
        if (action === 'prod') {
          // The board's confirmation sends this; nothing else does.
          if (body.confirm !== true) throw new HttpError(400, 'bekräftelse saknas');
          const notes = { sv: typeof body.notesSv === 'string' ? body.notesSv.trim() || undefined : undefined, en: typeof body.notesEn === 'string' ? body.notesEn.trim() || undefined : undefined };
          return json(res, 202, deployProd(teamId, appId, notes));
        }
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(409, (err as Error).message);
    }
  }
  if (req.method === 'GET' && path === '/api/jobs') return json(res, 200, listJobs());

  // ---- new project: scan, checks, create
  if (req.method === 'POST' && path === '/api/projects/scan') {
    const body = await readJson(req);
    return json(res, 200, scanRepo(text(body, 'path')));
  }
  if (req.method === 'POST' && path === '/api/projects/suggest') {
    // A repo that does not exist yet: suggestions from what the owner says it will hold.
    const body = await readJson(req);
    return json(res, 200, suggest(new Set(Array.isArray(body.signals) ? (body.signals as string[]) : []), {}));
  }
  if (req.method === 'POST' && path === '/api/projects') {
    const body = await readJson(req);
    try {
      const created = await createProject(body as unknown as NewProject);
      bus.emit({ type: 'teams' });
      // Where it runs, set up on its own from the repo, memory and CLIs; the settings show it after.
      setUpNewProject(created.teamId);
      return json(res, 201, created);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }
  // ---- logging in to an MCP server from a button
  if (req.method === 'POST' && path === '/api/mcp-login') {
    const body = await readJson(req);
    try {
      const target: CheckTarget = typeof body.team === 'string' ? targetForTeam(body.team) : draftTarget(body.draft as DraftTarget);
      const server = text(body, 'server');
      const config = target.servers[server];
      if (!config) throw new Error(`${server} är inte en av agenternas servrar`);
      return json(res, 201, await startMcpLogin({ account: target.account, azureConfigDir: target.azureConfigDir }, target.repo, server, config));
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
  }
  const mcpLogin = /^\/api\/mcp-login\/([\w-]+)(?:\/(paste|cancel))?$/.exec(path);
  if (mcpLogin) {
    try {
      if (req.method === 'GET' && !mcpLogin[2]) return json(res, 200, mcpLoginStatus(mcpLogin[1]));
      if (req.method === 'POST' && mcpLogin[2] === 'paste') {
        pasteMcpRedirect(mcpLogin[1], text(await readJson(req), 'url'));
        return json(res, 202, {});
      }
      if (req.method === 'POST' && mcpLogin[2] === 'cancel') {
        await readJson(req);
        cancelMcpLogin(mcpLogin[1]);
        return json(res, 200, {});
      }
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
  }

  if (req.method === 'POST' && (path === '/api/checks' || path === '/api/checks/fix')) {
    const body = await readJson(req);
    try {
      // A project that exists, or the one being set up in the guide.
      const target: CheckTarget = typeof body.team === 'string' ? targetForTeam(body.team) : draftTarget(body.draft as DraftTarget);
      if (path === '/api/checks') return json(res, 200, await runChecks(target, { mcp: body.mcp === true }));
      return json(res, 200, { message: await fixCheck(target, text(body, 'fix')) });
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
  }

  // ---- project settings: agents, skills, logo, account
  if (req.method === 'GET' && path === '/api/library') {
    return json(res, 200, {
      templates: listTemplates().map(({ id, name, kind, title, model, mcp, owns, suggestWhen }) => ({ id, name, kind, title, model, mcp, owns, suggestWhen })),
      skills: librarySkills(),
    });
  }
  // ---- Consultants: specialists the agents ask over an API (server/consultants.ts).
  if (req.method === 'GET' && path === '/api/consultants/models') {
    const provider = new URL(req.url ?? '/', 'http://x').searchParams.get('provider') as Provider;
    if (!PROVIDERS.includes(provider)) throw new HttpError(400, 'okänd leverantör');
    try {
      return json(res, 200, { models: await listModels(provider) });
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
  }
  const face = /^\/api\/faces\/([\w-]+)$/.exec(path);
  if (req.method === 'GET' && face) {
    // The library's faces (agents, the wardrobe, the consultant templates), to pick from.
    const file = join(APP_ROOT, 'library', 'avatars', `${face[1]}.png`);
    if (!existsSync(file)) throw new HttpError(404, 'inget ansikte');
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
    return res.end(readFileSync(file));
  }
  if (req.method === 'POST' && path === '/api/consultants/key') {
    // The owner pastes the key at a hidden prompt; it goes to the keychain (macOS) or DPAPI (Windows), never to a file here.
    const provider = text(await readJson(req), 'provider') as ApiProvider;
    if (!API_PROVIDERS.includes(provider)) throw new HttpError(400, 'leverantören har ingen API-nyckel här');
    openTerminal({
      banner: `API-nyckel för ${PROVIDER_LABEL[provider]} till kontrollrummets konsulter. Skapa en nyckel på sidan som öppnas, kopiera den och klistra in här.`,
      url: KEY_PAGE[provider],
      secret: { service: KEY_SERVICE[provider].service, prompt: 'Klistra in nyckeln (den syns inte när du klistrar) och tryck Enter:' },
    });
    return json(res, 202, {});
  }
  const cons = /^\/api\/teams\/([\w-]+)\/consultants(?:\/([\w-]+))?(?:\/(remove|portrait|face|try))?$/.exec(path);
  if (cons) {
    const [, teamId, id, action] = cons;
    if (!getTeam(teamId)) throw new HttpError(404, 'teamet finns inte');
    try {
      if (req.method === 'GET' && !id)
        return json(res, 200, {
          consultants: loadConsultants(teamId).map((c) => consultantView(teamId, c)),
          templates: consultantTemplates(),
          providers: providerStatus(),
          keys: KEY_SERVICE,
          services: SERVICES,
          faces: libraryFaces(),
        });
      const body = req.method === 'GET' ? {} : await readJson(req);
      let result: unknown = {};
      if (req.method === 'POST' && !id) result = await addConsultant(teamId, typeof body.template === 'string' && body.template ? body.template : null);
      else if (req.method === 'PUT' && id && !action) result = saveConsultant(teamId, id, body as Partial<Consultant>);
      else if (req.method === 'POST' && id && action === 'remove') removeConsultant(teamId, id);
      else if (req.method === 'POST' && id && action === 'portrait') result = { portrait: await drawPortrait(teamId, id) };
      else if (req.method === 'POST' && id && action === 'face') pickPortrait(teamId, id, text(body, 'face'));
      else if (req.method === 'POST' && id && action === 'try') {
        // The owner tries the consultant out from the settings.
        const { answer } = await consult(teamId, id, text(body, 'question'));
        result = { text: answer.text, images: answer.images.map((i) => i.url) };
      } else throw new HttpError(405, 'stöds inte');
      if (action !== 'try') bus.emit({ type: 'teams' });
      return json(res, 200, result);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(409, (err as Error).message);
    }
  }

  const proj = /^\/api\/teams\/([\w-]+)\/(settings|skills|roles|logo|people|azure|infra|monitors|review|dev-apps)(?:\/([\w-]+))?(?:\/(remove))?$/.exec(path);
  if (proj && !(proj[2] === 'roles' && req.method === 'PUT')) {
    const [, teamId, what, item, remove] = proj;
    const team = getTeam(teamId);
    if (!team) throw new HttpError(404, 'teamet finns inte');
    try {
      if (req.method === 'GET' && what === 'skills') {
        // What the project already has, in its folder and each repo, and whether the agents use it.
        const all = [existingIn(team.repo, ''), ...(team.repos.length > 1 ? team.repos.map((r) => existingIn(r.path, r.id)) : [])];
        return json(res, 200, {
          skills: all.flatMap((e) => e.skills).map((s) => ({ ...s, enabled: !team.disabledSkills.includes(s.id) })),
          instructions: all.flatMap((e) => e.instructions),
        });
      }
      if (req.method === 'GET' && what === 'logo') {
        const file = logoPath(teamId);
        if (!file) throw new HttpError(404, 'ingen logga');
        res.writeHead(200, { 'content-type': logoType(file), 'cache-control': 'no-cache' });
        res.end(readFileSync(file));
        return;
      }
      if (req.method === 'POST' && what === 'people' && item === 'suggest') {
        return json(res, 200, await suggestPeople(team));
      }
      if (req.method === 'GET' && what === 'azure') return json(res, 200, await azureStatus(team));
      if (req.method === 'POST' && what === 'review') {
        // A PR waiting for the owner's review, handed to the team leader.
        const body = await readJson(req);
        const card = delegateReview(teamId, text(body, 'url'), typeof body.title === 'string' ? body.title : undefined);
        return json(res, 201, { card: card.id });
      }
      if (req.method === 'GET' && what === 'infra') return json(res, 200, await infraStatus(team));
      if (req.method === 'POST' && what === 'infra' && item === 'ask') {
        // Identify (no text) or do what the owner wrote: the agent's list is checked and saved.
        const body = await readJson(req);
        return json(res, 200, await askInfra(team, typeof body.text === 'string' ? body.text.slice(0, 4000) : ''));
      }
      if (req.method === 'POST' && what === 'dev-apps' && item === 'ask') {
        // How the project runs locally: the agent's list, checked and saved like the infrastructure.
        const body = await readJson(req);
        return json(res, 200, await askDevApps(team, typeof body.text === 'string' ? body.text.slice(0, 4000) : ''));
      }
      if (req.method === 'POST' && what === 'infra' && item === 'login') {
        const body = await readJson(req);
        return json(res, 200, { message: infraLogin(team, text(body, 'item')) });
      }
      if (req.method === 'POST' && what === 'monitors' && item === 'test') {
        await readJson(req);
        return json(res, 200, await testMonitors(team));
      }
      if (req.method === 'POST' && what === 'azure' && (item === 'login' || item === 'portal')) {
        await readJson(req);
        try {
          await fixCheck(targetForTeam(teamId), item === 'portal' ? 'azure-portal' : 'azure-profile');
        } catch (err) {
          throw new HttpError(409, (err as Error).message);
        }
        return json(res, 202, {});
      }
      if (req.method === 'PUT' && what === 'settings') {
        const body = (await readJson(req)) as Parameters<typeof saveTeamSettings>[1] & { infraItems?: unknown; devApps?: unknown };
        // The list as the page sends it is checked like an agent's: never trusted as is.
        saveTeamSettings(teamId, {
          ...body,
          ...(body.infraItems !== undefined ? { infraItems: cleanItems(body.infraItems) } : {}),
          ...(body.devApps !== undefined ? { devApps: cleanDevApps(body.devApps) } : {}),
        });
        return json(res, 200, {});
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (what === 'roles' && !item) {
          const over = { name: typeof body.name === 'string' ? body.name : undefined, owns: Array.isArray(body.owns) ? (body.owns as string[]) : undefined };
          return json(res, 201, { id: addRoleFromTemplate(teamId, text(body, 'template'), over) });
        }
        if (what === 'roles' && item && remove) {
          removeRole(teamId, item);
          return json(res, 200, {});
        }
        if (what === 'skills' && !item) {
          const id = text(body, 'id');
          if (body.mode === 'commit') {
            // Checked in goes through a PR, like any other change to the repo.
            const { subtask } = submitTask(
              teamId,
              `Lägg in skillen \`${id}\` i ${team.repos.length > 1 ? `vart och ett av repona (${team.repos.map((r) => r.id).join(', ')}), en PR per repo` : 'repot'}: kopiera mappen ${librarySkillPath(id)} till \`.claude/skills/${id}/\` och öppna en PR med bara den ändringen. Den läses av alla agenter som arbetar i repot.`,
            );
            return json(res, 201, { card: subtask.id });
          }
          installLocalSkill(team.repo, id);
          return json(res, 201, {});
        }
        if (what === 'skills' && item && remove) {
          // In the project's folder, or in one of its repos.
          const where = typeof body.where === 'string' && body.where ? team.repos.find((r) => r.id === body.where)?.path : team.repo;
          if (!where) throw new HttpError(404, 'repot finns inte');
          removeLocalSkill(where, item);
          return json(res, 200, {});
        }
        if (what === 'logo' && remove) {
          removeLogo(teamId);
          return json(res, 200, {});
        }
        if (what === 'logo') {
          if (typeof body.generate === 'string' && body.generate.trim()) await generateLogo(teamId, body.generate.trim());
          else saveLogo(teamId, text(body, 'name'), text(body, 'data'));
          return json(res, 201, {});
        }
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(409, (err as Error).message);
    } finally {
      if (req.method !== 'GET') bus.emit({ type: 'teams' });
    }
  }

  const role = /^\/api\/teams\/([\w-]+)\/roles\/([\w-]+)$/.exec(path);
  if (req.method === 'PUT' && role) {
    const body = await readJson(req);
    try {
      const saved = saveRole(role[1], role[2], body as Parameters<typeof saveRole>[2]);
      bus.emit({ type: 'teams' });
      return json(res, 200, saved);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }
  // What a role has learned (teams/<id>/notes/<role>.md): shown and edited in the agent's settings.
  const notes = /^\/api\/teams\/([\w-]+)\/notes\/([\w-]+)$/.exec(path);
  if (notes && req.method === 'GET') return json(res, 200, { text: rawNotes(notes[1], notes[2]) });
  if (notes && req.method === 'PUT') {
    const body = await readJson(req);
    try {
      saveNotes(notes[1], notes[2], typeof body.text === 'string' ? body.text : '');
      return json(res, 200, {});
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }
  const shared = /^\/api\/teams\/([\w-]+)\/shared$/.exec(path);
  if (req.method === 'PUT' && shared) {
    const body = await readJson(req);
    try {
      saveTeamPrompt(shared[1], typeof body.text === 'string' ? body.text : '');
      return json(res, 200, {});
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }

  const plan = /^\/api\/plans\/(\d+)\/(implement|park|unpark|discard)$/.exec(path);
  if (req.method === 'POST' && plan) {
    await readJson(req);
    try {
      return json(res, 200, planAction(Number(plan[1]), plan[2] as PlanAction));
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
  }

  // A notice from an agent: "Klart" closes it and tells the card it is done, "Stäng" only closes it.
  const notice = /^\/api\/notices\/(\d+)\/(done|close)$/.exec(path);
  if (req.method === 'POST' && notice) {
    await readJson(req);
    const closed = closeNotice(Number(notice[1]));
    if (!closed) throw new HttpError(404, 'notisen finns inte');
    bus.emit({ type: 'notice', notice: closed });
    const card = closed.subtaskId != null ? getSubtask(closed.subtaskId) : undefined;
    if (notice[2] === 'done' && card) {
      const said = closed.text.length > 1200 ? `${closed.text.slice(0, 1200)} …` : closed.text;
      void startAgent(
        card.id,
        `[Kontrollrummet] ${OWNER} har markerat din notis som klar, alltså gjort det som stod i den:\n\n> ${said.replaceAll('\n', '\n> ')}\n\nFortsätt med det som väntade på det, om något gjorde det. Annars: ingen åtgärd, avsluta med report som förut.`,
        { wake: true },
      ).catch(() => undefined);
    }
    return json(res, 200, {});
  }

  const approval = /^\/api\/approvals\/([\w-]+)$/.exec(path);
  if (req.method === 'POST' && approval) {
    const body = await readJson(req);
    const ok = decideApproval(approval[1], body.allow === true, typeof body.reason === 'string' ? body.reason : undefined);
    if (!ok) throw new HttpError(404, 'frågan är redan besvarad');
    return json(res, 200, {});
  }

  const m = /^\/api\/subtasks\/(\d+)\/(events|messages|stop|done|terminal|merged|login|upload|closer-look)$/.exec(path);
  if (m) {
    const id = Number(m[1]);
    const subtask = getSubtask(id);
    if (!subtask) throw new HttpError(404, 'kortet finns inte');
    const action = m[2];

    if (req.method === 'GET' && action === 'events') return json(res, 200, listEvents(id));

    if (req.method === 'POST' && action === 'messages') {
      const body = await readJson(req);
      // A message from the owner starts the agent even at the cap: it is asked for, not scheduled.
      // The card's lead did not see this conversation; it hears what came of it when the turn ends.
      ownerWroteTo(id);
      await startAgent(id, text(body, 'text'));
      // Pasted images, on the card after the message: the agent reads them by their paths in the text.
      for (const url of Array.isArray(body.images) ? body.images : []) {
        if (typeof url === 'string' && url.startsWith(`http://${HOST}:${PORT}/images/${subtask.team}/`)) bus.emit({ type: 'event', event: addEvent(id, 'image', url) });
      }
      return json(res, 202, {});
    }
    if (req.method === 'POST' && action === 'stop') {
      await readJson(req);
      return json(res, 200, { stopped: stopAgent(id) });
    }
    if (req.method === 'POST' && action === 'done') {
      await readJson(req);
      stopAgent(id);
      const updated = updateSubtask(id, { status: 'done' });
      bus.emit({ type: 'subtask', subtask: updated });
      return json(res, 200, updated);
    }
    if (req.method === 'POST' && action === 'closer-look') {
      await readJson(req);
      try {
        return json(res, 201, await closerLookNow(id));
      } catch (err) {
        throw new HttpError(409, (err as Error).message);
      }
    }
    if (req.method === 'POST' && action === 'merged') {
      await readJson(req);
      try {
        return json(res, 200, await checkPrNow(id));
      } catch (err) {
        throw new HttpError(409, (err as Error).message);
      }
    }
    if (req.method === 'POST' && action === 'upload') {
      const body = await readJson(req);
      try {
        return json(res, 201, saveCardUpload(subtask.team, text(body, 'name'), text(body, 'data')));
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    }
    if (req.method === 'POST' && action === 'login') {
      await readJson(req);
      // The fix the card's own ask names, run for the card's project and account.
      const fix = subtask.ask?.login?.fix;
      if (!fix) throw new HttpError(409, 'kortet väntar inte på en inloggning');
      try {
        await fixCheck(targetForTeam(subtask.team), fix);
        return json(res, 200, { message: 'Logga in i Terminal-fönstret och tryck sedan Fortsätt.' });
      } catch (err) {
        throw new HttpError(409, (err as Error).message);
      }
    }
    if (req.method === 'POST' && action === 'terminal') {
      await readJson(req);
      if (!subtask.sessionId) throw new HttpError(409, 'agenten har inte startat än');
      // The same folder the agent ran in, or claude --resume cannot find the session.
      const cwd = subtask.worktree ?? getTeam(subtask.team)?.repo ?? process.cwd();
      // Same account as the agent, or the session is not found (and it would be the wrong account).
      const t = getTeam(subtask.team);
      const who = t ? { account: t.account, azureConfigDir: t.azureConfigDir } : defaultAccountId();
      openTerminal({ ...identityTerminal(who, `fortsätt kort #${subtask.id}`), cwd, steps: [[CLAUDE_BIN, '--resume', subtask.sessionId]] });
      return json(res, 202, {});
    }
  }

  throw new HttpError(404, 'finns inte');
}

const TYPES: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.jpg': 'image/jpeg',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function serveImage(res: ServerResponse, path: string) {
  const file = normalize(join(IMAGES_DIR, decodeURIComponent(path.replace(/^\/images\//, ''))));
  if (!file.startsWith(IMAGES_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'max-age=31536000, immutable' });
  res.end(readFileSync(file));
}

function serveStatic(res: ServerResponse, path: string) {
  const file = normalize(join(WEB_DIST, path));
  const target =
    file.startsWith(WEB_DIST) && existsSync(file) && statSync(file).isFile() ? file : join(WEB_DIST, 'index.html');
  if (!existsSync(target)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Webbappen är inte byggd. Kör npm run build.');
    return;
  }
  // Built assets carry a hash in their name and never change; the page that names them does,
  // so it is always asked for again and a new build shows on the next reload.
  const hashed = target.includes(`${WEB_DIST}/assets/`);
  res.writeHead(200, {
    'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
    'cache-control': hashed ? 'max-age=31536000, immutable' : 'no-cache',
  });
  res.end(readFileSync(target));
}

const server = createServer((req, res) => {
  // A name rebound to 127.0.0.1 arrives with its own Host; it gets nothing, not even a GET.
  if (!HOSTS.has(req.headers.host ?? '')) {
    res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('fel värd');
    return;
  }
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  if (url.pathname === '/mcp/desk') {
    if (req.headers.origin || req.method !== 'POST') {
      res.writeHead(req.method === 'POST' ? 403 : 405);
      res.end();
      return;
    }
    readJson(req)
      .then((body) => handleDesk(req, res, body))
      .catch((err: Error) => json(res, 400, { error: err.message }));
    return;
  }
  if (url.pathname === '/mcp/godfather') {
    if (req.headers.origin || req.method !== 'POST') {
      res.writeHead(req.method === 'POST' ? 403 : 405);
      res.end();
      return;
    }
    readJson(req)
      .then((body) => handleGodfatherMcp(req, res, body))
      .catch((err: Error) => json(res, 400, { error: err.message }));
    return;
  }
  if (url.pathname === '/mcp') {
    // Agents, not browsers: a request carrying an Origin is a web page and is refused.
    if (req.headers.origin || req.method !== 'POST') {
      res.writeHead(req.method === 'POST' ? 403 : 405);
      res.end();
      return;
    }
    readJson(req)
      .then((body) => handleMcp(req, res, body))
      .catch((err: Error) => json(res, 400, { error: err.message }));
    return;
  }
  if (url.pathname.startsWith('/images/')) return serveImage(res, url.pathname);
  if (url.pathname === '/local-image') return serveLocalImage(res, url.searchParams.get('path') ?? '');
  // Portraits, 3D characters and office furniture are added while the server runs
  // (a new agent, scripts/characters.mjs), so they are read from the source, not the build.
  const live = /^\/(avatars|characters|office)\//.exec(url.pathname);
  if (live) {
    const dir = join(APP_ROOT, 'web/public', live[1]);
    const file = normalize(join(dir, decodeURIComponent(url.pathname.slice(live[0].length))));
    if (file.startsWith(`${dir}/`) && existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(readFileSync(file));
      return;
    }
  }
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
  api(req, res, url.pathname).catch((err: Error) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    json(res, status, { error: err.message });
  });
});

const wss = new WebSocketServer({
  server,
  path: '/api/live',
  verifyClient: ({ origin, req }: { origin?: string; req: IncomingMessage }) =>
    HOSTS.has(req.headers.host ?? '') && (!origin || ORIGINS.has(origin)),
});
wss.on('connection', (socket) => {
  const off = bus.on((message) => socket.send(JSON.stringify(message)));
  socket.on('close', off);
});

recoverConversations();
startScheduler();
server.listen(PORT, HOST, () => {
  console.log(`Kontrollrummet på http://${HOST}:${PORT}${DEV ? ' (UI på http://localhost:5173)' : ''}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopAll();
    stopAllConversations();
    saveDevApps();
    server.close();
    process.exit(0);
  });
}
