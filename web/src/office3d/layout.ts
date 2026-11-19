import type { Role } from '../api.ts';

/**
 * The office floor, generated from the team: desks in pods of four, the lead
 * at the head of the room, the architect by the whiteboard, the tester by the
 * test bench, and a lounge with ping pong, coffee, a sofa, plants and the
 * window. Metres; x to the right, z towards the camera, y up.
 */

export type P = [number, number];

/** Where someone stands or sits, and which way they face (radians around y, 0 = towards +z). */
export interface Spot {
  at: P;
  face: number;
}

export interface Desk {
  roleId: string;
  /** The desk top's centre. */
  desk: P;
  /** The chair: where the agent sits, facing the desk. */
  seat: Spot;
  /** Behind the chair, in the aisle: where walking to and from the desk starts. */
  aisle: P;
  /** Which way the desk faces, same as the seat. */
  face: number;
  kind: 'pod' | 'lead';
}

export interface Layout {
  /** Floor bounds. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  desks: Map<string, Desk>;
  /** Pods' centres, for the paper bins and the desk furniture. */
  pods: P[];
  bins: P[];
  /**
   * The table; where the player at each end stands (forehand to the ball: a
   * little to the side of the centre line); the line waiting behind each end
   * in round-the-table ping pong, nearest first; the way round the table from
   * each end (clockwise seen from above: the left end runs along the back,
   * the right end along the front); and where those out of the game watch.
   */
  pingpong: { table: P; ends: [Spot, Spot]; lines: [P[], P[]]; laps: [P[], P[]]; watch: Spot[] };
  coffee: { machine: Spot; queue: Spot[] };
  sofa: { at: P; face: number; seats: Spot[] };
  plants: Spot[];
  /** Windows in the back wall: where the pane is (x), and where someone stands to look out. */
  windows: (Spot & { pane: number })[];
  whiteboard: { at: P; spots: Spot[] };
  /** Open floor where a few gather for a chat: the water cooler, the lounge, by the desks. */
  huddles: P[];
  testBench: { at: P; spot: Spot };
  /** Points the lead walks between on its rounds. */
  patrol: P[];
  /** The two aisles running along x, in front of and behind the pods. */
  aisles: [number, number];
  /** Furniture that is only there to look at. */
  decor: {
    bookshelf: Spot;
    fridge: Spot;
    waterCooler: Spot;
    armchair: Spot;
    beanbags: Spot[];
    floorLamp: Spot;
  };
  /** Where paintings hang on the back wall: x, and the wall's z. */
  art: { x: number; z: number }[];
}

const POD_PITCH = 4.4;
const AISLE = 2.6;

