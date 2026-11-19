// Porträtt och 3D-förlagor till rollerna, genererade med OpenAI:s bild-API.
//
//   node scripts/avatars.mjs                  porträtt som saknas (biblioteket och teamens egna roller)
//   node scripts/avatars.mjs --force          gör om dem, även de som finns
//   node scripts/avatars.mjs tester ios       bara de här rollerna
//   node scripts/avatars.mjs --body           helkroppsbild i A-pose per mall, förlaga till 3D-gubben
//   node scripts/avatars.mjs --sync           kopiera bibliotekets porträtt till teamens roller med samma gubbe
//   node scripts/avatars.mjs --prompts        skriv bara ut promptarna
//
// Gubbarna finns i biblioteket (library/roles), en per mall:
//   library/avatars/<id>.png            porträttet (384 px)
//   library/characters/<id>/body.png    hela kroppen, förlagan till 3D-modellen
// En teamroll använder mallen med samma id, eller den som står i `character:`.
// Roller utan mall får ett eget porträtt i web/public/avatars/<team>-<id>.png.
//
// Utseendet står i rollens `look:` och personligheten i `vibe:`. Promptarna
// innehåller inget om projektet eller om verkliga personer. Kräver
// OPENAI_API_KEY (finns i nyckelringen som control-room-openai).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const teamAvatars = join(root, 'web/public/avatars');
const libAvatars = join(root, 'library/avatars');
const libCharacters = join(root, 'library/characters');
const model = process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2';
const args = process.argv.slice(2);
const force = args.includes('--force');
const printOnly = args.includes('--prompts');
const body = args.includes('--body');
const sync = args.includes('--sync');
const only = args.filter((a) => !a.startsWith('--'));

const key =
  process.env.OPENAI_API_KEY ??
  (() => {
    try {
      return execFileSync('security', ['find-generic-password', '-s', 'control-room-openai', '-w'], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  })();

const PORTRAIT =
  'Playful, warm 3D clay figurine portrait, chest up, centered, facing the viewer with a big friendly grin. ' +
  'Exaggerated, affectionate office-sitcom character, a little absurd. Soft studio light, rounded shapes, ' +
  'saturated but tasteful colours. Plain soft pastel background in one flat colour. No text, no logos, no brand marks.';

const BODY =
  'Full-body 3D clay figurine of exactly the same character as in the reference image: same face, hair, skin tone, ' +
  'build and clothes, in the same playful clay style. Standing in a neutral A-pose: arms straight and angled about ' +
  '30 degrees away from the body, palms facing down, legs slightly apart, feet flat. Facing the camera straight on, ' +
  'the whole figure visible from the top of the head to the shoes, centered with margin around it. Hands empty, ' +
  'nothing held, nothing on the ground. Plain light grey background, even soft lighting with minimal shadows. ' +
  'No text, no logos, no brand marks.';

function frontMatter(path) {
  const src = readFileSync(path, 'utf8');
  return Object.fromEntries(
    (/^---\n([\s\S]*?)\n---/.exec(src)?.[1] ?? '')
      .split('\n')
      .filter((l) => l.includes(':'))
      .map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]),
  );
}

/** The library's characters: one per template. */
function templates() {
  const dir = join(root, 'library/roles');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const m = frontMatter(join(dir, f));
      return { id: f.slice(0, -3), title: m.title ?? '', vibe: m.vibe ?? '', look: m.look ?? '' };
    });
}

/** Every team role, and the template character it is drawn as, if any. */
function teamRoles(lib) {
  const ids = new Set(lib.map((t) => t.id));
  const list = [];
  for (const team of readdirSync(join(root, 'teams'))) {
    const dir = join(root, 'teams', team, 'roles');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const m = frontMatter(join(dir, f));
      const id = f.slice(0, -3);
      const character = m.character || (ids.has(id) ? id : '');
      list.push({ team, id, character, title: m.title ?? '', vibe: m.vibe ?? '', look: m.look ?? '' });
    }
  }
  return list;
}

