import { setExcluded } from './project.ts';
import { spawn, execFile } from './proc.ts';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { bus } from './bus.ts';
import { getTeam, type Team } from './roles.ts';
import { ascCall, ascToken, playCall, playToken, invalidateReleases, latestMsix, msixDir, msStoreCall, msStoreToken, type BuiltMsix, type StoreApp } from './releases.ts';
import { DATA_DIR, expandHome } from './config.ts';
import { holdRestart } from './holds.ts';
import { lockForDeploy, unlockDeploy } from './mcp.ts';
import { sleepVm, vmFor, wakeVm, type VmConfig } from './vms.ts';

const run = promisify(execFile);

/**
 * Deploys of store apps, started from the Releases view and nowhere else.
 * Test builds run the team's own release scripts in a clean worktree of the
 * base branch; prod goes through the store APIs and always after a
 * confirmation in the board.
 */

export interface Job {
  id: string;
  team: string;
  app: string;
  kind: 'test' | 'prod' | 'release';
  title: string;
  status: 'running' | 'done' | 'failed';
  log: string;
  startedAt: string;
  endedAt: string | null;
}

const MAX_LOG = 200_000;
/** The last jobs, kept on disk so the history (and how a build ended) outlives a restart. */
const JOBS_FILE = join(DATA_DIR, 'jobs.json');
const KEEP = 30;

function loadJobs(): Map<string, Job> {
  try {
    const list = JSON.parse(readFileSync(JOBS_FILE, 'utf8')) as Job[];
    // Running when the server went: its process went with it.
    for (const j of list)
      if (j.status === 'running') {
        j.status = 'failed';
        j.endedAt = j.endedAt ?? new Date().toISOString();
        j.log += '\n✗ Avbröts: servern stängdes medan jobbet körde. Starta det igen.\n';
      }
    return new Map(list.map((j) => [j.id, j]));
  } catch {
    return new Map();
  }
}

const jobs = loadJobs();
let saveTimer: NodeJS.Timeout | undefined;

function saveJobs(now = false) {
  clearTimeout(saveTimer);
  const write = () => {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(JOBS_FILE, JSON.stringify(listJobs()));
    } catch {
      // History only: the job itself goes on.
    }
  };
  if (now) write();
  else saveTimer = setTimeout(write, 5000);
}

// A restart waits for running jobs: a build's processes would die with the server.
holdRestart(() => [...jobs.values()].filter((j) => j.status === 'running').length);

export const listJobs = () => [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, KEEP);

function emit(job: Job) {
  bus.emit({ type: 'job', job: { ...job, log: job.log.slice(-20_000) } });
}

function append(job: Job, text: string) {
  job.log = (job.log + text).slice(-MAX_LOG);
  emit(job);
  saveJobs();
}

function startJob(team: string, app: string, kind: Job['kind'], title: string): Job {
  const busy = [...jobs.values()].find((j) => j.team === team && j.app === app && j.status === 'running');
  if (busy) throw new Error(`${app} har redan ett jobb igång: ${busy.title}`);
  const job: Job = { id: randomUUID(), team, app, kind, title, status: 'running', log: '', startedAt: new Date().toISOString(), endedAt: null };
  jobs.set(job.id, job);
  for (const old of [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(KEEP)) jobs.delete(old.id);
  emit(job);
  saveJobs(true);
  return job;
}

function endJob(job: Job, ok: boolean, line?: string) {
  if (line) job.log += `\n${line}\n`;
  job.status = ok ? 'done' : 'failed';
  job.endedAt = new Date().toISOString();
  emit(job);
  saveJobs(true);
  invalidateReleases(job.team);
}

function findApp(team: Team, appId: string): StoreApp {
  const app = team.releases?.apps.find((a) => a.id === appId);
  if (!app) throw new Error(`okänd app ${appId}`);
  return app;
}

// ---------------------------------------------------------------- test builds

/** Runs one command in the job, streaming its output into the log. */
function exec(job: Job, cmd: string[], cwd: string): Promise<void> {
  append(job, `\n$ ${cmd.join(' ')}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => append(job, d.toString()));
    child.stderr.on('data', (d: Buffer) => append(job, d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd[0]} avslutades med kod ${code}`))));
  });
}