export function buildLayout(roles: Role[]): Layout {
  const lead = roles.find((r) => r.kind === 'lead');
  const rest = roles.filter((r) => r !== lead);
  // Architect and tester sit nearest their whiteboard and bench, at the ends.
  rest.sort((a, b) => order(a) - order(b));
  const podCount = Math.max(1, Math.ceil(rest.length / 4));
  const x0 = 0;
  const desks = new Map<string, Desk>();
  const pods: P[] = [];
  for (let p = 0; p < podCount; p++) pods.push([x0 + p * POD_PITCH, 0]);
  rest.forEach((r, i) => {
    const [px] = pods[Math.floor(i / 4)];
    const slot = i % 4;
    const left = slot % 2 === 0;
    const back = slot < 2;
    const dx = left ? -0.82 : 0.82;
    // Back row faces +z (towards the camera), front row faces -z.
    const face = back ? 0 : Math.PI;
    const deskZ = back ? -0.42 : 0.42;
    const seatZ = back ? -1.15 : 1.15;
    desks.set(r.id, {
      roleId: r.id,
      desk: [px + dx, deskZ],
      seat: { at: [px + dx, seatZ], face },
      aisle: [px + dx, back ? -AISLE : AISLE],
      face,
      kind: 'pod',
    });
  });
  const podsEnd = pods[pods.length - 1][0] + 2.2;
  const leadX = x0 - 4.2;
  if (lead) {
    // The lead's desk at the head of the room, facing the team.
    desks.set(lead.id, {
      roleId: lead.id,
      desk: [leadX + 0.55, 0],
      seat: { at: [leadX - 0.25, 0], face: Math.PI / 2 },
      aisle: [leadX - 0.25, AISLE],
      face: Math.PI / 2,
      kind: 'lead',
    });
  }
  const lx = podsEnd + 1.6;
  const minX = leadX - 1.8;
  // The lounge: room to run round the ping pong table.
  const maxX = lx + 7.6;
  const minZ = -4.6;
  const maxZ = 3.6;
  const archDesk = [...desks.values()].find((d) => roles.find((r) => r.id === d.roleId)?.kind === 'architect');
  const wbX = archDesk ? archDesk.desk[0] : x0;
  const testDesk = [...desks.values()].find((d) => roles.find((r) => r.id === d.roleId)?.kind === 'tester');
  const tbX = Math.min(testDesk ? testDesk.desk[0] + 1.6 : podsEnd - 1, podsEnd + 0.4);

  const layout: Layout = {
    minX,
    maxX,
    minZ,
    maxZ,
    desks,
    pods,
    bins: pods.map(([x]) => [x, 1.95] as P),
    pingpong: pingpongArea([lx + 3.1, 1.75]),
    coffee: {
      machine: { at: [maxX - 1.1, -3.2], face: Math.PI },
      queue: [0, 1, 2].map((i) => ({ at: [maxX - 1.1 - i * 0.75, -2.2] as P, face: Math.PI - 0.5 })),
    },
    sofa: {
      at: [lx + 2.2, -2.9],
      face: 0,
      seats: [
        { at: [lx + 1.65, -2.75], face: 0 },
        { at: [lx + 2.75, -2.75], face: 0 },
      ],
    },
    plants: [
      { at: [lx + 0.4, -3.6], face: Math.PI },
      { at: [lx - 1.3, maxZ - 0.4], face: -Math.PI / 2 },
      { at: [minX + 0.5, -3.9], face: Math.PI },
    ],
    windows: [
      { pane: x0 + 1.5, at: [x0 + 1.5, -3.85], face: Math.PI },
      // Above the sofa (the kitchen's wall cabinets take the corner); looked out of from beside it.
      { pane: lx + 2.2, at: [lx + 3.6, -3.0], face: Math.atan2(2.2 - 3.6, minZ - -3.0) },
    ],
    whiteboard: {
      at: [wbX, minZ + 0.12],
      spots: [
        { at: [wbX - 0.5, minZ + 1.0], face: Math.PI },
        { at: [wbX + 0.6, minZ + 1.2], face: Math.PI + 0.4 },
      ],
    },
    huddles: [],
    testBench: { at: [tbX, minZ + 0.45], spot: { at: [tbX, minZ + 1.2], face: Math.PI } },
    // The lead stops between the pods, clear of where people stand to stretch or
    // chat behind a desk.
    patrol: [
      [leadX + 1.6, AISLE],
      ...pods.map(([x]) => [x + POD_PITCH / 2, AISLE] as P),
      ...pods.map(([x]) => [x + POD_PITCH / 2, -AISLE] as P).reverse(),
      [leadX + 1.6, -AISLE],
    ],
    aisles: [-AISLE, AISLE],
    decor: {
      bookshelf: { at: [minX + 0.3, -2.3], face: Math.PI / 2 },
      fridge: { at: [maxX - 0.4, -1.2], face: -Math.PI / 2 },
      waterCooler: { at: [maxX - 0.45, 0.7], face: -Math.PI / 2 },
      // Beside the coffee table, facing it: the way to the coffee and the window stays open.
      armchair: { at: [lx + 0.75, -1.75], face: Math.PI / 2 },
      beanbags: [
        { at: [lx + 0.4, -0.35], face: 0.6 },
        { at: [lx + 1.3, -0.55], face: -0.3 },
      ],
      floorLamp: { at: [lx + 0.75, -3.4], face: 0.4 },
    },
    art: artSlots(minX, lx - 1.6, minZ, [x0 + 1.5, lx + 2.2, wbX]),
  };
  layout.huddles = huddleSpots(layout, leadX);
  return layout;
}

/**
 * Quiet corners for a chat, off the ways people walk: along the back wall
 * where nothing stands (and nobody stands to look out of a window or at the
 * whiteboard), and the corner behind the lead. Up to three, well apart.
 */
function huddleSpots(l: Layout, leadX: number): P[] {
  const z = l.minZ + 0.85;
  const busy: P[] = [
    ...l.windows.map((w) => w.at),
    ...l.whiteboard.spots.map((s) => s.at),
    l.testBench.spot.at,
    l.coffee.machine.at,
    ...l.plants.map((p) => p.at),
  ];
  const blocks = furniture(l);
  const clearOf = (c: P) =>
    !busy.some((b) => Math.hypot(b[0] - c[0], b[1] - c[1]) < 1.4) &&
    !blocks.some((r) => c[0] > r.x1 - 0.9 && c[0] < r.x2 + 0.9 && c[1] > r.z1 - 0.9 && c[1] < r.z2 + 0.9);
  const candidates: P[] = [[leadX - 0.2, z]];
  for (let x = l.minX + 1; x < l.maxX - 1; x += 0.25) candidates.push([x, z]);
  const out: P[] = [];
  for (const c of candidates) {
    if (out.length >= 3) break;
    if (clearOf(c) && out.every((o) => Math.hypot(o[0] - c[0], o[1] - c[1]) > 3)) out.push(c);
  }
  return out;
}