const portraitPrompt = (r) => `${PORTRAIT}\n\nThe character works on a software team (role, in Swedish: "${r.title}"). Looks: ${r.look} Personality, in Swedish: ${r.vibe}`;
const bodyPrompt = (r) => `${BODY}\n\nThe character: ${r.look}`;

async function generate(prompt, size) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, size, n: 1 }),
  });
  const data = await res.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
  return Buffer.from(b64, 'base64');
}

/** A new image from a prompt and a reference image, so the character stays the same. */
async function edit(prompt, reference, size) {
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('size', size);
  form.append('image[]', new Blob([readFileSync(reference)], { type: 'image/png' }), 'reference.png');
  const res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form });
  const data = await res.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
  return Buffer.from(b64, 'base64');
}

const want = (id) => !only.length || only.includes(id);
const lib = templates();
const roles = teamRoles(lib);
mkdirSync(libAvatars, { recursive: true });
mkdirSync(teamAvatars, { recursive: true });

if (printOnly) {
  for (const t of lib.filter((x) => want(x.id))) console.log(`\n## ${t.id}\n${body ? bodyPrompt(t) : portraitPrompt(t)}`);
  if (!body) for (const r of roles.filter((x) => !x.character && want(x.id))) console.log(`\n## ${r.team}/${r.id}\n${portraitPrompt(r)}`);
  process.exit(0);
}
if (!sync && !key) throw new Error('OPENAI_API_KEY saknas och finns inte i nyckelringen (control-room-openai).');

if (sync) {
  // Teams draw their roles as the library's characters: same portrait.
  for (const r of roles.filter((x) => x.character && want(x.id))) {
    const from = join(libAvatars, `${r.character}.png`);
    if (!existsSync(from)) continue;
    copyFileSync(from, join(teamAvatars, `${r.team}-${r.id}.png`));
    console.log(`${r.team}/${r.id} ← ${r.character}`);
  }
  process.exit(0);
}

if (body) {
  for (const t of lib.filter((x) => want(x.id))) {
    const file = join(libCharacters, t.id, 'body.png');
    if (existsSync(file) && !force) continue;
    const portrait = join(libAvatars, `${t.id}.png`);
    if (!existsSync(portrait)) {
      console.log(`${t.id}: porträtt saknas, gör det först`);
      continue;
    }
    process.stdout.write(`${t.id} (kropp) … `);
    try {
      mkdirSync(join(libCharacters, t.id), { recursive: true });
      writeFileSync(file, await edit(bodyPrompt(t), portrait, '1024x1536'));
      console.log('klar');
    } catch (err) {
      console.log(`fel: ${err.message}`);
    }
  }
  process.exit(0);
}

// Portraits: the library's characters, then team roles that have none.
const jobs = [
  ...lib.filter((t) => want(t.id)).map((t) => ({ label: `library/${t.id}`, file: join(libAvatars, `${t.id}.png`), prompt: portraitPrompt(t) })),
  ...roles
    .filter((r) => !r.character && want(r.id))
    .map((r) => ({ label: `${r.team}/${r.id}`, file: join(teamAvatars, `${r.team}-${r.id}.png`), prompt: portraitPrompt(r) })),
];
for (const job of jobs) {
  if (existsSync(job.file) && !force) continue;
  process.stdout.write(`${job.label} … `);
  try {
    writeFileSync(job.file, await generate(job.prompt, '1024x1024'));
    // 1024 px is far more than a 96 px avatar needs; sips ships with macOS.
    execFileSync('sips', ['-Z', '384', job.file], { stdio: 'ignore' });
    console.log('klar');
  } catch (err) {
    console.log(`fel: ${err.message}`);
  }
}
console.log('Kör --sync för att ge teamen de nya porträtten, och --body för 3D-förlagorna.');
