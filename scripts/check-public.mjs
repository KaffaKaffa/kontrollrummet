#!/usr/bin/env node
// Letar efter det som inte får hamna i det publika repot innan en ändring går dit:
// namn på personer, kunder och projekt, e-postadresser, hemmappar, interna adresser,
// nycklar och tokens, och stora binärfiler.
//
//   node scripts/check-public.mjs [bas] [--text fil …]
//
// bas: det som ändringen jämförs med (standard: public/main, annars origin/main).
// Allt som lagts till sedan basen granskas: rader, filnamn och commit-meddelanden.
// --text granskar också en fil, till exempel PR-beskrivningen innan den skickas.
//
// Orden att leta efter hämtas från den här datorns egna projekt (teams/*, som aldrig
// är med i git) och ~/.control-room/accounts.json, så inga namn står i skriptet.
// Slutar med kod 1 och en lista om något hittas.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const args = process.argv.slice(2);
const texts = [];
for (let i = args.indexOf('--text'); i >= 0; i = args.indexOf('--text')) {
  texts.push(args[i + 1]);
  args.splice(i, 2);
}
const base =
  args[0] ??
  ['public/main', 'origin/main'].find((ref) => {
    try {
      git('rev-parse', '--verify', '--quiet', ref);
      return true;
    } catch {
      return false;
    }
  });
if (!base) throw new Error('Ange en bas, till exempel origin/main.');
const from = git('merge-base', base, 'HEAD').trim();

// ------------------------------------------------------------ what to look for

/** Lowercase words and phrases that are private on this machine. */
const words = new Set();
const add = (value, { parts = false } = {}) => {
  const v = String(value ?? '').trim();
  if (v.length < 3) return;
  words.add(v.toLowerCase());
  if (v.includes('@')) {
    // An address: the whole of it, and the part before @ when it is a name (first.last).
    const local = v.split('@')[0].toLowerCase();
    if (local.includes('.') || local.length >= 6) words.add(local);
    return;
  }
  // A person's surname (and longer first names) alone: a surname in a comment is as bad as the whole name.
  if (parts) for (const p of v.split(/[\s._-]+/)) if (p.length >= 4) words.add(p.toLowerCase());
};
const read = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const teamsDir = join(root, 'teams');
for (const dir of existsSync(teamsDir) ? readdirSync(teamsDir, { withFileTypes: true }) : []) {
  if (!dir.isDirectory()) continue;
  add(dir.name);
  for (const file of ['team.json', 'team.local.json']) {
    const t = read(join(teamsDir, dir.name, file));
    if (!t) continue;
    add(t.name);
    add(t.owner, { parts: true });
    add(t.handoff?.name, { parts: true });
    for (const r of [t.reviewer ?? []].flat()) add(r, { parts: true });
    for (const p of t.people ?? []) {
      add(p.name, { parts: true });
      for (const a of [p.account ?? []].flat()) add(a, { parts: true });
    }
    for (const path of [t.repo, ...Object.values(t.repos ?? {})].filter(Boolean)) add(basename(String(path)));
  }
  // What the owner named the agents and consultants.
  for (const sub of ['roles', 'consultants']) {
    const d = join(teamsDir, dir.name, sub);
    for (const f of existsSync(d) ? readdirSync(d).filter((x) => x.endsWith('.md')) : [])
      add(/^nick:\s*(.+)$/m.exec(readFileSync(join(d, f), 'utf8'))?.[1]);
  }
}
const accounts = read(join(process.env.CONTROL_ROOM_DATA ?? join(homedir(), '.control-room'), 'accounts.json'));
for (const a of Object.values(accounts?.accounts ?? {})) {
  add(a?.email, { parts: true });
  add(a?.name, { parts: true });
}
for (const key of ['user.name', 'user.email']) {
  try {
    add(git('config', key).trim(), { parts: true });
  } catch {
    // Not set.
  }
}
// Words that would match all over the code: account labels and project folders named like ordinary words.
for (const common of ['privat', 'private', 'personal', 'jobb', 'work', 'github', 'gitlab', 'azure', 'back', 'nick', 'test', 'team', 'name', 'user', 'web', 'admin', 'store', 'portal', 'common', 'common-agents', 'main', 'mobile', 'native', 'desktop', 'backend', 'frontend', 'app', 'apps', 'users'])
  words.delete(common);