/**
 * Round the ping pong table. The players stand 0.93 m out from the ends (the
 * stroke reaches forward) and 0.55 m to the side; the lines wait behind them
 * at 0.6 m; the laps run 0.5 m out from the long sides.
 */
function pingpongArea(table: P): Layout['pingpong'] {
  const [tx, tz] = table;
  const half = 2.74 / 2;
  const side = 1.525 / 2 + 0.5;
  const e0 = tx - half - 0.93;
  const e1 = tx + half + 0.93;
  const line = (x: number, z: number, dir: number) => [1, 2, 3].map((i) => [x + dir * 0.6 * i, z] as P);
  return {
    table,
    ends: [
      { at: [e0, tz - 0.55], face: Math.PI / 2 },
      { at: [e1, tz + 0.55], face: -Math.PI / 2 },
    ],
    lines: [line(e0, tz - 0.55, -1), line(e1, tz + 0.55, 1)],
    // Clockwise: from the left end along the back (-z), from the right end along the front.
    laps: [
      [
        [tx - half - 0.3, tz - side],
        [tx + half + 0.3, tz - side],
      ],
      [
        [tx + half + 0.3, tz + side],
        [tx - half - 0.3, tz + side],
      ],
    ],
    watch: [-0.9, -0.1, 0.7, 1.5, 2.3, 3.1].map((dx) => ({ at: [tx + dx, tz - side - 0.9] as P, face: 0 })),
  };
}

/** Spots for paintings along the back wall, clear of windows and the whiteboard. */
function artSlots(from: number, to: number, wallZ: number, busy: number[]): { x: number; z: number }[] {
  const slots: { x: number; z: number }[] = [];
  for (let x = from + 1.3; x < to; x += 2.2) {
    if (busy.some((b) => Math.abs(b - x) < 1.8)) continue;
    slots.push({ x, z: wallZ + 0.02 });
  }
  return slots;
}

function order(r: Role): number {
  if (r.kind === 'architect') return 0;
  if (r.kind === 'bug') return 1;
  if (r.kind === 'designer') return 2;
  if (r.kind === 'tester') return 9;
  return 5;
}

/** A piece of furniture's footprint on the floor: x1..x2 × z1..z2. */
export interface Block {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  /** Knee high (sofa, coffee table): people sidle closer past it. */
  low?: boolean;
}

const box = ([x, z]: P, w: number, d: number): Block => ({ x1: x - w / 2, z1: z - d / 2, x2: x + w / 2, z2: z + d / 2 });
const round = (at: P, r: number) => box(at, r * 2, r * 2);

/** Everything on the floor nobody walks through, as the scene places it. */
export function furniture(l: Layout): Block[] {
  const b: Block[] = [];
  // A desk and its chair as one: nobody squeezes between them, and the way to the
  // chair is from the aisle behind it.
  for (const d of l.desks.values()) {
    const desk = d.kind === 'lead' ? box(d.desk, 0.85, 1.8) : box(d.desk, 1.5, 0.78);
    const [sx, sz] = d.seat.at;
    b.push({ x1: Math.min(desk.x1, sx - 0.3), z1: Math.min(desk.z1, sz - 0.3), x2: Math.max(desk.x2, sx + 0.3), z2: Math.max(desk.z2, sz + 0.3) });
  }
  b.push(box(l.pingpong.table, 2.74, 1.525));
  const m = l.coffee.machine.at;
  b.push(box([m[0] - 0.7, m[1] - 0.55], 2.6, 0.62));
  b.push({ ...box(l.sofa.at, 2.2, 0.95), low: true });
  b.push({ ...box(coffeeTable(l), 1.0, 0.6), low: true });
  b.push(box([l.whiteboard.at[0], l.whiteboard.at[1] + 0.35], 2.2, 0.5));
  b.push(box(l.testBench.at, 1.8, 0.6));
  b.push(box(l.decor.bookshelf.at, 0.36, 0.95));
  b.push(box(l.decor.fridge.at, 0.68, 0.7));
  b.push(round(l.decor.waterCooler.at, 0.22));
  b.push(round(l.decor.armchair.at, 0.42));
  b.push(round(l.decor.floorLamp.at, 0.18));
  for (const s of l.decor.beanbags) b.push(round(s.at, 0.42));
  for (const s of l.plants) b.push(round(s.at, 0.28));
  for (const p of l.bins) b.push(round(p, 0.17));
  return b;
}

