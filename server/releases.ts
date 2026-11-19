import { createSign } from 'node:crypto';
import { execFile } from './proc.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR, expandHome } from './config.ts';
import { getTeam, type Team } from './roles.ts';
import { readSecretAsync } from './secrets.ts';

const run = promisify(execFile);

/**
 * Which version of each store app is out for testers and which for everyone.
 * Read straight from App Store Connect and Google Play with the keys the team's
 * release scripts already use; the team's team.json says where they are.
 */

export interface StoreApp {
  id: string;
  name: string;
  store: 'appstore' | 'play' | 'msstore' | 'manual';
  /** Microsoft Store: the product id (9N…), read from the public catalogue. */
  productId?: string;
  /** App Store: bundle id and platform (IOS, MAC_OS). */
  bundleId?: string;
  platform?: 'IOS' | 'MAC_OS';
  /** Play: package name. */
  packageName?: string;
  /** Manual stores: a file in the repo holding the version, and where the store is. */
  versionFile?: string;
  versionPattern?: string;
  url?: string;
  /** What the deploy buttons do. Prod for App Store and Play goes through their APIs. */
  deploy?: {
    test?: {
      label?: string;
      /** Folder in the repo to run in. */
      cwd?: string;
      run?: string[];
      /**
       * Windows: build the MSIX on this VM (a key in the team's vms) instead
       * of running a command here. desktop/ goes over as a git archive.
       */
      msixVm?: string;
      /**
       * The MSIX build on the VM: the repo folder that goes over (default
       * "desktop"), the VM folder it lands in (default C:\<team id>), and the
       * script inside it that builds the package and prints where it went.
       */
      msix?: { source?: string; vmFolder?: string; script?: string };
      /** Run first when the lockfile changed since the last release. */
      install?: string[];
      lockfile?: string;
    };
    prod?: boolean;
  };
}

export interface ReleaseConfig {
  apps: StoreApp[];
  appStoreConnect?: { keyId: string; issuerId: string; keyPath: string };
  play?: { keychainService: string };
  /** Partner Center: a keychain entry holding {tenantId, clientId, clientSecret} of an Entra app. */
  msStore?: { keychainService: string };
}

export interface Channel {
  label: string;
  version: string | null;
  build: string | null;
  state: string | null;
  /** Readable state, in Swedish. */
  stateText: string | null;
  at: string | null;
}

export interface AppReleases {
  id: string;
  name: string;
  store: StoreApp['store'];
  test: Channel | null;
  prod: Channel | null;
  /** Something on its way: in review, waiting for release, a staged rollout. */
  pending: Channel | null;
  url: string | null;
  /** The app's public page in its store, once it is out. */
  storeUrl: string | null;
  error: string | null;
  canTest: boolean;
  canProd: boolean;
}

export interface TeamReleases {
  team: string;
  apps: AppReleases[];
  checkedAt: string;
}

// ---------------------------------------------------------------- App Store Connect

const ASC = 'https://api.appstoreconnect.apple.com/v1';

/** A 20-minute ES256 token, as App Store Connect wants it. */
export function ascToken(cfg: NonNullable<ReleaseConfig['appStoreConnect']>): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'ES256', kid: cfg.keyId, typ: 'JWT' })}.${b64({
    iss: cfg.issuerId,
    iat: now,
    exp: now + 1200,
    aud: 'appstoreconnect-v1',
  })}`;
  const key = readFileSync(expandHome(cfg.keyPath), 'utf8');
  const sig = createSign('SHA256').update(unsigned).sign({ key, dsaEncoding: 'ieee-p1363' }, 'base64url');
  return `${unsigned}.${sig}`;
}

export async function ascCall(token: string, method: string, path: string, payload?: unknown): Promise<any> {
  const res = await fetch(`${ASC}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const body = res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as any);
  if (!res.ok) throw new Error(`App Store Connect: ${body.errors?.map((e: any) => e.detail ?? e.title).join('; ') ?? res.status}`);
  return body;
}

const asc = (token: string, path: string) => ascCall(token, 'GET', path);

const APP_STORE_STATE: Record<string, string> = {
  READY_FOR_SALE: 'Ute i App Store',
  READY_FOR_DISTRIBUTION: 'Ute i App Store',
  PREPARE_FOR_SUBMISSION: 'Förbereds',
  WAITING_FOR_REVIEW: 'Väntar på granskning',
  IN_REVIEW: 'Granskas',
  PENDING_DEVELOPER_RELEASE: 'Godkänd, väntar på att du släpper',
  PENDING_APPLE_RELEASE: 'Godkänd, släpps av Apple',
  PROCESSING_FOR_APP_STORE: 'Bearbetas för App Store',
  PROCESSING_FOR_DISTRIBUTION: 'Bearbetas för App Store',
  REJECTED: 'Nekad',
  METADATA_REJECTED: 'Metadata nekad',
  DEVELOPER_REJECTED: 'Tillbakadragen',
  INVALID_BINARY: 'Ogiltig build',
  REMOVED_FROM_SALE: 'Borttagen',
  ACCEPTED: 'Godkänd',
};