/**
 * A worktree of origin/<base> just for releases: never whatever happens to be
 * checked out in the main folder. Kept between runs so node_modules and build
 * caches survive; tracked files are reset to the base branch every time.
 */
async function releaseTree(team: Team, job: Job): Promise<string> {
  const path = join(team.repo, '.claude/worktrees/cr-release');
  append(job, `Hämtar origin/${team.baseBranch}…\n`);
  await run('git', ['fetch', 'origin', team.baseBranch, '--quiet'], { cwd: team.repo });
  if (!existsSync(path)) {
    setExcluded(team.repo, '/.claude/worktrees/', true);
    await run('git', ['worktree', 'add', '--detach', path, `origin/${team.baseBranch}`], { cwd: team.repo });
  } else {
    await run('git', ['checkout', '--detach', '--force', `origin/${team.baseBranch}`], { cwd: path });
  }
  const { stdout } = await run('git', ['log', '-1', '--format=%h %s'], { cwd: path });
  append(job, `Bygger från ${stdout.trim()}\n`);
  return path;
}

export function deployTest(teamId: string, appId: string): Job {
  const team = getTeam(teamId);
  if (!team) throw new Error('okänt team');
  const app = findApp(team, appId);
  const cfg = app.deploy?.test;
  if (!cfg) throw new Error(`${app.name} har ingen test-deploy i team.json`);
  const job = startJob(team.id, app.id, 'test', `${app.name}: ${cfg.label ?? 'testbuild'}`);
  if (cfg.msixVm) {
    void buildMsix(job, team, app, cfg.msixVm, cfg.msix ?? {});
    return job;
  }
  const command = cfg.run;
  if (!command) throw new Error(`${app.name}: deploy.test saknar run`);
  void (async () => {
    try {
      const tree = await releaseTree(team, job);
      const cwd = join(tree, cfg.cwd ?? '.');
      if (cfg.install) {
        // Install only when the lockfile changed since the last release.
        const lock = cfg.lockfile ? join(tree, cfg.lockfile) : null;
        const stamp = join(cwd, '.cr-install-stamp');
        const hash = lock && existsSync(lock) ? createHash('sha256').update(readFileSync(lock)).digest('hex') : 'always';
        const nodeModules = join(cwd, 'node_modules');
        if (hash === 'always' || !existsSync(nodeModules) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== hash) {
          await exec(job, cfg.install, cwd);
          writeFileSync(stamp, hash);
        } else {
          append(job, '\nBeroendena är oförändrade sedan förra releasen.\n');
        }
      }
      await exec(job, command, cwd);
      endJob(job, true, '✓ Klart. Det kan ta några minuter innan butiken har bearbetat bygget.');
    } catch (err) {
      endJob(job, false, `✗ ${(err as Error).message}`);
    }
  })();
  return job;
}

// ---------------------------------------------------------------- Windows MSIX

function sshArgs(vm: VmConfig): string[] {
  return [
    '-i', expandHome(vm.sshKey ?? '~/.ssh/id_ed25519'),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    ...(vm.sshHostKeyAlias ? ['-o', `HostKeyAlias=${vm.sshHostKeyAlias}`] : []),
  ];
}

/**
 * Builds the MSIX on the Windows VM from the base branch: desktop/ goes over
 * as a git archive (never the working copy), release.ps1 -Msix runs there,
 * and the package comes back to ~/.control-room/builds. The VM is locked for
 * the build and put back to sleep if this job woke it.
 */