/** In front of the sofa, with room to sidle past to a seat. */
export const coffeeTable = (l: Layout): P => [l.sofa.at[0], l.sofa.at[1] + 1.6];

/** Half a person: how far from furniture a walker's centre stays. */
const BODY = 0.35;
const LOW = 0.24;
const CELL = 0.1;

interface Grid {
  x0: number;
  z0: number;
  w: number;
  h: number;
  /** 1 where a walker's centre may not be. */
  blocked: Uint8Array;
  /** 1 close to furniture: allowed, but people keep to the middle of the floor. */
  near: Uint8Array;
  raw: Block[];
}

const grids = new WeakMap<Layout, Grid>();

function gridOf(l: Layout): Grid {
  let g = grids.get(l);
  if (g) return g;
  const x0 = l.minX;
  const z0 = l.minZ;
  const w = Math.ceil((l.maxX - l.minX) / CELL) + 1;
  const h = Math.ceil((l.maxZ - l.minZ) / CELL) + 1;
  const blocked = new Uint8Array(w * h);
  const near = new Uint8Array(w * h);
  const raw = furniture(l);
  const NEAR = BODY + 0.35;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = x0 + i * CELL;
      const z = z0 + j * CELL;
      const wall = x < l.minX + BODY || x > l.maxX - BODY || z < l.minZ + BODY || z > l.maxZ - BODY;
      const hit = (r: Block, m: number) => x > r.x1 - m && x < r.x2 + m && z > r.z1 - m && z < r.z2 + m;
      if (wall || raw.some((r) => hit(r, r.low ? LOW : BODY))) blocked[j * w + i] = 1;
      else if (raw.some((r) => x > r.x1 - NEAR && x < r.x2 + NEAR && z > r.z1 - NEAR && z < r.z2 + NEAR)) near[j * w + i] = 1;
    }
  }
  g = { x0, z0, w, h, blocked, near, raw };
  grids.set(l, g);
  return g;
}

const cellOf = (g: Grid, [x, z]: P): [number, number] => [
  Math.min(g.w - 1, Math.max(0, Math.round((x - g.x0) / CELL))),
  Math.min(g.h - 1, Math.max(0, Math.round((z - g.z0) / CELL))),
];
const free = (g: Grid, i: number, j: number) => i >= 0 && j >= 0 && i < g.w && j < g.h && !g.blocked[j * g.w + i];

/** Whether a point is inside furniture, give or take a body (for steering around people). */
export function solid(l: Layout, p: P, margin = 0.12): boolean {
  const g = gridOf(l);
  if (p[0] < l.minX + margin || p[0] > l.maxX - margin || p[1] < l.minZ + margin || p[1] > l.maxZ - margin) return true;
  return g.raw.some((r) => p[0] > r.x1 - margin && p[0] < r.x2 + margin && p[1] > r.z1 - margin && p[1] < r.z2 + margin);
}

/** Whether a straight walk between two free points stays clear of furniture. */
function clear(g: Grid, p: P, q: P, nearOk?: Set<number>): boolean {
  const steps = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / (CELL / 2));
  for (let k = 0; k <= steps; k++) {
    const t = steps ? k / steps : 0;
    const [i, j] = cellOf(g, [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    if (!free(g, i, j)) return false;
    // Straightening keeps off furniture where the planned way kept off it.
    if (nearOk && g.near[j * g.w + i] && !nearOk.has(j * g.w + i)) return false;
  }
  return true;
}

/** Whether a walker can go straight from p to q without touching furniture. */
export function sight(l: Layout, p: P, q: P): boolean {
  return clear(gridOf(l), p, q);
}

/** The nearest free cell to a spot (chairs, sofa seats and counters are inside furniture). */
function nearestFree(g: Grid, p: P): [number, number] {
  const [ci, cj] = cellOf(g, p);
  if (free(g, ci, cj)) return [ci, cj];
  for (let r = 1; r < Math.max(g.w, g.h); r++) {
    let best: [number, number] | null = null;
    let bd = Infinity;
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r || !free(g, i, j)) continue;
        const d = Math.hypot(i - ci, j - cj);
        if (d < bd) {
          bd = d;
          best = [i, j];
        }
      }
    }
    if (best) return best;
  }
  return [ci, cj];
}