const LIVE = new Set(['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION']);
const DONE = new Set([...LIVE, 'REMOVED_FROM_SALE', 'DEVELOPER_REMOVED_FROM_SALE', 'REPLACED_WITH_NEW_VERSION']);

const BUILD_STATE: Record<string, string> = {
  PROCESSING: 'Bearbetas',
  VALID: 'Redo i TestFlight',
  INVALID: 'Ogiltig',
  FAILED: 'Misslyckades',
};

async function appStore(app: StoreApp, cfg: ReleaseConfig): Promise<Omit<AppReleases, 'id' | 'name' | 'store' | 'error' | 'canTest' | 'canProd'>> {
  if (!cfg.appStoreConnect) throw new Error('appStoreConnect saknas i team.json');
  const token = ascToken(cfg.appStoreConnect);
  const apps = await asc(token, `/apps?filter[bundleId]=${encodeURIComponent(app.bundleId!)}&fields[apps]=bundleId,name`);
  const found = apps.data.find((a: any) => a.attributes.bundleId === app.bundleId);
  if (!found) throw new Error(`hittar inte ${app.bundleId} i App Store Connect`);
  const platform = app.platform ?? 'IOS';

  const builds = await asc(
    token,
    `/builds?filter[app]=${found.id}&filter[preReleaseVersion.platform]=${platform}&sort=-uploadedDate&limit=1` +
      `&include=preReleaseVersion&fields[builds]=version,uploadedDate,processingState,expired&fields[preReleaseVersions]=version`,
  );
  const build = builds.data[0];
  const pre = build && builds.included?.find((i: any) => i.type === 'preReleaseVersions');
  const test: Channel | null = build
    ? {
        label: 'TestFlight',
        version: pre?.attributes.version ?? null,
        build: build.attributes.version,
        state: build.attributes.expired ? 'EXPIRED' : build.attributes.processingState,
        stateText: build.attributes.expired ? 'Utgången' : (BUILD_STATE[build.attributes.processingState] ?? build.attributes.processingState),
        at: build.attributes.uploadedDate,
      }
    : null;

  const versions = await asc(
    token,
    `/apps/${found.id}/appStoreVersions?filter[platform]=${platform}&limit=6&include=build` +
      `&fields[appStoreVersions]=versionString,appStoreState,createdDate,build&fields[builds]=version`,
  );
  const toChannel = (v: any, label: string): Channel => {
    const buildId = v.relationships?.build?.data?.id;
    const b = versions.included?.find((i: any) => i.type === 'builds' && i.id === buildId);
    return {
      label,
      version: v.attributes.versionString,
      build: b?.attributes.version ?? null,
      state: v.attributes.appStoreState,
      stateText: APP_STORE_STATE[v.attributes.appStoreState] ?? v.attributes.appStoreState,
      at: v.attributes.createdDate,
    };
  };
  const live = versions.data.find((v: any) => LIVE.has(v.attributes.appStoreState));
  const coming = versions.data.find((v: any) => !DONE.has(v.attributes.appStoreState));
  return {
    test,
    prod: live ? toChannel(live, 'App Store') : null,
    pending: coming ? toChannel(coming, 'På väg') : null,
    url: `https://appstoreconnect.apple.com/apps/${found.id}/distribution`,
    storeUrl: live ? `https://apps.apple.com/se/app/id${found.id}` : null,
  };
}

// ---------------------------------------------------------------- Google Play

export async function playCall(token: string, packageName: string, method: string, path: string, payload?: unknown): Promise<any> {
  const res = await fetch(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const body = res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as any);
  if (!res.ok) throw new Error(`Google Play: ${body.error?.message ?? res.status}`);
  return body;
}

async function secretOrThrow(service: string): Promise<string> {
  const value = await readSecretAsync(service);
  if (!value) throw new Error(`ingen hemlighet sparad som ${service}`);
  return value;
}

export async function playToken(cfg: NonNullable<ReleaseConfig['play']>): Promise<string> {
  const stdout = await secretOrThrow(cfg.keychainService);
  const key = JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8')) as { client_email: string; private_key: string };
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url')}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const body = (await res.json()) as { access_token?: string; error_description?: string };
  if (!body.access_token) throw new Error(`Google: ${body.error_description ?? res.status}`);
  return body.access_token;
}

const PLAY_STATUS: Record<string, string> = {
  completed: 'Ute',
  inProgress: 'Stegvis utrullning',
  halted: 'Pausad',
  draft: 'Utkast',
};

