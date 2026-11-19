import type { Agent, Pose, Prop } from './director.ts';
import type { Layout, P, Spot } from './layout.ts';
import { ballAt, beat, contactPoint, HALF, ROUND_HALF, TABLE } from './pingpong.ts';

/**
 * A game of ping pong, by the rules of rundpingis when there are four or
 * more:
 *
 * - Two lines, one behind each end, half the players each; the longer line
 *   serves first.
 * - Whoever hits the ball runs round the table, clockwise, to the back of
 *   the other line. One return each, on and on, until someone misses.
 * - A miss costs a life (two each); with none left you are out and watch.
 * - When two are left, they play the final: best of three, serving every
 *   other point.
 *
 * Two to begin with play a friendly match to five. Late for your turn
 * (still running) counts as a miss, as it does at any office table.
 */

/** What the game needs from the director. */
export interface Floor {
  layout: Layout;
  agents: Map<string, Agent>;
  clock: number;
  walk(a: Agent, spot: Spot, pose: Pose, prop: Prop, via?: P[]): void;
  rand(a: Agent): number;
}

type Outcome = 'ok' | 'net' | 'whiff';

interface Rally {
  /** When the serve is hit. */
  t0: number;
  /** The end that serves. */
  serve: 0 | 1;
  /** Seconds per crossing: slower round the table. */
  half: number;
  /** Crossings so far, and how each went. */
  outcomes: Outcome[];
  /** Who hit each crossing. */
  hitters: string[];
  /** When the point is over (the ball in the net, or past a paddle). */
  over: number | null;
  /** Whose fault: the hitter (net) or whoever should have returned it. */
  fault: string | null;
}

const LIVES = 2;
const NET_RISK = 0.03;
const WHIFF_RISK = 0.06;

export class PingPongGame {
  mode: 'round' | 'match';
  players: string[];
  /** The lines: [0] is the left end, the first in each plays. */
  q: [string[], string[]];
  /** Out of the round, watching. */
  out: string[] = [];
  lives = new Map<string, number>();
  score = new Map<string, number>();
  /** Points to win the match. */
  target: number;
  rally: Rally | null = null;
  /** No serve before this (after a point: a breath, picking up the ball). */
  nextServe = 0;
  /** The end that serves next. */
  server: 0 | 1 = 0;
  /** Runs round the table due: when, who, to which line. */
  private laps: { at: number; id: string; to: 0 | 1 }[] = [];
  /** The game is over and everyone can go; set once a winner has celebrated. */
  done = false;
  private finishedAt: number | null = null;

  private f: Floor;

  constructor(f: Floor, ids: string[]) {
    this.f = f;
    this.players = [...ids];
    this.mode = ids.length >= 4 ? 'round' : 'match';
    this.target = this.mode === 'round' ? 2 : 5;
    // Half each; with an odd number the first line is the longer, and it serves.
    const half = Math.ceil(ids.length / 2);
    this.q = [ids.slice(0, half), ids.slice(half)];
    for (const id of ids) {
      this.lives.set(id, LIVES);
      this.score.set(id, 0);
    }
    this.server = 0;
    this.placeAll();
  }

  private agent(id: string | undefined) {
    return id ? this.f.agents.get(id) : undefined;
  }

  private spot(e: 0 | 1, i: number): Spot {
    const pp = this.f.layout.pingpong;
    if (i === 0) return pp.ends[e];
    const line = pp.lines[e];
    const [x, z] = line[Math.min(i - 1, line.length - 1)];
    // A longer line than there is room for: the rest beside the last.
    const extra = Math.max(0, i - line.length);
    const at: P = [x, z + (e === 0 ? -1 : 1) * 0.6 * extra];
    return { at, face: e === 0 ? Math.PI / 2 : -Math.PI / 2 };
  }

  /** Everyone in a line to their place; whoever is running there already is left be. */
  private place(e: 0 | 1) {
    this.q[e].forEach((id, i) => {
      const a = this.agent(id);
      if (!a) return;
      const s = this.spot(e, i);
      const pose: Pose = i === 0 ? 'pingpong' : 'stand';
      if (a.hurry) {
        // Running round: straight to the place the line has moved up to, not to where it was.
        if (a.path.length) {
          a.path[a.path.length - 1] = s.at;
          a.arrive = { pose, face: s.face, prop: 'paddle' };
        }
        return;
      }
      const goal = a.path.length ? a.path[a.path.length - 1] : a.pos;
      if (Math.hypot(goal[0] - s.at[0], goal[1] - s.at[1]) < 0.05 && a.arrive.pose === pose) return;
      this.f.walk(a, s, pose, 'paddle');
    });
  }

  private placeAll() {
    this.place(0);
    this.place(1);
    this.out.forEach((id, i) => this.watch(id, i));
  }

