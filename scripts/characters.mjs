// 3D-gubbarna till Kontoret 3D, gjorda med Meshy (meshy.ai, Pro-planen) från
// helkroppsbilderna i library/characters/<id>/body.png (scripts/avatars.mjs --body).
//
//   node scripts/characters.mjs balance            krediter kvar (gratis)
//   node scripts/characters.mjs library [sök]      animationsbiblioteket (gratis), sparas för att välja klipp
//   node scripts/characters.mjs models [id …]      bild → 3D → skelett, per gubbe (35 krediter styck)
//   node scripts/characters.mjs animations         klippen, en gång på en referensgubbe (3/klipp, 13/egen rörelse)
//   node scripts/characters.mjs props [id …]       inredning och arbetsplatser ur web/src/office3d/catalog.json (15/30 per sak)
//   node scripts/characters.mjs art                tavlor till väggarna, med OpenAI (inga Meshy-krediter)
//   node scripts/characters.mjs build              gubbar, klipp och inredning till web/public/, mindre texturer
//   node scripts/characters.mjs all                allt i tur och ordning
//
//   --max-credits N   stanna innan förbrukningen i den här körningen passerar N (standard 700)
//   --dry             visa vad som skulle göras och kosta, utan att göra det
//
// Alla gubbar riggas med samma skelett (mixamo), så klippen görs en gång och
// delas av alla i three.js. Meshy raderar resultat efter 3 dagar: allt laddas
// ner direkt till library/characters/, och task-id:n sparas i manifest.json så
// att en avbruten körning fortsätter där den var och inget betalas två gånger.
// Nyckeln: MESHY_API_KEY eller nyckelringen (control-room-meshy).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const lib = join(root, 'library/characters');
const out = join(root, 'web/public/characters');
const manifestPath = join(lib, 'manifest.json');
const API = 'https://api.meshy.ai/openapi/v1';
const API2 = 'https://api.meshy.ai/openapi/v2';
const office = join(root, 'library/office');
const officeOut = join(root, 'web/public/office');
const catalog = JSON.parse(readFileSync(join(root, 'web/src/office3d/catalog.json'), 'utf8'));
const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const flags = new Set(args.filter((a) => a.startsWith('--')));
const dry = flags.has('--dry');
const maxCredits = Number(args[args.indexOf('--max-credits') + 1]) || 700;
const rest = args.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--max-credits');

/** The reference character the clips are made on; its proportions are the average ones. */
const REFERENCE = 'fullstack';

/**
 * Clips from Meshy's library, by our name. IDs checked against
 * `node scripts/characters.mjs library` before anything is paid for.
 */
const LIBRARY_CLIPS = [
  ['sit_idle', 33],
  ['sit_idle_f', 32],
  ['sit_lean', 356],
  ['sit_arms_crossed', 364],
  ['sit_sleep', 263],
  ['sit_doze', 268],
  ['sit_drink', 343],
  ['sit_cheer', 304],
  ['walk', 30],
  ['walk_phone', 124],
  ['phone_talk', 312],
  ['stand_drink', 342],
  ['wave', 28],
  ['wave_one', 290],
  ['chat', 56],
  ['talk', 308],
  ['dance', 22],
  ['sit_down', 57],
  ['stand_up', 53],
  ['stand_idle', 0],
  ['scratch', 36],
  // Round the ping pong table.
  ['run', 14],
];

/** Motions the library lacks, made with text to motion (prime) and applied to the reference rig. */
const MOTIONS = [
  ['sit_type', 6, 'A person sits upright on an office chair at a desk and types on a keyboard with both hands, small finger and wrist movements, glancing at a screen in front, relaxed shoulders. Seated the whole time, feet on the floor.'],
  ['sit_feetup', 8, 'A person sits leaning far back on an office chair with both feet up resting on the desk in front, legs straight, relaxed; every few seconds crumples a paper ball and tosses it underhand to the side. Stays seated.'],
  ['sit_rock', 6, 'A person sits on an office chair and slowly rocks back and forth on it, leaning back, hands resting on the thighs, looking around casually. Stays seated.'],
  ['sit_raise', 4, 'A person sits on a chair, turns slightly to the side and raises one hand high to get attention, waving it a little, like asking a question in class. Stays seated.'],
  ['sit_despair', 5, 'A person sits at a desk, leans forward with elbows on the desk and buries the face in both hands, slowly shaking the head in frustration. Stays seated.'],
  ['pingpong', 6, 'A person stands at a table tennis table in a ready stance, knees bent, and plays a rally: forehand and backhand swings with the right hand, small side steps, eyes following the ball.'],
  ['stretch', 5, 'A person stands and stretches after sitting for a long time: reaches both arms high above the head, leans to each side, rolls the shoulders.'],
  ['water', 6, 'A person stands and waters a potted plant on the floor with a watering can held in the right hand, tilting it, leaning forward slightly.'],
  ['whiteboard', 6, 'A person stands facing a whiteboard and draws boxes and arrows on it with a marker in the right hand, stepping back to look, pointing at it.'],
  ['test_phones', 6, 'A person stands at a workbench and taps on several phones lying on the bench with the index finger, picks one up, looks closely, puts it back.'],
];