async function play(app: StoreApp, cfg: ReleaseConfig): Promise<Omit<AppReleases, 'id' | 'name' | 'store' | 'error' | 'canTest' | 'canProd'>> {
  if (!cfg.play) throw new Error('play saknas i team.json');
  const token = await playToken(cfg.play);
  const api = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${app.packageName}`;
  const call = async (method: string, path: string) => {
    const res = await fetch(`${api}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
    const body = res.status === 204 ? {} : ((await res.json()) as any);
    if (!res.ok) throw new Error(`Google Play: ${body.error?.message ?? res.status}`);
    return body;
  };
  // Reading tracks needs an edit; it is thrown away, nothing is changed.
  const edit = await call('POST', '/edits');
  try {
    const { tracks = [] } = await call('GET', `/edits/${edit.id}/tracks`);
    const channel = (name: string, label: string, pick: (r: any) => boolean = () => true): Channel | null => {
      const release = tracks.find((t: any) => t.track === name)?.releases?.find(pick);
      if (!release) return null;
      const codes: string[] = release.versionCodes ?? [];
      return {
        label,
        version: release.name ?? null,
        build: codes.length ? codes.map(String).sort().at(-1)! : null,
        state: release.status,
        stateText: PLAY_STATUS[release.status] ?? release.status,
        at: null,
      };
    };
    return {
      test: channel('internal', 'Intern testning'),
      prod: channel('production', 'Play', (r) => r.status === 'completed'),
      pending:
        channel('production', 'På väg', (r) => r.status !== 'completed') ??
        channel('beta', 'Öppen testning') ??
        channel('alpha', 'Sluten testning'),
      url: `https://play.google.com/console/u/0/developers`,
      storeUrl: tracks.some((t: any) => t.track === 'production' && t.releases?.some((r: any) => r.status === 'completed'))
        ? `https://play.google.com/store/apps/details?id=${app.packageName}`
        : null,
    };
  } finally {
    await call('DELETE', `/edits/${edit.id}`).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- manual stores

async function manual(app: StoreApp, team: Team): Promise<Omit<AppReleases, 'id' | 'name' | 'store' | 'error' | 'canTest' | 'canProd'>> {
  let version: string | null = null;
  if (app.versionFile) {
    // The version on the base branch: what the next store build will carry.
    const { stdout } = await run('git', ['show', `origin/${team.baseBranch}:${app.versionFile}`], { cwd: team.repo });
    const m = new RegExp(app.versionPattern ?? 'Version="([^"]+)"').exec(stdout);
    version = m?.[1] ?? null;
  }
  return {
    test: version ? { label: `I ${team.baseBranch}`, version, build: null, state: null, stateText: 'Nästa build', at: null } : null,
    prod: null,
    pending: null,
    url: app.url ?? null,
    storeUrl: null,
  };
}

// ---------------------------------------------------------------- Microsoft Store

/**
 * What the Store publishes, from Microsoft's public product catalogue: no key
 * needed. Partner Center's own API would need an Entra app tied to it.
 */
// ---------------------------------------------------------------- Partner Center

export interface BuiltMsix {
  version: string;
  commit: string;
  builtAt: string;
  path: string;
}

export const msixDir = (teamId: string, appId: string) => join(DATA_DIR, 'builds', teamId, appId);

/** The newest package the test button built, if it is still on disk. */
export function latestMsix(teamId: string, appId: string): BuiltMsix | null {
  const meta = join(msixDir(teamId, appId), 'latest.json');
  if (!existsSync(meta)) return null;
  try {
    const built = JSON.parse(readFileSync(meta, 'utf8')) as BuiltMsix;
    return existsSync(built.path) ? built : null;
  } catch {
    return null;
  }
}

const DEVCENTER = 'https://manage.devcenter.microsoft.com/v1.0/my';
let msToken: { value: string; until: number } | null = null;

export async function msStoreToken(cfg: NonNullable<ReleaseConfig['msStore']>): Promise<string> {
  if (msToken && msToken.until > Date.now()) return msToken.value;
  const stdout = await secretOrThrow(cfg.keychainService);
  const key = JSON.parse(stdout.trim()) as { tenantId: string; clientId: string; clientSecret: string };
  const res = await fetch(`https://login.microsoftonline.com/${key.tenantId}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: key.clientId,
      client_secret: key.clientSecret,
      resource: 'https://manage.devcenter.microsoft.com',
    }),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: string; error_description?: string };
  if (!body.access_token) throw new Error(`Entra: ${body.error_description?.split('\n')[0] ?? res.status}`);
  msToken = { value: body.access_token, until: Date.now() + (Number(body.expires_in ?? 3600) - 300) * 1000 };
  return body.access_token;
}

export async function msStoreCall(token: string, method: string, path: string, payload?: unknown): Promise<any> {
  const res = await fetch(`${DEVCENTER}/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`Partner Center ${res.status}: ${body?.message ?? body?.code ?? text.slice(0, 200)}`);
  return body;
}

const MS_STATUS: Record<string, string> = {
  PendingCommit: 'Utkast i Partner Center',
  CommitStarted: 'Skickas in',
  PreProcessing: 'Förbehandlas',
  Certification: 'Certifieras hos Microsoft',
  Release: 'Publiceras',
  Publishing: 'Publiceras',
  CommitFailed: 'Inskickningen misslyckades',
  PreProcessingFailed: 'Förbehandlingen misslyckades',
  CertificationFailed: 'Underkänd i certifieringen',
  ReleaseFailed: 'Publiceringen misslyckades',
};

/** The submission on its way, if any: what Partner Center has that is not out yet. */
async function msPending(app: StoreApp, cfg: NonNullable<ReleaseConfig['msStore']>): Promise<Channel | null> {
  const token = await msStoreToken(cfg);
  const info = await msStoreCall(token, 'GET', `applications/${app.productId}`);
  const id = info.pendingApplicationSubmission?.id;
  if (!id) return null;
  const sub = await msStoreCall(token, 'GET', `applications/${app.productId}/submissions/${id}`);
  const pkg = (sub.applicationPackages ?? []).find((p: any) => p.fileStatus !== 'PendingDelete');
  return {
    label: 'Partner Center',
    version: pkg?.version ?? null,
    build: null,
    state: sub.status ?? null,
    stateText: MS_STATUS[sub.status] ?? sub.status ?? null,
    at: null,
  };
}

async function msStore(app: StoreApp, team: Team): Promise<Omit<AppReleases, 'id' | 'name' | 'store' | 'error' | 'canTest' | 'canProd'>> {
  const next = await manual(app, team);
  const res = await fetch(`https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${app.productId}&market=SE&languages=sv-SE`);
  const body = (await res.json()) as any;
  const sku = body.Products?.[0]?.DisplaySkuAvailabilities?.[0]?.Sku;
  const pkg: string | undefined = sku?.Properties?.Packages?.[0]?.PackageFullName;
  const version = pkg?.split('_')[1] ?? null;
  const prod: Channel | null = version
    ? { label: 'Microsoft Store', version, build: null, state: 'completed', stateText: 'Ute i Microsoft Store', at: sku?.LastModifiedDate ?? null }
    : null;
  const cfg = team.releases?.msStore;
  const pending = cfg ? await msPending(app, cfg) : null;
  // A package built by the test button comes first; otherwise the base branch,
  // which only counts as "on its way" when it is ahead of the Store.
  const built = latestMsix(team.id, app.id);
  const ahead = next.test && version && next.test.version !== version;
  const test: Channel | null = built
    ? { label: 'Byggd MSIX', version: built.version, build: built.commit, state: 'built', stateText: 'Redo att skickas till Store', at: built.builtAt }
    : ahead
      ? next.test
      : null;
  return {
    test,
    prod,
    pending,
    url: app.url ?? null,
    storeUrl: version ? `https://apps.microsoft.com/detail/${app.productId}` : null,
  };
}

// ---------------------------------------------------------------- per team, cached

const cache = new Map<string, TeamReleases>();

/** After a deploy the cached versions are stale. */
export function invalidateReleases(teamId: string) {
  cache.delete(teamId);
}
const CACHE_MS = 5 * 60 * 1000;

export async function getReleases(teamId: string, force = false): Promise<TeamReleases | null> {
  const team = getTeam(teamId);
  if (!team?.releases) return null;
  const hit = cache.get(teamId);
  if (hit && !force && Date.now() - Date.parse(hit.checkedAt) < CACHE_MS) return hit;
  const cfg = team.releases;
  const apps = await Promise.all(
    cfg.apps.map(async (app): Promise<AppReleases> => {
      const base = { id: app.id, name: app.name, store: app.store, canTest: Boolean(app.deploy?.test), canProd: Boolean(app.deploy?.prod) && (app.store === 'appstore' || app.store === 'play' || app.store === 'msstore') };
      try {
        const data =
          app.store === 'appstore'
            ? await appStore(app, cfg)
            : app.store === 'play'
              ? await play(app, cfg)
              : app.store === 'msstore'
                ? await msStore(app, team)
                : await manual(app, team);
        return { ...base, ...data, error: null };
      } catch (err) {
        return { ...base, test: null, prod: null, pending: null, url: app.url ?? null, storeUrl: null, error: (err as Error).message };
      }
    }),
  );
  const result = { team: teamId, apps, checkedAt: new Date().toISOString() };
  cache.set(teamId, result);
  return result;
}