/** Shapes that are private whatever the name. */
const PATTERNS = [
  [/[\w.+-]+@(?!example\.(com|org|net)\b)(?!users\.noreply\.github\.com\b)[\w-]+(\.[\w-]+)+/i, 'e-postadress'],
  [/\/Users\/(?!(name|you|du|dig|me|user)\b)[\w.-]+/, 'hemmapp'],
  [/C:\\Users\\(?!(name|you|du|user)\b)[\w.-]+/i, 'hemmapp'],
  [/dev\.azure\.com\/(?!(org|organisation|organization|din-org|<)\b)[\w-]+/i, 'Azure-organisation'],
  [/\b[\w-]+\.visualstudio\.com\b/i, 'Azure-organisation'],
  // Keys and tokens: a real one in a public repo is leaked the moment it is pushed.
  [/\bsk-(proj-|ant-)?[A-Za-z0-9_-]{20,}/, 'API-nyckel'],
  [/\bxai-[A-Za-z0-9]{20,}/, 'API-nyckel'],
  [/\bAIza[0-9A-Za-z_-]{30,}/, 'API-nyckel'],
  [/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/, 'GitHub-token'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/, 'AWS-nyckel'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack-token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'privat nyckel'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/\b(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(\.\d{1,3})?\b/, 'internt IP-nummer'],
];

const list = [...words].sort((a, b) => b.length - a.length);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = list.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${list.map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'iu') : null;

// ------------------------------------------------------------ looking

const hits = [];
const check = (where, line) => {
  const w = wordRe?.exec(line);
  if (w) hits.push(`${where}: "${w[1]}" i: ${line.trim().slice(0, 160)}`);
  for (const [re, what] of PATTERNS) {
    const m = re.exec(line);
    if (m) hits.push(`${where}: ${what} "${m[0]}" i: ${line.trim().slice(0, 160)}`);
  }
};

// Added lines, by file and line number in the new version.
let file = '';
let at = 0;
for (const line of git('diff', '--unified=0', '--no-color', '--no-ext-diff', `${from}..HEAD`).split('\n')) {
  if (line.startsWith('+++ ')) {
    file = line.slice(6);
    check(`filnamn ${file}`, file);
  } else if (line.startsWith('@@')) at = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
  else if (line.startsWith('+')) check(`${file}:${at++}`, line.slice(1));
}
// Big binaries do not belong in git, public or not.
for (const line of git('diff', '--numstat', `${from}..HEAD`).split('\n')) {
  const [added, , name] = line.split('\t');
  if (added === '-' && name && existsSync(join(root, name))) {
    const size = readFileSync(join(root, name)).length;
    if (size > 5 * 1024 * 1024) hits.push(`${name}: binärfil på ${(size / 1024 / 1024).toFixed(1)} MB (över 5 MB)`);
  }
}
for (const c of git('log', '--format=%h%x00%B%x01', `${from}..HEAD`).split('\x01')) {
  const [sha, body = ''] = c.trim().split('\0');
  if (sha) for (const line of body.split('\n')) check(`commit ${sha}`, line);
}
for (const t of texts) readFileSync(t, 'utf8').split('\n').forEach((line, i) => check(`${t}:${i + 1}`, line));

console.log(`Granskat ${from.slice(0, 8)}..HEAD${texts.length ? ` och ${texts.join(', ')}` : ''} mot ${words.size} privata ord och ${PATTERNS.length} mönster.`);
if (hits.length) {
  console.log(`\n${hits.length} träffar. Ta bort eller anonymisera innan något går till det publika repot:\n`);
  for (const h of [...new Set(hits)]) console.log(`- ${h}`);
  process.exit(1);
}
console.log('Inget privat hittat.');