const key =
  process.env.MESHY_API_KEY ??
  (() => {
    try {
      return execFileSync('security', ['find-generic-password', '-s', 'control-room-meshy', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  })();

// File paths in the manifest are relative to the repo (it is committed); absolute while the script runs.
const paths = (o, fn) => {
  for (const v of Object.values(o ?? {})) if (v && typeof v === 'object') {
    if (typeof v.file === 'string') v.file = fn(v.file);
    paths(v, fn);
  }
};
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { characters: {}, clips: {}, motions: {}, spent: 0 };
paths(manifest, (f) => (isAbsolute(f) ? f : join(root, f)));
manifest.props ??= {};
const save = () => {
  const copy = JSON.parse(JSON.stringify(manifest));
  paths(copy, (f) => (isAbsolute(f) ? relative(root, f) : f));
  writeFileSync(manifestPath, `${JSON.stringify(copy, null, 2)}\n`);
};
let spentNow = 0;

async function api(method, path, body, base = API) {
  if (!key) throw new Error('Ingen Meshy-nyckel. Lägg den i nyckelringen: security add-generic-password -s control-room-meshy -a meshy -w');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 6) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after')) || 5) * 1000));
      continue;
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.message ?? text}`);
    return data;
  }
}

async function balance() {
  const b = await api('GET', '/balance');
  return b.balance;
}

/** Before a paid step: enough left on the account, and under this run's cap. */
async function afford(cost, what) {
  if (spentNow + cost > maxCredits) throw new Error(`${what} skulle passera --max-credits ${maxCredits} (använt hittills ${spentNow}).`);
  if (dry) {
    console.log(`  [dry] ${what}: ${cost} krediter`);
    spentNow += cost;
    return false;
  }
  const left = await balance();
  if (left < cost) throw new Error(`${what} kostar ${cost} men bara ${left} krediter finns kvar.`);
  return true;
}

function charge(n) {
  spentNow += n;
  manifest.spent = (manifest.spent ?? 0) + n;
  save();
}

/** Waits for a task to finish, printing progress; returns the finished task. */
async function wait(kind, id, label, base = API) {
  for (;;) {
    const t = await api('GET', `/${kind}/${id}`, undefined, base);
    if (t.status === 'SUCCEEDED') {
      process.stdout.write(`\r  ${label}: klar                \n`);
      return t;
    }
    if (t.status === 'FAILED' || t.status === 'CANCELED') {
      process.stdout.write('\n');
      throw new Error(`${label}: ${t.status} ${t.task_error?.message ?? ''}`);
    }
    process.stdout.write(`\r  ${label}: ${t.status.toLowerCase()} ${t.progress ?? 0}%   `);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`hämtning misslyckades: ${res.status}`);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/** Height per character from its look, so a tall lead and a small designer stand as they are drawn. */
function heightOf(id) {
  const H = { teamleader: 1.78, architect: 1.68, bug: 1.7, designer: 1.58, tester: 1.64, web: 1.66, backend: 1.82, ios: 1.76, android: 1.56, mac: 1.9, windows: 1.7, fullstack: 1.7, devops: 1.74, docs: 1.56 };
  return H[id] ?? 1.7;
}

async function models(ids) {
  const all = readdirSync(lib, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(lib, d.name, 'body.png'))).map((d) => d.name);
  // The reference first: the clips are made on it.
  const todo = (ids.length ? ids : all).sort((a, b) => (a === REFERENCE ? -1 : b === REFERENCE ? 1 : a.localeCompare(b)));
  for (const id of todo) {
    const m = (manifest.characters[id] ??= {});
    if (m.rigged && existsSync(join(lib, id, 'rigged.glb'))) continue;
    console.log(`${id}`);
    if (!m.imageTask) {
      if (!(await afford(30, `${id}: bild till 3D`))) continue;
      const image = `data:image/png;base64,${readFileSync(join(lib, id, 'body.png')).toString('base64')}`;
      const { result } = await api('POST', '/image-to-3d', {
        image_url: image,
        ai_model: 'meshy-7.1',
        pose_mode: 'a-pose',
        should_texture: true,
        texture_resolution: '2k',
        should_remesh: true,
        topology: 'triangle',
        target_polycount: 15000,
        target_formats: ['glb'],
        origin_at: 'bottom',
      });
      m.imageTask = result;
      save();
    }
    const img = await wait('image-to-3d', m.imageTask, `${id}: 3D`);
    if (!m.imageCharged) {
      charge(img.consumed_credits ?? 30);
      m.imageCharged = true;
      save();
    }
    if (!existsSync(join(lib, id, 'model.glb'))) await download(img.model_urls.glb, join(lib, id, 'model.glb'));
    if (!m.rigTask) {
      if (!(await afford(5, `${id}: skelett`))) continue;
      const { result } = await api('POST', '/rigging', { input_task_id: m.imageTask, height_meters: heightOf(id), skeleton_template: 'mixamo' });
      m.rigTask = result;
      save();
    }
    const rig = await wait('rigging', m.rigTask, `${id}: skelett`);
    if (!m.rigCharged) {
      charge(rig.consumed_credits ?? 5);
      m.rigCharged = true;
      save();
    }
    await download(rig.result.rigged_character_glb_url, join(lib, id, 'rigged.glb'));
    // The rig's own walk, free with it: a fallback clip.
    if (rig.result.basic_animations?.walking_glb_url && !existsSync(join(lib, id, 'walk.glb'))) await download(rig.result.basic_animations.walking_glb_url, join(lib, id, 'walk.glb'));
    m.rigged = true;
    save();
  }
}

async function animations() {
  const ref = manifest.characters[REFERENCE];
  if (!ref?.rigTask || !ref.rigged) throw new Error(`Referensgubben ${REFERENCE} måste vara klar först: node scripts/characters.mjs models ${REFERENCE}`);
  const clipDir = join(lib, '_clips');
  mkdirSync(clipDir, { recursive: true });
  // Library clips, ten at a time; one GLB per batch, clips in the order asked for.
  const missing = LIBRARY_CLIPS.filter(([name]) => !manifest.clips[name]?.file);
  for (let i = 0; i < missing.length; i += 10) {
    const batch = missing.slice(i, i + 10);
    const label = batch.map(([n]) => n).join(', ');
    const pending = batch.find(([n]) => manifest.clips[n]?.task);
    let task = pending ? manifest.clips[pending[0]].task : null;
    if (!task) {
      if (!(await afford(3 * batch.length, `klipp: ${label}`))) continue;
      ({ result: task } = await api('POST', '/animations', { rig_task_id: ref.rigTask, action_ids: batch.map(([, id]) => id), post_process: { operation_type: 'change_fps', fps: 30 } }));
      for (const [n, id] of batch) manifest.clips[n] = { id, task, index: batch.findIndex(([x]) => x === n) };
      save();
    }
    const t = await wait('animations', task, `klipp (${batch.length})`);
    const file = join(clipDir, `batch-${task}.glb`);
    await download(t.result.animation_glb_url, file);
    if (!batch.some(([n]) => manifest.clips[n].charged)) charge(t.consumed_credits ?? 3 * batch.length);
    for (const [n] of batch) Object.assign(manifest.clips[n], { file, charged: true });
    save();
  }
  // Own motions: text to motion, then applied to the reference rig.
  for (const [name, duration, prompt] of MOTIONS) {
    const m = (manifest.motions[name] ??= {});
    if (m.file) continue;
    if (!m.motionTask) {
      if (!(await afford(13, `rörelse: ${name}`))) continue;
      ({ result: m.motionTask } = await api('POST', '/text-to-motion', { prompt, duration, mode: 'prime' }));
      save();
    }
    const mt = await wait('text-to-motion', m.motionTask, `${name}: rörelse`);
    if (!m.motionCharged) {
      charge(mt.consumed_credits ?? 10);
      m.motionCharged = true;
      save();
    }
    if (!m.animTask) {
      ({ result: m.animTask } = await api('POST', '/animations', { rig_task_id: ref.rigTask, motion_task_id: m.motionTask, post_process: { operation_type: 'change_fps', fps: 30 } }));
      save();
    }
    const at = await wait('animations', m.animTask, `${name}: på skelettet`);
    if (!m.animCharged) {
      charge(at.consumed_credits ?? 3);
      m.animCharged = true;
      save();
    }
    m.file = join(clipDir, `${name}.glb`);
    await download(at.result.animation_glb_url, m.file);
    save();
  }
}

/**
 * Furniture and each role's workstation, from text: a hero piece (what is
 * seen up close: chairs, desks, workstations) with Meshy 7.1 and 2K texture,
 * the rest with the cheaper smart topology (meshy-t2 + meshy-n1).
 */
async function props(ids) {
  mkdirSync(office, { recursive: true });
  for (const item of catalog.props.filter((x) => !ids.length || ids.includes(x.id))) {
    const m = (manifest.props[item.id] ??= {});
    const file = join(office, `${item.id}.glb`);
    if (m.done && existsSync(file)) continue;
    const hero = item.tier === 'hero';
    console.log(item.id);
    if (!m.preview) {
      if (!(await afford(hero ? 30 : 15, `${item.id} (${hero ? 'hjälte' : 'enkel'})`))) continue;
      const body = hero
        ? { mode: 'preview', prompt: `${item.prompt} ${catalog.style}`.slice(0, 800), ai_model: 'meshy-7.1', should_remesh: true, topology: 'triangle', target_polycount: 20000, target_formats: ['glb'], origin_at: 'bottom' }
        : { mode: 'preview', prompt: `${item.prompt} ${catalog.style}`.slice(0, 800), model_type: 'smart-topology', ai_model: 'meshy-t2', target_formats: ['glb'], origin_at: 'bottom' };
      ({ result: m.preview } = await api('POST', '/text-to-3d', body, API2));
      save();
    }
    const pv = await wait('text-to-3d', m.preview, `${item.id}: form`, API2);
    if (!m.previewCharged) {
      charge(pv.consumed_credits ?? (hero ? 20 : 5));
      m.previewCharged = true;
      save();
    }
    if (!m.refine) {
      ({ result: m.refine } = await api(
        'POST',
        '/text-to-3d',
        { mode: 'refine', preview_task_id: m.preview, ai_model: 'latest', texture_resolution: '2k', target_formats: ['glb'], origin_at: 'bottom' },
        API2,
      ));
      save();
    }
    const rf = await wait('text-to-3d', m.refine, `${item.id}: textur`, API2);
    if (!m.refineCharged) {
      charge(rf.consumed_credits ?? 10);
      m.refineCharged = true;
      save();
    }
    await download(rf.model_urls.glb, file);
    m.done = true;
    save();
  }
}

/** Paintings for the walls, with OpenAI's image API: cheap, and no Meshy credits. */
async function art() {
  const openai =
    process.env.OPENAI_API_KEY ??
    execFileSync('security', ['find-generic-password', '-s', 'control-room-openai', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const dir = join(officeOut, 'art');
  mkdirSync(dir, { recursive: true });
  for (const a of catalog.art) {
    const file = join(dir, `${a.id}.jpg`);
    if (existsSync(file)) continue;
    process.stdout.write(`${a.id} … `);
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${openai}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2', prompt: `${a.prompt} Flat artwork filling the whole image edge to edge, no frame, no wall, no text, no signature.`, size: '1024x1536', n: 1 }),
    });
    const data = await res.json();
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) {
      console.log(`fel: ${data.error?.message ?? res.status}`);
      continue;
    }
    const png = join(dir, `${a.id}.png`);
    writeFileSync(png, Buffer.from(b64, 'base64'));
    execFileSync('sips', ['-Z', '768', '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', png, '--out', file], { stdio: 'ignore' });
    rmSync(png);
    console.log('klar');
  }
}

/**
 * Into the web app: each character's rigged model with smaller textures, and
 * one animations.glb holding every clip by our name, without any mesh.
 */
// Quaternions as [x, y, z, w].
const qinv = ([x, y, z, w]) => [-x, -y, -z, w];
const qmul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz,
];
const qrot = (q, [x, y, z]) => qmul(qmul(q, [x, y, z, 0]), qinv(q)).slice(0, 3);

async function build() {
  const { NodeIO } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const { prune, dedup } = await import('@gltf-transform/functions');
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  mkdirSync(out, { recursive: true });
  const tmp = join(lib, '_tmp');
  mkdirSync(tmp, { recursive: true });

  /** Textures to 1024 px JPEG with sips: a quarter of the size, no difference at office distance. */
  const shrink = (doc) => {
    for (const tex of doc.getRoot().listTextures()) {
      const img = tex.getImage();
      if (!img) continue;
      const src = join(tmp, 'tex.png');
      const dst = join(tmp, 'tex.jpg');
      writeFileSync(src, img);
      execFileSync('sips', ['-Z', '1024', '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', src, '--out', dst], { stdio: 'ignore' });
      tex.setImage(readFileSync(dst)).setMimeType('image/jpeg');
    }
  };

  // Furniture and workstations, with smaller textures.
  mkdirSync(officeOut, { recursive: true });
  const builtProps = [];
  for (const [id, m] of Object.entries(manifest.props ?? {})) {
    if (!m.done || !existsSync(join(office, `${id}.glb`))) continue;
    const doc = await io.read(join(office, `${id}.glb`));
    shrink(doc);
    await doc.transform(prune(), dedup());
    await io.write(join(officeOut, `${id}.glb`), doc);
    builtProps.push(id);
  }
  const artBuilt = existsSync(join(officeOut, 'art')) ? readdirSync(join(officeOut, 'art')).filter((f) => f.endsWith('.jpg')).map((f) => f.slice(0, -4)) : [];
  writeFileSync(join(officeOut, 'index.json'), `${JSON.stringify({ props: builtProps, art: artBuilt }, null, 2)}\n`);
  console.log(`inredning: ${builtProps.length} saker, ${artBuilt.length} tavlor`);

  for (const [id, m] of Object.entries(manifest.characters)) {
    if (!m.rigged) continue;
    const doc = await io.read(join(lib, id, 'rigged.glb'));
    // The model alone; the clips come from animations.glb.
    for (const a of doc.getRoot().listAnimations()) a.dispose();
    shrink(doc);
    await doc.transform(prune(), dedup());
    await io.write(join(out, `${id}.glb`), doc);
    console.log(`${id}.glb`);
  }

  // Every clip into one file, retargeted by bone name onto one skeleton, renamed to our names.
  const refFile = join(lib, REFERENCE, 'rigged.glb');
  if (!existsSync(refFile)) return;
  const base = await io.read(refFile);
  const baseRoot = base.getRoot();
  for (const a of baseRoot.listAnimations()) a.dispose();
  const byName = new Map(baseRoot.listNodes().map((n) => [n.getName(), n]));
  const buffer = baseRoot.listBuffers()[0] ?? base.createBuffer();
  const sources = [
    ...Object.entries(manifest.clips)
      .filter(([, c]) => c.file)
      .map(([name, c]) => ({ name, file: c.file, index: c.index })),
    ...Object.entries(manifest.motions)
      .filter(([, m]) => m.file)
      .map(([name, m]) => ({ name, file: m.file, index: 0 })),
  ];
  const cache = new Map();
  for (const s of sources) {
    if (!cache.has(s.file)) cache.set(s.file, await io.read(s.file));
    const anim = cache.get(s.file).getRoot().listAnimations()[s.index];
    if (!anim) {
      console.log(`  ${s.name}: inget klipp på plats ${s.index} i ${s.file}`);
      continue;
    }
    const copy = base.createAnimation(s.name);
    for (const ch of anim.listChannels()) {
      const target = ch.getTargetNode() && byName.get(ch.getTargetNode().getName());
      if (!target) continue;
      const sm = ch.getSampler();
      const input = base.createAccessor().setType(sm.getInput().getType()).setArray(sm.getInput().getArray().slice()).setBuffer(buffer);
      const values = sm.getOutput().getArray().slice();
      // Clip files keep the skeleton Z-up under a rotated Armature, the models
      // are Y-up: fold the source parent's rotation into the root bone's tracks.
      const parent = ch.getTargetNode().getParentNode();
      if (!parent) continue; // the Armature itself
      const targetParent = target.getParentNode();
      const isRoot = !parent.getParentNode(); // the root bone, right under the Armature
      if (isRoot && targetParent) {
        // delta = inverse(target parent) * source parent
        const delta = qmul(qinv(targetParent.getRotation()), parent.getRotation());
        if (Math.abs(delta[3]) < 0.99999) {
          if (ch.getTargetPath() === 'rotation') for (let i = 0; i < values.length; i += 4) values.set(qmul(delta, values.slice(i, i + 4)), i);
          if (ch.getTargetPath() === 'translation') for (let i = 0; i < values.length; i += 3) values.set(qrot(delta, values.slice(i, i + 3)), i);
        }
      }
      // The root bone starts over the spot the office puts the person on (a chair,
      // a floor spot): the clip's own sideways and forward offset goes; height stays.
      if (isRoot && ch.getTargetPath() === 'translation') {
        const rest = target.getTranslation();
        const [x0, , z0] = values.slice(0, 3);
        for (let i = 0; i < values.length; i += 3) {
          values[i] += rest[0] - x0;
          values[i + 2] += rest[2] - z0;
        }
      }
      const output = base.createAccessor().setType(sm.getOutput().getType()).setArray(values).setBuffer(buffer);
      const sampler = base.createAnimationSampler().setInput(input).setOutput(output).setInterpolation(sm.getInterpolation());
      copy.addSampler(sampler).addChannel(base.createAnimationChannel().setTargetNode(target).setTargetPath(ch.getTargetPath()).setSampler(sampler));
    }
    console.log(`  klipp ${s.name}`);
  }
  // Only the skeleton and the clips: meshes, materials and textures go.
  for (const mesh of baseRoot.listMeshes()) mesh.dispose();
  for (const skin of baseRoot.listSkins()) skin.dispose();
  for (const mat of baseRoot.listMaterials()) mat.dispose();
  for (const tex of baseRoot.listTextures()) tex.dispose();
  await base.transform(prune({ keepLeaves: true }), dedup());
  await io.write(join(out, 'animations.glb'), base);
  // What the office can load: the built characters and the clips' names.
  writeFileSync(
    join(out, 'index.json'),
    `${JSON.stringify({ characters: Object.entries(manifest.characters).filter(([, m]) => m.rigged).map(([id]) => id), clips: base.getRoot().listAnimations().map((a) => a.getName()) }, null, 2)}\n`,
  );
  rmSync(tmp, { recursive: true, force: true });
  console.log('animations.glb');
}

async function library(search) {
  const list = await api('GET', `/animations/library${search ? `?search=${encodeURIComponent(search)}` : ''}`);
  if (!search) writeFileSync(join(lib, 'animation-library.json'), `${JSON.stringify(list, null, 2)}\n`);
  for (const a of list) console.log(`${String(a.action_id).padStart(4)}  ${a.key}  (${a.category}/${a.sub_category})`);
  // The chosen ids, checked against the list.
  const ids = new Map(list.map((a) => [a.action_id, a.key]));
  if (!search) for (const [name, id] of LIBRARY_CLIPS) console.log(`${ids.has(id) ? 'ok ' : 'SAKNAS'} ${name} = ${id} ${ids.get(id) ?? ''}`);
}

mkdirSync(lib, { recursive: true });
try {
  switch (command) {
    case 'balance':
      console.log(`${await balance()} krediter kvar`);
      break;
    case 'library':
      await library(rest[0]);
      break;
    case 'models':
      await models(rest);
      break;
    case 'animations':
      await animations();
      break;
    case 'props':
      await props(rest);
      break;
    case 'art':
      await art();
      break;
    case 'build':
      await build();
      break;
    case 'all':
      await models([]);
      await animations();
      await props([]);
      await build();
      break;
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  }
} finally {
  if (spentNow) console.log(`\n${dry ? 'Skulle kosta' : 'Använt i den här körningen'}: ${spentNow} krediter. Totalt enligt manifestet: ${manifest.spent ?? 0}.`);
}