const pointOf = (g: Grid, i: number, j: number): P => [g.x0 + i * CELL, g.z0 + j * CELL];

/** A* over the floor grid, eight directions, no corner cutting. */
function astar(g: Grid, s: [number, number], e: [number, number]): [number, number][] | null {
  const n = g.w * g.h;
  const cost = new Float32Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const start = s[1] * g.w + s[0];
  const goal = e[1] * g.w + e[0];
  const hx = (k: number) => Math.hypot((k % g.w) - e[0], Math.floor(k / g.w) - e[1]);
  // A small binary heap of [f, cell].
  const heap: [number, number][] = [];
  const push = (f: number, k: number) => {
    heap.push([f, k]);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p][0] <= heap[c][0]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1;
        const r = l + 1;
        let m = c;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        c = m;
      }
    }
    return top;
  };
  cost[start] = 0;
  push(hx(start), start);
  while (heap.length) {
    const [, k] = pop();
    if (closed[k]) continue;
    closed[k] = 1;
    if (k === goal) break;
    const i = k % g.w;
    const j = Math.floor(k / g.w);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = i + di;
        const nj = j + dj;
        if (!free(g, ni, nj)) continue;
        if (di && dj && (!free(g, i + di, j) || !free(g, i, j + dj))) continue;
        const nk = nj * g.w + ni;
        const c = cost[k] + (di && dj ? Math.SQRT2 : 1) * (g.near[nk] ? 2.5 : 1);
        if (c < cost[nk]) {
          cost[nk] = c;
          from[nk] = k;
          push(c + hx(nk), nk);
        }
      }
    }
  }
  if (!closed[goal]) return null;
  const cells: [number, number][] = [];
  for (let k = goal; k !== -1; k = from[k]) cells.push([k % g.w, Math.floor(k / g.w)]);
  return cells.reverse();
}

/**
 * A walkable path around all the furniture: out of a chair or seat to the
 * nearest free floor, the shortest way across the room (straightened where
 * nothing is in the way), and in to the target.
 */
export function route(layout: Layout, from: P, to: P, people: P[] = []): P[] {
  const g = withPeople(gridOf(layout), people, from, to);
  const s = nearestFree(g, from);
  const e = nearestFree(g, to);
  const sp = pointOf(g, ...s);
  const ep = pointOf(g, ...e);
  const out: P[] = [];
  const startFree = free(g, ...cellOf(g, from));
  if (!startFree) out.push(sp);
  const cells = astar(g, s, e) ?? (people.length ? astar(gridOf(layout), s, e) : null);
  if (cells) {
    // String pulling: from each corner, as far ahead as is in plain sight.
    const pts = cells.map(([i, j]) => pointOf(g, i, j));
    // Near-furniture cells the plan uses, and their neighbours: fine to cut through.
    const nearOk = new Set<number>();
    for (const [i, j] of cells) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) nearOk.add((j + dj) * g.w + i + di);
    let at = startFree ? from : sp;
    let k = 0;
    while (k < pts.length - 1) {
      let far = k + 1;
      for (let m = pts.length - 1; m > k + 1; m--) {
        if (clear(g, at, pts[m], nearOk)) {
          far = m;
          break;
        }
      }
      at = pts[far];
      out.push(at);
      k = far;
    }
  }
  if (!out.length || Math.hypot(out[out.length - 1][0] - ep[0], out[out.length - 1][1] - ep[1]) > 0.01) out.push(ep);
  out.push(to);
  // Drop points on top of each other.
  return out.filter((p, i) => i === 0 || Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > 0.02);
}

/** People standing still, as obstacles to plan around (not those right at either end). */
function withPeople(g: Grid, people: P[], from: P, to: P): Grid {
  const near = people.filter((p) => Math.hypot(p[0] - from[0], p[1] - from[1]) > 0.7 && Math.hypot(p[0] - to[0], p[1] - to[1]) > 0.7);
  if (!near.length) return g;
  const blocked = g.blocked.slice();
  const r = Math.ceil(0.55 / CELL);
  for (const p of near) {
    const [ci, cj] = cellOf(g, p);
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        if (i >= 0 && j >= 0 && i < g.w && j < g.h && Math.hypot(i - ci, j - cj) * CELL < 0.55) blocked[j * g.w + i] = 1;
      }
    }
  }
  return { ...g, blocked };
}

/** A round through several points, each leg walked around the furniture. */
export function tour(layout: Layout, from: P, points: P[], people: P[] = []): P[] {
  const path: P[] = [];
  let at = from;
  for (const p of points) {
    path.push(...route(layout, at, p, people));
    at = p;
  }
  return path;
}