  private watch(id: string, i: number) {
    const a = this.agent(id);
    if (!a) return;
    const w = this.f.layout.pingpong.watch;
    const s = w[i % w.length];
    const t = this.f.layout.pingpong.table;
    this.f.walk(a, { at: s.at, face: Math.atan2(t[0] - s.at[0], t[1] - s.at[1]) }, 'stand', null);
  }

  /** Off round the table to the back of the other line. */
  private run(id: string, to: 0 | 1) {
    const from = (1 - to) as 0 | 1;
    this.q[from] = this.q[from].filter((x) => x !== id);
    if (!this.q[to].includes(id)) this.q[to].push(id);
    const a = this.agent(id);
    if (!a) return;
    a.hurry = true;
    a.beat = null;
    this.f.walk(a, this.spot(to, this.q[to].length - 1), 'stand', 'paddle', this.f.layout.pingpong.laps[from]);
    this.place(from);
  }

  /** In play: not out, and still in the game. */
  get active() {
    return [...this.q[0], ...this.q[1]];
  }

  /** Someone leaves (called away to work). */
  remove(id: string) {
    this.players = this.players.filter((x) => x !== id);
    this.out = this.out.filter((x) => x !== id);
    this.q = [this.q[0].filter((x) => x !== id), this.q[1].filter((x) => x !== id)];
    this.laps = this.laps.filter((l) => l.id !== id);
    if (this.active.length < 2) {
      this.done = true;
      return;
    }
    this.balance();
    if (this.rally && this.rally.over == null) this.rally = null; // a let: serve again
    this.placeAll();
  }

  /** Both ends manned. */
  private balance() {
    if (!this.q[0].length && this.q[1].length > 1) this.q[0].push(this.q[1].pop()!);
    if (!this.q[1].length && this.q[0].length > 1) this.q[1].push(this.q[0].pop()!);
  }

  private say(id: string | undefined, text: string, seconds = 2.6) {
    const a = this.agent(id);
    if (!a) return;
    a.say = text;
    a.sayUntil = this.f.clock + seconds;
    a.nextSay = this.f.clock + seconds + 3;
  }

  /** The first in an end's line is at the table, standing still, ready to hit. */
  private ready(e: 0 | 1) {
    const a = this.agent(this.q[e][0]);
    const at = this.f.layout.pingpong.ends[e].at;
    return Boolean(a && !a.path.length && Math.hypot(a.pos[0] - at[0], a.pos[1] - at[1]) < 0.3);
  }

  tick() {
    const clock = this.f.clock;
    if (this.done) return;
    if (this.finishedAt != null) {
      if (clock > this.finishedAt + 6) this.done = true;
      return;
    }
    // The lines move up as people leave them: everyone (back from a run too) to their place.
    this.balance();
    this.place(0);
    this.place(1);
    // Runs round the table, a moment after the hit (the stroke finished).
    for (const l of this.laps.filter((x) => clock >= x.at)) {
      this.laps = this.laps.filter((x) => x !== l);
      if (this.active.includes(l.id)) this.run(l.id, l.to);
    }
    const r = this.rally;
    if (!r) {
      if (clock >= this.nextServe && this.ready(0) && this.ready(1)) {
        this.rally = { t0: clock + 0.7, serve: this.server, half: this.mode === 'round' ? ROUND_HALF : HALF, outcomes: [], hitters: [], over: null, fault: null };
      }
    } else {
      this.play(r, clock);
    }
    // The strokes, on the rally's clock, for whoever is at the table.
    for (const e of [0, 1] as const) {
      this.q[e].forEach((id, i) => {
        const a = this.agent(id);
        if (!a) return;
        const on = this.rally && i === 0 && !a.path.length && (this.rally.over == null || clock < this.rally.over + 0.4);
        a.beat = on && this.rally ? beat(clock, this.rally.t0 + (((e - this.rally.serve + 2) % 2) as 0 | 1) * this.rally.half, 0, this.rally.half) : null;
      });
    }
  }

  private play(r: Rally, clock: number) {
    // Each crossing starts with a hit from the end whose turn it is.
    while (r.over == null && clock >= r.t0 + r.outcomes.length * r.half) {
      const j = r.outcomes.length;
      const e = ((r.serve + j) % 2) as 0 | 1;
      const id = this.q[e][0];
      const a = this.agent(id);
      if (!a || !this.ready(e)) {
        // Nobody there to hit it: the last ball went past.
        if (j > 0) {
          r.outcomes[j - 1] = 'whiff';
          r.over = clock + 0.4 * r.half;
          r.fault = id ?? null;
        } else {
          this.rally = null;
        }
        return;
      }
      const roll = this.f.rand(a);
      const outcome: Outcome = j > 0 && roll < NET_RISK ? 'net' : roll < NET_RISK + WHIFF_RISK * Math.min(1, j / 2) ? 'whiff' : 'ok';
      r.outcomes.push(outcome);
      r.hitters.push(id);
      if (outcome === 'net') {
        r.over = r.t0 + (j + 0.6) * r.half;
        r.fault = id;
      } else if (outcome === 'whiff') {
        r.over = r.t0 + (j + 1.3) * r.half;
        r.fault = null; // whoever is at the other end when it gets there
      }
      // Round the table: the hitter runs.
      if (this.mode === 'round') this.laps.push({ at: clock + 0.3, id, to: (1 - e) as 0 | 1 });
    }
    if (r.over != null && clock >= r.over) this.point(r);
  }