async function buildMsix(job: Job, team: Team, app: StoreApp, vmId: string, opts: { source?: string; vmFolder?: string; script?: string }) {
  const source = (opts.source ?? 'desktop').replace(/\/+$/, '');
  const folder = (opts.vmFolder ?? `C:\\${team.id}`).replace(/[\\/]+$/, '');
  const script = (opts.script ?? 'windows/scripts/release.ps1').replace(/\//g, '\\');
  const remoteSource = `${folder}\\${source.replace(/\//g, '\\')}`;
  const vm = vmFor(team, vmId);
  let woke = false;
  let locked = false;
  const work = join(tmpdir(), `cr-msix-${job.id}`);
  try {
    if (!vm?.sshHost || !vm.sshUser) throw new Error(`${vmId} saknar sshHost/sshUser i team.json`);
    const holder = lockForDeploy(vmId);
    if (holder !== null) throw new Error(`${vm.name} används av kort #${holder}. Försök igen när det är klart.`);
    locked = true;
    const target = `${vm.sshUser}@${vm.sshHost}`;
    const ssh = (command: string) => exec(job, ['ssh', ...sshArgs(vm), target, command], team.repo);

    append(job, `Hämtar origin/${team.baseBranch}…\n`);
    await run('git', ['fetch', 'origin', team.baseBranch, '--quiet'], { cwd: team.repo });
    const ref = `origin/${team.baseBranch}`;
    const commit = (await run('git', ['rev-parse', '--short', ref], { cwd: team.repo })).stdout.trim();
    const subject = (await run('git', ['log', '-1', '--format=%s', ref], { cwd: team.repo })).stdout.trim();
    append(job, `Bygger från ${commit} ${subject}\n`);

    append(job, `\nVäcker ${vm.name}…\n`);
    const wake = await wakeVm(vm);
    woke = wake.woke;
    append(job, `${wake.message}\n`);

    mkdirSync(work, { recursive: true });
    const tar = join(work, 'source.tar');
    await run('git', ['archive', '--format=tar', '-o', tar, ref, source], { cwd: team.repo });

    // cmd is the VM's shell; each step its own call, since chained steps have silently done nothing.
    // Only the source folder is ours: the VM folder may also hold other things, such as a registered package layout.
    await ssh(`if exist ${remoteSource} rmdir /s /q ${remoteSource}`);
    await ssh(`if not exist ${folder} mkdir ${folder}`);
    await exec(job, ['scp', ...sshArgs(vm), '-q', tar, `${target}:${folder.replace(/\\/g, '/')}/source.tar`], team.repo);
    await ssh(`tar -xf ${folder}\\source.tar -C ${folder}`);
    const before = job.log.length;
    await ssh(`powershell -NoProfile -ExecutionPolicy Bypass -File ${remoteSource}\\${script} -Msix`);
    // The script prints the package's path: <name>-<version>-x64.msix.
    const remote = /([A-Z]:\\\S+?\\([\w.-]+?)-([\d.]+)-x64\.msix)/.exec(job.log.slice(before));
    if (!remote) throw new Error(`${basename(script.replace(/\\/g, '/'))} sa inte var paketet hamnade`);
    const [, remotePath, , version] = remote;

    const dir = msixDir(team.id, app.id);
    mkdirSync(dir, { recursive: true });
    const file = basename(remotePath.replace(/\\/g, '/'));
    const local = join(dir, file);
    await exec(job, ['scp', ...sshArgs(vm), '-q', `${target}:${remotePath.replace(/\\/g, '/')}`, local], team.repo);
    const built: BuiltMsix = { version: `${version}.0`, commit, builtAt: new Date().toISOString(), path: local };
    writeFileSync(join(dir, 'latest.json'), JSON.stringify(built, null, 2));
    endJob(job, true, `✓ ${file} (${Math.round(statSync(local).size / 1e6)} MB) är byggd från ${commit}. Till prod skickar den till Microsoft.`);
  } catch (err) {
    endJob(job, false, `✗ ${(err as Error).message}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
    if (woke && vm) {
      append(job, `Pausar ${vm.name} igen.\n`);
      await sleepVm(vm).catch(() => undefined);
    }
    if (locked) unlockDeploy(vmId);
  }
}

/** 0.1.10.0 > 0.1.9.0, part by part. */
function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

async function msState(app: StoreApp, team: Team) {
  const cfg = team.releases?.msStore;
  if (!cfg) throw new Error('releases.msStore saknas i team.local.json');
  const token = await msStoreToken(cfg);
  const info = await msStoreCall(token, 'GET', `applications/${app.productId}`);
  const lastId = info.lastPublishedApplicationSubmission?.id;
  const last = lastId ? await msStoreCall(token, 'GET', `applications/${app.productId}/submissions/${lastId}`) : null;
  const liveVersion: string | null =
    (last?.applicationPackages ?? []).map((p: any) => String(p.version)).sort((x: string, y: string) => (newer(x, y) ? -1 : 1))[0] ?? null;
  return { token, pendingId: info.pendingApplicationSubmission?.id as string | undefined, liveVersion, built: latestMsix(team.id, app.id) };
}

async function msPreview(app: StoreApp, team: Team): Promise<ProdPreview> {
  const s = await msState(app, team);
  const base = {
    app: app.name,
    store: app.store,
    version: s.built?.version ?? null,
    build: s.built?.commit ?? null,
    destination: 'Microsofts certifiering, sedan ut i Microsoft Store direkt',
    needsNotes: true,
    canRelease: false,
  };
  if (s.pendingId) return { ...base, blocked: 'Det finns redan en inskickning i Partner Center som inte är ute. Vänta på den, eller ta bort utkastet i Partner Center.' };
  if (!s.built) return { ...base, blocked: 'Det finns ingen byggd MSIX. Kör Testbuild först.' };
  if (s.liveVersion && !newer(s.built.version, s.liveVersion))
    return { ...base, blocked: `Version ${s.built.version} är inte nyare än ${s.liveVersion} i Store. Höj versionen i Package.appxmanifest och csproj och bygg igen.` };
  return { ...base, blocked: null };
}

/**
 * A new submission, cloned by Partner Center from the published one, with the
 * built package instead of the old ones and the release notes; then committed
 * to certification. A submission that fails before the commit is deleted, so
 * no half-made draft blocks the next try.
 */
async function submitMsStore(job: Job, app: StoreApp, team: Team, notes: { sv?: string; en?: string }) {
  const s = await msState(app, team);
  if (s.pendingId) throw new Error('en inskickning väntar redan i Partner Center');
  if (!s.built) throw new Error('ingen byggd MSIX');
  if (s.liveVersion && !newer(s.built.version, s.liveVersion)) throw new Error(`${s.built.version} är inte nyare än ${s.liveVersion}`);
  const base = `applications/${app.productId}/submissions`;
  const call = (method: string, path: string, body?: unknown) => msStoreCall(s.token, method, path, body);

  append(job, 'Skapar en ny inskickning…\n');
  const sub = await call('POST', base);
  let committed = false;
  const work = join(tmpdir(), `cr-msstore-${job.id}`);
  try {
    const file = basename(s.built.path);
    for (const pkg of sub.applicationPackages ?? []) pkg.fileStatus = 'PendingDelete';
    sub.applicationPackages = [...(sub.applicationPackages ?? []), { fileName: file, fileStatus: 'PendingUpload', minimumDirectXVersion: 'None', minimumSystemRam: 'None' }];
    for (const [lang, listing] of Object.entries<any>(sub.listings ?? {})) {
      const text = lang.startsWith('sv') ? (notes.sv ?? notes.en) : (notes.en ?? notes.sv);
      if (text && listing.baseListing) listing.baseListing.releaseNotes = text;
    }
    sub.targetPublishMode = 'Immediate';
    await call('PUT', `${base}/${sub.id}`, sub);

    append(job, `Laddar upp ${file}…\n`);
    mkdirSync(work, { recursive: true });
    const zip = join(work, 'package.zip');
    // The zip's entry must carry the same name as fileName above.
    const named = join(work, file);
    await run('cp', [s.built.path, named]);
    await run('zip', ['-j', '-q', zip, named]);
    const upload = await fetch(sub.fileUploadUrl, {
      method: 'PUT',
      headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/zip' },
      body: readFileSync(zip),
    });
    if (!upload.ok) throw new Error(`uppladdningen: HTTP ${upload.status} ${(await upload.text()).slice(0, 200)}`);

    append(job, 'Skickar till certifiering…\n');
    await call('POST', `${base}/${sub.id}/commit`);
    committed = true;

    // The commit is checked in the background by Microsoft; wait for it to leave CommitStarted.
    for (let i = 0; i < 40; i++) {
      const st = await call('GET', `${base}/${sub.id}/status`);
      if (st.status !== 'CommitStarted') {
        if (/Failed$/.test(st.status)) {
          const why = (st.statusDetails?.errors ?? []).map((e: any) => `${e.code}: ${e.details}`).join('; ');
          throw new Error(`Partner Center: ${st.status}${why ? ` (${why})` : ''}`);
        }
        append(job, `Läge: ${st.status}\n`);
        return;
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
    append(job, 'Partner Center tar sin tid; läget syns i Releases.\n');
  } finally {
    rmSync(work, { recursive: true, force: true });
    if (!committed) await call('DELETE', `${base}/${sub.id}`).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- App Store

const EDITABLE = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY']);
const IN_FLIGHT = new Set(['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE', 'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_APP_STORE', 'PROCESSING_FOR_DISTRIBUTION', 'ACCEPTED']);

/** What a prod submit would send, for the confirmation in the board. */
export interface ProdPreview {
  app: string;
  store: StoreApp['store'];
  version: string | null;
  build: string | null;
  destination: string;
  /** Set when a submit cannot happen now, and why. */
  blocked: string | null;
  needsNotes: boolean;
  canRelease: boolean;
}

async function appStoreState(app: StoreApp, team: Team) {
  const cfg = team.releases!.appStoreConnect!;
  const token = ascToken(cfg);
  const platform = app.platform ?? 'IOS';
  const apps = await ascCall(token, 'GET', `/apps?filter[bundleId]=${encodeURIComponent(app.bundleId!)}`);
  const appId = apps.data.find((a: any) => a.attributes.bundleId === app.bundleId)?.id;
  if (!appId) throw new Error(`hittar inte ${app.bundleId}`);
  const builds = await ascCall(
    token,
    'GET',
    `/builds?filter[app]=${appId}&filter[preReleaseVersion.platform]=${platform}&filter[processingState]=VALID&filter[expired]=false&sort=-uploadedDate&limit=1&include=preReleaseVersion`,
  );
  const build = builds.data[0];
  const marketing = builds.included?.find((i: any) => i.type === 'preReleaseVersions')?.attributes.version ?? null;
  const versions = await ascCall(token, 'GET', `/apps/${appId}/appStoreVersions?filter[platform]=${platform}&limit=10`);
  const all = versions.data as any[];
  return {
    token,
    appId,
    platform,
    build,
    marketing,
    live: all.find((v) => ['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION'].includes(v.attributes.appStoreState)),
    editable: all.find((v) => EDITABLE.has(v.attributes.appStoreState)),
    inFlight: all.find((v) => IN_FLIGHT.has(v.attributes.appStoreState)),
    pendingRelease: all.find((v) => v.attributes.appStoreState === 'PENDING_DEVELOPER_RELEASE'),
  };
}

export async function prodPreview(teamId: string, appId: string): Promise<ProdPreview> {
  const team = getTeam(teamId);
  if (!team) throw new Error('okänt team');
  const app = findApp(team, appId);
  if (app.store === 'appstore') {
    const s = await appStoreState(app, team);
    const base = { app: app.name, store: app.store, version: s.marketing, build: s.build?.attributes.version ?? null, destination: "Apples granskning, sedan App Store när du släpper den", canRelease: Boolean(s.pendingRelease) };
    if (s.pendingRelease)
      return { ...base, version: s.pendingRelease.attributes.versionString, blocked: 'Apple har godkänt en version som väntar på att du släpper den. Släpp den först, eller dra tillbaka den i App Store Connect.', needsNotes: false };
    if (s.inFlight) return { ...base, blocked: `Version ${s.inFlight.attributes.versionString} är redan hos Apple (${s.inFlight.attributes.appStoreState}).`, needsNotes: false };
    if (!s.build) return { ...base, blocked: 'Det finns ingen färdig TestFlight-build att skicka.', needsNotes: false };
    if (s.live && s.live.attributes.versionString === s.marketing)
      return { ...base, blocked: `Version ${s.marketing} är redan ute. Höj versionsnumret och gör en ny testbuild först.`, needsNotes: false };
    return { ...base, blocked: null, needsNotes: Boolean(s.live) };
  }
  if (app.store === 'play') {
    const tracks = await playTracks(app, team);
    const internal = tracks.find((t: any) => t.track === 'internal')?.releases?.[0];
    const code = internal?.versionCodes?.map(String).sort().at(-1) ?? null;
    const prodCodes: string[] = tracks.find((t: any) => t.track === 'production')?.releases?.flatMap((r: any) => r.versionCodes ?? []) ?? [];
    const base = { app: app.name, store: app.store, version: internal?.name ?? code, build: code, destination: 'Google Play produktion, till alla', canRelease: false, needsNotes: true };
    if (!code) return { ...base, blocked: 'Det finns ingen build i intern testning att promota.' };
    if (prodCodes.map(String).includes(code)) return { ...base, blocked: `Build ${code} ligger redan i produktion.` };
    return { ...base, blocked: null };
  }
  if (app.store === 'msstore') return msPreview(app, team);
  return { app: app.name, store: app.store, version: null, build: null, destination: '', blocked: `${app.name} släpps manuellt i butiken.`, needsNotes: false, canRelease: false };
}

/** Submits the newest valid build for review: the same version again, or a new one. */
async function submitAppStore(job: Job, app: StoreApp, team: Team, notes: { sv?: string; en?: string }) {
  const s = await appStoreState(app, team);
  if (s.inFlight || s.pendingRelease) throw new Error('en version är redan hos Apple');
  if (!s.build) throw new Error('ingen färdig TestFlight-build');
  const call = (method: string, path: string, body?: unknown) => ascCall(s.token, method, path, body);

  let version = s.editable;
  if (version && version.attributes.versionString !== s.marketing) {
    append(job, `Byter version ${version.attributes.versionString} till ${s.marketing}…\n`);
    await call('PATCH', `/appStoreVersions/${version.id}`, { data: { type: 'appStoreVersions', id: version.id, attributes: { versionString: s.marketing } } });
  }
  if (!version) {
    append(job, `Skapar version ${s.marketing}…\n`);
    const created = await call('POST', '/appStoreVersions', {
      data: {
        type: 'appStoreVersions',
        // Manual release: Apple approves, the owner decides when it goes out.
        attributes: { platform: s.platform, versionString: s.marketing, releaseType: 'MANUAL' },
        relationships: { app: { data: { type: 'apps', id: s.appId } } },
      },
    });
    version = created.data;
  }

  append(job, `Kopplar build ${s.build.attributes.version}…\n`);
  await call('PATCH', `/appStoreVersions/${version.id}/relationships/build`, { data: { type: 'builds', id: s.build.id } });

  if (s.live && (notes.sv || notes.en)) {
    const locs = await call('GET', `/appStoreVersions/${version.id}/appStoreVersionLocalizations`);
    for (const loc of locs.data as any[]) {
      const lang: string = loc.attributes.locale;
      const text = lang.startsWith('sv') ? (notes.sv ?? notes.en) : (notes.en ?? notes.sv);
      if (!text) continue;
      append(job, `Nyheter (${lang})…\n`);
      await call('PATCH', `/appStoreVersionLocalizations/${loc.id}`, { data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: { whatsNew: text } } });
    }
  }

  append(job, 'Skickar till granskning…\n');
  const submission = await call('POST', '/reviewSubmissions', {
    data: { type: 'reviewSubmissions', attributes: { platform: s.platform }, relationships: { app: { data: { type: 'apps', id: s.appId } } } },
  });
  await call('POST', '/reviewSubmissionItems', {
    data: {
      type: 'reviewSubmissionItems',
      relationships: {
        reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.data.id } },
        appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
      },
    },
  });
  await call('PATCH', `/reviewSubmissions/${submission.data.id}`, {
    data: { type: 'reviewSubmissions', id: submission.data.id, attributes: { submitted: true } },
  });
}

/** Releases a version Apple has approved and that waits for a manual release. */
export function releaseApproved(teamId: string, appId: string): Job {
  const team = getTeam(teamId);
  if (!team) throw new Error('okänt team');
  const app = findApp(team, appId);
  if (app.store !== 'appstore') throw new Error('bara App Store har manuell release');
  const job = startJob(team.id, app.id, 'release', `${app.name}: släpp till App Store`);
  void (async () => {
    try {
      const s = await appStoreState(app, team);
      if (!s.pendingRelease) throw new Error('ingen godkänd version väntar på att släppas');
      await ascCall(s.token, 'POST', '/appStoreVersionReleaseRequests', {
        data: { type: 'appStoreVersionReleaseRequests', relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: s.pendingRelease.id } } } },
      });
      endJob(job, true, `✓ Version ${s.pendingRelease.attributes.versionString} släpps nu i App Store.`);
    } catch (err) {
      endJob(job, false, `✗ ${(err as Error).message}`);
    }
  })();
  return job;
}

// ---------------------------------------------------------------- Play

async function playTracks(app: StoreApp, team: Team): Promise<any[]> {
  const token = await playToken(team.releases!.play!);
  const edit = await playCall(token, app.packageName!, 'POST', '/edits');
  try {
    return (await playCall(token, app.packageName!, 'GET', `/edits/${edit.id}/tracks`)).tracks ?? [];
  } finally {
    await playCall(token, app.packageName!, 'DELETE', `/edits/${edit.id}`).catch(() => undefined);
  }
}

/** The build in internal testing goes to production, for everyone, with release notes. */
async function promotePlay(job: Job, app: StoreApp, team: Team, notes: { sv?: string; en?: string }) {
  const token = await playToken(team.releases!.play!);
  const call = (method: string, path: string, body?: unknown) => playCall(token, app.packageName!, method, path, body);
  const edit = await call('POST', '/edits');
  let committed = false;
  try {
    const internal = (await call('GET', `/edits/${edit.id}/tracks/internal`)).releases?.[0];
    if (!internal?.versionCodes?.length) throw new Error('ingen build i intern testning');
    const releaseNotes = [
      notes.sv && { language: 'sv-SE', text: notes.sv },
      notes.en && { language: 'en-US', text: notes.en },
    ].filter(Boolean);
    append(job, `Promotar ${internal.versionCodes.join(', ')} till produktion…\n`);
    await call('PUT', `/edits/${edit.id}/tracks/production`, {
      track: 'production',
      releases: [{ name: internal.name, versionCodes: internal.versionCodes, status: 'completed', releaseNotes }],
    });
    await call('POST', `/edits/${edit.id}:commit`);
    committed = true;
  } finally {
    if (!committed) await call('DELETE', `/edits/${edit.id}`).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- prod entry

export function deployProd(teamId: string, appId: string, notes: { sv?: string; en?: string }): Job {
  const team = getTeam(teamId);
  if (!team) throw new Error('okänt team');
  const app = findApp(team, appId);
  if (app.store === 'manual') throw new Error(`${app.name} släpps manuellt i butiken`);
  const where = { appstore: 'till Apples granskning', play: 'till Play produktion', msstore: 'till Microsoft Store' }[app.store];
  const job = startJob(team.id, app.id, 'prod', `${app.name}: ${where}`);
  void (async () => {
    try {
      if (app.store === 'msstore') {
        await submitMsStore(job, app, team, notes);
        endJob(job, true, '✓ Skickad till Microsoft. Certifieringen tar oftast några timmar till ett dygn, sedan går den ut direkt.');
      } else if (app.store === 'appstore') {
        await submitAppStore(job, app, team, notes);
        endJob(job, true, '✓ Skickad till granskning. Du släpper den här när Apple har godkänt den.');
      } else {
        await promotePlay(job, app, team, notes);
        endJob(job, true, '✓ Ute i produktion. Google granskar och publicerar, oftast inom några timmar.');
      }
    } catch (err) {
      endJob(job, false, `✗ ${(err as Error).message}`);
    }
  })();
  return job;
}