  /** The point is over: who missed, and what follows. */
  private point(r: Rally) {
    const clock = this.f.clock;
    const j = r.outcomes.length - 1;
    const hitEnd = ((r.serve + j) % 2) as 0 | 1;
    const recvEnd = (1 - hitEnd) as 0 | 1;
    const fault = r.fault ?? this.q[recvEnd][0] ?? r.hitters[j];
    this.rally = null;
    this.nextServe = clock + 1.8;
    if (this.mode === 'round') {
      const left = (this.lives.get(fault) ?? 1) - 1;
      this.lives.set(fault, left);
      if (left <= 0) {
        this.q = [this.q[0].filter((x) => x !== fault), this.q[1].filter((x) => x !== fault)];
        this.laps = this.laps.filter((l) => l.id !== fault);
        this.out.push(fault);
        this.say(fault, 'Ute! 😩');
        const a = this.agent(fault);
        if (a) a.hurry = false;
        this.watch(fault, this.out.length - 1);
      } else {
        this.say(fault, `Miss! ${'❤️'.repeat(left)}`);
        // A missed return counts as a turn: round the table you go (unless still on the way here).
        if (this.q[recvEnd][0] === fault && this.ready(recvEnd) && !this.laps.some((l) => l.id === fault)) this.run(fault, hitEnd);
      }
      // The serve goes to the line where the ball was missed.
      this.server = recvEnd;
      this.balance();
      // Half each, give or take one: from the back of the longer line, round to the other.
      for (let guard = 0; guard < 6 && Math.abs(this.q[0].length - this.q[1].length) > 1; guard++) {
        const long = this.q[0].length > this.q[1].length ? 0 : 1;
        this.run(this.q[long][this.q[long].length - 1], (1 - long) as 0 | 1);
      }
      if (this.active.length === 2) {
        // The final: one at each end, best of three.
        this.mode = 'match';
        this.target = 2;
        const [x, y] = this.active;
        this.q = [[x], [y]];
        this.laps = [];
        for (const id of [x, y]) {
          const a = this.agent(id);
          if (a) a.hurry = false;
        }
        this.say(x, 'Final! 🏓', 3);
        this.nextServe = clock + 4;
      }
      this.placeAll();
      return;
    }
    // A match: the point to the other one.
    const other = this.active.find((x) => x !== fault);
    if (!other) return;
    const won = (this.score.get(other) ?? 0) + 1;
    this.score.set(other, won);
    const mine = this.score.get(fault) ?? 0;
    if (won >= this.target) {
      this.say(other, 'Vann! 🏆', 5);
      this.say(fault, 'Bra spelat!', 4);
      const w = this.agent(other);
      if (w) {
        w.beat = null;
        w.pose = 'dance';
      }
      for (const id of this.out) if (this.f.rand(w ?? this.agent(id)!) < 0.6) this.say(id, 'Grattis! 👏', 3);
      this.finishedAt = clock;
      return;
    }
    this.say(other, `${won}–${mine}`);
    // Serve every other point.
    this.server = (1 - this.server) as 0 | 1;
  }

  /** The ball, if it is in play. */
  ball(): [number, number, number] | null {
    const r = this.rally;
    if (!r || !r.outcomes.length) return null;
    const clock = this.f.clock;
    const n = (clock - r.t0) / r.half;
    if (n < 0) return null;
    const j = Math.min(Math.floor(n), r.outcomes.length - 1);
    const u = n - j;
    const ends = this.f.layout.pingpong.ends;
    const e = ((r.serve + j) % 2) as 0 | 1;
    const from = contactPoint(ends[e].at, ends[e].face);
    const to = contactPoint(ends[1 - e].at, ends[1 - e].face);
    const outcome = r.outcomes[j];
    if (outcome === 'net' && u > 0.5) {
      // Into the net, and down onto the table on the hitter's side.
      const at = ballAt(from, to, 0.5);
      const t = (u - 0.5) * r.half;
      const x = this.f.layout.pingpong.table[0] - Math.sign(to[0] - from[0]) * 0.04;
      return [x, Math.max(TABLE.height + 0.02, at[1] - 4.9 * t * t), at[2]];
    }
    if (u <= 1) return ballAt(from, to, u);
    // Past the paddle: on and down to the floor.
    const t = (u - 1) * r.half;
    const dx = (to[0] - from[0]) / r.half;
    const dz = (to[2] - from[2]) / r.half;
    const y = to[1] + 0.6 * t - 4.9 * t * t;
    return [to[0] + dx * t * 0.8, Math.max(0.02, y), to[2] + dz * t * 0.8];
  }
}
