import type { Approval, Role, Subtask, Task } from '../api.ts';
import { route, sight, solid, tour, type Layout, type P, type Spot } from './layout.ts';
import { PingPongGame, type Floor } from './game.ts';

/**
 * Life in the office. Each agent has a duty decided by its cards (work,
 * waiting for the owner, watching its sub-cards, out of quota …); an agent with
 * none is free and the director keeps it busy with something to do: ping pong
 * in pairs or rundpingis round the table, coffee, the fridge, plants, the sofa, the
 * window, a chat by the water cooler. It walks the aisles
 * between places and holds a pose when it arrives. Plain objects mutated every
 * frame; React renders the office once and reads this in useFrame.
 */

/** What the body is doing; the character turns this into animation. */
export type Pose =
  | 'sit-type'
  | 'sit-idle'
  | 'sit-rock'
  | 'sit-lean'
  | 'sit-feetup'
  | 'sit-sleep'
  | 'sit-despair'
  | 'sit-raise'
  | 'sit-phone'
  | 'sit-drink'
  | 'stand'
  | 'stand-wave'
  | 'stand-talk'
  | 'stand-drink'
  | 'stand-look'
  | 'walk'
  | 'walk-phone'
  | 'pingpong'
  | 'water'
  | 'stretch'
  | 'dance'
  | 'sofa-phone'
  | 'sofa-nap'
  | 'whiteboard'
  | 'test';

/** What the cards say the agent must do. */
export type Duty = 'work' | 'test' | 'ask' | 'approve' | 'watch' | 'pr' | 'queue' | 'sleep' | 'despair' | 'patrol' | 'whiteboard' | 'free';

export type Prop = 'mug' | 'phone' | 'headset' | 'can' | 'paddle' | 'soda' | null;

export interface Agent {
  id: string;
  role: Role;
  pos: P;
  face: number;
  path: P[];
  speed: number;
  pose: Pose;
  /** The pose to take on arrival. */
  arrive: { pose: Pose; face: number; prop: Prop };
  prop: Prop;
  duty: Duty;
  /** The card behind the duty, for the label and a click. */
  card: Subtask | null;
  /** What is shown above the head, if anything. */
  bubble: string | null;
  /** Free time: what it is doing and until when (seconds on the director's clock). */
  activity: string;
  until: number;
  /** A spot it holds (coffee machine, sofa seat …), released when it leaves. */
  holds: string | null;
  /** Per agent, so two never move in step. */
  seed: number;
  /** When the next paper ball goes, while watching. */
  nextToss: number;
  /** Ping pong: how far through the stroke (0..1) while at the table, on the game's clock. */
  beat: number | null;
  /** Late for the next turn in round-the-table ping pong: running. */
  hurry: boolean;
  /** Small talk: what it says, until when, and when it may say something next. */
  say: string | null;
  sayUntil: number;
  nextSay: number;
  /** The pose to go back to when done talking. */
  unsay: Pose | null;
  /** Seconds without getting anywhere while walking. */
  stall: number;
  /** When the way was last planned again on the move (director's clock). */
  planned: number;
}

export interface Ball {
  from: [number, number, number];
  to: [number, number, number];
  start: number;
  duration: number;
  hit: boolean;
}

/** A duty and the card behind it, from the board: the same priority the desks in the list use. */
export function dutyOf(role: Role, cards: Subtask[], tasks: Task[], approvals: Approval[]): { duty: Duty; card: Subtask | null } {
  const mine = cards.filter((s) => s.agent === role.id && tasks.find((t) => t.id === s.taskId)?.title !== 'Boarden');
  const find = (st: Subtask['status']) => mine.find((s) => s.status === st) ?? null;
  const ask = approvals.find((a) => a.subtaskId != null && mine.some((s) => s.id === a.subtaskId));
  if (ask) return { duty: 'approve', card: mine.find((s) => s.id === ask.subtaskId) ?? null };
  const running = find('running');
  if (running) return { duty: role.kind === 'architect' ? 'whiteboard' : role.kind === 'tester' ? 'test' : 'work', card: running };
  const testing = find('testing');
  if (testing) return { duty: role.kind === 'tester' ? 'test' : 'work', card: testing };
  const needs = find('needs-you');
  if (needs) return { duty: 'ask', card: needs };
  const quota = find('quota');
  if (quota) return { duty: 'sleep', card: quota };
  const watching = find('watching');
  if (watching) return { duty: role.kind === 'lead' ? 'patrol' : 'watch', card: watching };
  const pr = find('pr-open');
  if (pr) return { duty: 'pr', card: pr };
  const queued = find('queued');
  if (queued) return { duty: 'queue', card: queued };
  // A card that failed in the last half hour: head in hands for a while.
  const failed = mine.find((s) => s.status === 'failed' && Date.now() - Date.parse(s.updatedAt) < 30 * 60_000);
  if (failed) return { duty: 'despair', card: failed };
  return { duty: 'free', card: null };
}

/** How close two people get (metres), and how far ahead a walker looks for others. */
const PERSONAL = 0.5;
const LOOK = 1.6;

const BUBBLE: Partial<Record<Duty, string>> = { ask: '?', approve: '!', sleep: 'Zzz' };

/** Free-time things to do, with how often each is picked. */
const ACTIVITIES: { name: string; weight: number; lead?: boolean }[] = [
  { name: 'desk', weight: 4 },
  { name: 'coffee', weight: 3 },
  { name: 'pingpong', weight: 3 },
  { name: 'sofa', weight: 2 },
  { name: 'water', weight: 1 },
  { name: 'window', weight: 1.5 },
  { name: 'chat', weight: 2 },
  { name: 'stretch', weight: 1 },
  { name: 'dance', weight: 0.4 },
  { name: 'nap', weight: 0.8 },
  { name: 'visit', weight: 1.5 },
  { name: 'fridge', weight: 1.2 },
  { name: 'huddle', weight: 2.5 },
  { name: 'rounds', weight: 3, lead: true },
];

export class Director implements Floor {
  layout: Layout;
  agents = new Map<string, Agent>();
  balls: Ball[] = [];
  /** Spots in use: coffee, sofa-0, window-1, pingpong, plant-2 … */
  held = new Map<string, string>();
  clock = 0;
  game: PingPongGame | null = null;

  constructor(layout: Layout, roles: Role[]) {
    this.layout = layout;
    roles.forEach((role, i) => {
      const desk = layout.desks.get(role.id);
      const seat = desk?.seat ?? { at: [0, 3] as P, face: 0 };
      this.agents.set(role.id, {
        id: role.id,
        role,
        pos: [...seat.at] as P,
        face: seat.face,
        path: [],
        speed: 1.15 + ((i * 37) % 10) / 30,
        pose: 'sit-idle',
        arrive: { pose: 'sit-idle', face: seat.face, prop: null },
        prop: null,
        duty: 'free',
        card: null,
        bubble: null,
        activity: 'desk',
        until: 0,
        holds: null,
        seed: (i * 7919) % 1000,
        nextToss: 0,
        beat: null,
        hurry: false,
        say: null,
        sayUntil: 0,
        nextSay: 3 + i * 1.3,
        unsay: null,
        stall: 0,
        planned: -9,
      });
    });
  }

  rand(a: Agent) {
    a.seed = (a.seed * 9301 + 49297) % 233280;
    return a.seed / 233280;
  }

  private release(a: Agent) {
    if (a.holds) this.held.delete(a.holds);
    a.holds = null;
    a.hurry = false;
    a.beat = null;
    const g = this.game;
    if (g && g.players.includes(a.id)) {
      g.remove(a.id);
      if (g.done) this.endGame();
    }
  }

  private hold(a: Agent, spot: string): boolean {
    const owner = this.held.get(spot);
    if (owner && owner !== a.id) return false;
    this.held.set(spot, a.id);
    a.holds = spot;
    return true;
  }

  /** Where everyone else is standing or sitting still: walks are planned around them. */
  private still(a: Agent): P[] {
    return [...this.agents.values()].filter((b) => b !== a && (!b.path.length || b.stall > 0.5)).map((b) => b.pos);
  }

  /** Someone standing still close to the next stretch of the walk (not at its very end). */
  private inTheWay(a: Agent): boolean {
    const [tx, tz] = a.path[0];
    const end = a.path[a.path.length - 1];
    const dx = tx - a.pos[0];
    const dz = tz - a.pos[1];
    const len2 = dx * dx + dz * dz || 1;
    for (const b of this.agents.values()) {
      if (b === a || b.path.length) continue;
      if (Math.hypot(b.pos[0] - end[0], b.pos[1] - end[1]) < 0.8) continue;
      const t = Math.max(0, Math.min(1, ((b.pos[0] - a.pos[0]) * dx + (b.pos[1] - a.pos[1]) * dz) / len2));
      const d = Math.hypot(a.pos[0] + dx * t - b.pos[0], a.pos[1] + dz * t - b.pos[1]);
      if (d < 0.45 && t > 0) return true;
    }
    return false;
  }

  /** On the move, a new way to where it is going (not more than once a second). */
  private replan(a: Agent): boolean {
    if (this.clock - a.planned < 1 || !a.path.length) return false;
    a.planned = this.clock;
    a.path = route(this.layout, a.pos, a.path[a.path.length - 1], this.still(a));
    return true;
  }

  /** Walk to a spot, then take a pose there. */
  private go(a: Agent, spot: Spot, pose: Pose, prop: Prop = null) {
    const far = Math.hypot(spot.at[0] - a.pos[0], spot.at[1] - a.pos[1]) > 0.05;
    a.path = far ? route(this.layout, a.pos, spot.at, this.still(a)) : [];
    a.arrive = { pose, face: spot.face, prop };
    a.unsay = null;
    if (!far) {
      a.pose = pose;
      a.face = spot.face;
      a.prop = prop;
    } else {
      a.pose = a.duty === 'patrol' || a.prop === 'headset' ? 'walk-phone' : 'walk';
    }
  }

  private seat(a: Agent): Spot {
    return this.layout.desks.get(a.id)?.seat ?? { at: a.pos, face: a.face };
  }

  /** From the board: each agent's duty. Changed duties send the agent to its place. */
  setDuties(duties: Map<string, { duty: Duty; card: Subtask | null }>) {
    for (const a of this.agents.values()) {
      const next = duties.get(a.id) ?? { duty: 'free' as Duty, card: null };
      a.card = next.card;
      a.bubble = BUBBLE[next.duty] ?? null;
      if (next.duty === a.duty) continue;
      a.duty = next.duty;
      this.release(a);
      this.startDuty(a);
    }
  }

  private startDuty(a: Agent) {
    const l = this.layout;
    const seat = this.seat(a);
    switch (a.duty) {
      case 'work':
        return this.go(a, seat, 'sit-type');
      case 'ask':
        return this.go(a, seat, 'sit-raise');
      case 'approve':
        return this.go(a, seat, 'stand-wave');
      case 'watch':
        a.nextToss = this.clock + 2 + this.rand(a) * 3;
        return this.go(a, seat, 'sit-feetup');
      case 'pr':
        return this.go(a, seat, 'sit-lean');
      case 'sleep':
        return this.go(a, seat, 'sit-sleep');
      case 'despair':
        return this.go(a, seat, 'sit-despair');
      case 'test':
        return this.go(a, l.testBench.spot, 'test');
      case 'whiteboard':
        return this.go(a, l.whiteboard.spots[0], 'whiteboard');
      case 'queue': {
        const slot = l.coffee.queue.findIndex((_, i) => this.hold(a, `queue-${i}`));
        return this.go(a, l.coffee.queue[Math.max(0, slot)], 'stand', 'mug');
      }
      case 'patrol':
        a.activity = 'rounds';
        a.until = this.clock;
        a.prop = 'headset';
        return;
      case 'free':
        a.activity = 'desk';
        a.until = this.clock + 4 + this.rand(a) * 6;
        return this.go(a, seat, 'sit-idle');
    }
  }

  /** The lead walks to someone's desk to hand over a card, then goes back to what it did. */
  handOff(leadId: string, toId: string) {
    const a = this.agents.get(leadId);
    const desk = this.layout.desks.get(toId);
    if (!a || !desk || leadId === toId) return;
    this.release(a);
    a.activity = 'handoff';
    a.until = this.clock + 9;
    const face = Math.atan2(desk.seat.at[0] - desk.aisle[0], desk.seat.at[1] - desk.aisle[1]);
    this.go(a, { at: desk.aisle, face }, 'stand-talk', 'headset');
  }

  /** The lead's round: from a random point of the patrol and on, walked around the furniture. */
  private rounds(a: Agent, extra: number): P[] {
    const p = this.layout.patrol;
    const pts = [...p.slice(Math.floor(this.rand(a) * p.length)), ...p.slice(0, extra)];
    return tour(this.layout, a.pos, pts, this.still(a));
  }

  /** Free and sitting or standing about: can be asked along for ping pong or a chat. */
  private idle(b: Agent): boolean {
    return b.duty === 'free' && !b.path.length && ['desk', 'sofa', 'window', 'water', 'stretch', 'dance', 'nap', 'coffee'].includes(b.activity) && !this.game?.players.includes(b.id);
  }

  /** Walk somewhere, by way of some points (round the ping pong table). */
  walk(a: Agent, spot: Spot, pose: Pose, prop: Prop, via: P[] = []) {
    if (!via.length) return this.go(a, spot, pose, prop);
    this.go(a, spot, pose, prop);
    a.path = tour(this.layout, a.pos, [...via, spot.at], this.still(a));
  }

  /** A game now, with the free first (for looking at the table: ?pingis=n). */
  play(n: number) {
    const all = [...this.agents.values()].filter((a) => a.role.kind !== 'lead').sort((a, b) => Number(b.duty === 'free') - Number(a.duty === 'free'));
    const ids = all.slice(0, Math.max(2, Math.min(7, n))).map((a) => a.id);
    if (this.game) this.endGame();
    for (const id of ids) this.release(this.agents.get(id)!);
    this.startGame(ids);
  }

  private startGame(ids: string[]) {
    for (const id of ids) {
      const a = this.agents.get(id)!;
      a.activity = 'pingpong';
      a.until = Infinity;
    }
    this.game = new PingPongGame(this, ids);
  }

  private endGame() {
    const g = this.game;
    this.game = null;
    if (!g) return;
    for (const id of g.players) {
      const a = this.agents.get(id);
      if (!a) continue;
      a.beat = null;
      a.hurry = false;
      // Off to something else, from wherever they are.
      if (a.path.length) {
        a.path = [];
        a.pose = 'stand';
      }
      if (a.activity === 'pingpong') {
        a.activity = '';
        a.until = this.clock;
      }
    }
  }

  /** Small talk with whoever is close and not busy: a line, and the other answers. */
  private chatter(a: Agent) {
    if (this.clock >= a.sayUntil && a.say) {
      a.say = null;
      if (a.unsay && a.pose === 'stand-talk' && !a.path.length) a.pose = a.unsay;
      a.unsay = null;
    }
    if (this.clock < a.nextSay || a.path.length) return;
    a.nextSay = this.clock + 4 + this.rand(a) * 7;
    const social = (x: Agent) => x.duty === 'free' || x.activity === 'visit' || this.held.get(`visit-${x.id}`) != null;
    if (!social(a) || a.pose === 'sofa-nap' || a.bubble) return;
    const near = [...this.agents.values()].find(
      (b) => b !== a && !b.path.length && !b.say && Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1]) < 1.8 && (social(b) || this.held.get(`visit-${b.id}`) === a.id),
    );
    if (!near || this.rand(a) > 0.7) return;
    a.say = line(this.game?.out.includes(a.id) ? 'watch' : a.activity, this.rand(a));
    a.sayUntil = this.clock + 2.8;
    // The other answers in a moment.
    near.nextSay = Math.min(near.nextSay, this.clock + 1.4);
    if (a.pose === 'stand' || a.pose === 'stand-look') {
      a.unsay = a.pose;
      a.pose = 'stand-talk';
    }
  }

  /** Free time: pick the next thing to do. */
  private pickActivity(a: Agent) {
    const l = this.layout;
    this.release(a);
    const options = ACTIVITIES.filter((x) => (x.lead ? a.role.kind === 'lead' : true));
    const total = options.reduce((s, x) => s + x.weight, 0);
    let r = this.rand(a) * total;
    let pick = options[0].name;
    for (const o of options) {
      r -= o.weight;
      if (r <= 0) {
        pick = o.name;
        break;
      }
    }
    const span = (min: number, max: number) => this.clock + min + this.rand(a) * (max - min);
    const seat = this.seat(a);
    a.activity = pick;
    a.until = span(18, 45);
    switch (pick) {
      case 'coffee':
        if (this.hold(a, 'coffee')) return this.go(a, l.coffee.machine, 'stand-drink', 'mug');
        break;
      case 'pingpong': {
        // One table: if it is taken, something else.
        if (this.game) break;
        const idle = [...this.agents.values()].filter((b) => b !== a && this.idle(b));
        if (!idle.length) break;
        // Now and then rundpingis, four to seven round the table.
        const round = idle.length >= 3 && this.rand(a) < 0.4;
        const t = l.pingpong.table;
        const near = idle.sort((x, y) => Math.hypot(x.pos[0] - t[0], x.pos[1] - t[1]) - Math.hypot(y.pos[0] - t[0], y.pos[1] - t[1]));
        const others = near.slice(0, round ? Math.min(idle.length, 3 + Math.floor(this.rand(a) * 4)) : 1);
        for (const o of others) this.release(o);
        this.startGame([a.id, ...others.map((o) => o.id)]);
        return;
      }
      case 'fridge': {
        if (!this.hold(a, 'fridge')) break;
        const f = l.decor.fridge.at;
        a.until = span(3, 5);
        // In front of the door, facing it.
        return this.go(a, { at: [f[0] - 0.8, f[1]], face: Math.PI / 2 }, 'stand-look');
      }
      case 'huddle': {
        // A few gather for a chat: by the water cooler, in the lounge, between the desks.
        // The nearest free corner.
        const i = l.huddles
          .map((h, k) => ({ k, d: this.held.has(`huddle-${k}`) ? Infinity : Math.hypot(h[0] - a.pos[0], h[1] - a.pos[1]) }))
          .reduce((best, x) => (x.d < best.d ? x : best), { k: -1, d: Infinity }).k;
        const idle = [...this.agents.values()].filter((b) => b !== a && this.idle(b) && b.activity !== 'sofa');
        if (i < 0 || !idle.length) break;
        this.hold(a, `huddle-${i}`);
        const who = [a, ...idle.slice(0, 1 + Math.floor(this.rand(a) * Math.min(3, idle.length)))];
        const c = l.huddles[i];
        const until = span(20, 45);
        // Each takes the place on the ring on the side they come from: nobody crosses it.
        const bearing = (b: Agent) => Math.atan2(b.pos[0] - c[0], b.pos[1] - c[1]);
        who.sort((x, y) => bearing(x) - bearing(y));
        const turn = bearing(who[0]);
        who.forEach((b, n) => {
          if (b !== a) this.release(b);
          const ang = turn + (n / who.length) * Math.PI * 2;
          const at: P = [c[0] + Math.sin(ang) * 0.5, c[1] + Math.cos(ang) * 0.5];
          b.activity = 'huddle';
          b.until = until;
          b.nextSay = this.clock + 2 + n * 1.5;
          this.go(b, { at, face: Math.atan2(c[0] - at[0], c[1] - at[1]) }, 'stand', this.rand(a) < 0.4 ? 'mug' : null);
        });
        return;
      }
      case 'sofa':
      case 'nap': {
        const i = l.sofa.seats.findIndex((_, k) => !this.held.has(`sofa-${k}`));
        if (i < 0 || !this.hold(a, `sofa-${i}`)) break;
        return this.go(a, l.sofa.seats[i], pick === 'nap' ? 'sofa-nap' : 'sofa-phone', pick === 'nap' ? null : 'phone');
      }
      case 'water': {
        const i = l.plants.findIndex((_, k) => !this.held.has(`plant-${k}`));
        if (i < 0 || !this.hold(a, `plant-${i}`)) break;
        a.until = span(10, 18);
        return this.go(a, l.plants[i], 'water', 'can');
      }
      case 'window': {
        const i = l.windows.findIndex((_, k) => !this.held.has(`window-${k}`));
        if (i < 0 || !this.hold(a, `window-${i}`)) break;
        return this.go(a, l.windows[i], 'stand-look', this.rand(a) < 0.5 ? 'mug' : null);
      }
      case 'chat': {
        // Two free agents meet at the whiteboard.
        const other = [...this.agents.values()].find((b) => b.id !== a.id && b.duty === 'free' && b.activity === 'desk');
        if (!other || this.held.has('wb-0') || this.held.has('wb-1')) break;
        this.hold(a, 'wb-0');
        this.release(other);
        other.holds = 'wb-1';
        this.held.set('wb-1', other.id);
        other.activity = 'chat';
        other.until = a.until;
        this.go(a, l.whiteboard.spots[0], 'stand-talk');
        this.go(other, l.whiteboard.spots[1], 'stand-talk');
        return;
      }
      case 'visit': {
        // Stand by a colleague's desk and chat, whatever they are doing.
        const others = [...this.agents.values()].filter((b) => b.id !== a.id && this.layout.desks.has(b.id));
        const b = others[Math.floor(this.rand(a) * others.length)];
        const desk = b && this.layout.desks.get(b.id);
        if (!desk || !this.hold(a, `visit-${b.id}`)) break;
        a.until = span(10, 20);
        // Beside the aisle spot, where the colleague would stand to stretch.
        const at: P = [desk.aisle[0] + 0.8, desk.aisle[1]];
        const face = Math.atan2(desk.seat.at[0] - at[0], desk.seat.at[1] - at[1]);
        return this.go(a, { at, face }, 'stand-talk', this.rand(a) < 0.4 ? 'mug' : null);
      }
      case 'stretch':
        a.until = span(6, 10);
        return this.go(a, { at: this.layout.desks.get(a.id)?.aisle ?? seat.at, face: seat.face + Math.PI }, 'stretch');
      case 'dance':
        a.until = span(6, 12);
        return this.go(a, { at: this.layout.desks.get(a.id)?.aisle ?? seat.at, face: 0 }, 'dance');
      case 'rounds':
        a.until = span(25, 50);
        a.prop = 'headset';
        a.path = this.rounds(a, this.layout.patrol.length);
        a.pose = 'walk-phone';
        a.arrive = { pose: 'stand-talk', face: 0, prop: 'headset' };
        return;
    }
    // Nothing free for that: at the desk, rocking the chair, on the phone, sipping.
    a.activity = 'desk';
    a.until = span(10, 25);
    const k = this.rand(a);
    this.go(a, seat, k < 0.35 ? 'sit-rock' : k < 0.6 ? 'sit-phone' : k < 0.8 ? 'sit-drink' : 'sit-idle', k < 0.6 && k >= 0.35 ? 'phone' : k >= 0.6 && k < 0.8 ? 'mug' : null);
  }

  /**
   * Where a walker actually goes: towards its next waypoint, bending around
   * people in the way. Everyone keeps to the right, so two meeting head on
   * pass each other instead of dancing. Returns a direction and a speed factor
   * (slower when it is crowded right ahead).
   */
  private steer(a: Agent, fx: number, fz: number, toGo: number): [number, number, number] {
    let sx = 0;
    let sz = 0;
    let slow = 1;
    for (const b of this.agents.values()) {
      if (b === a) continue;
      const ox = b.pos[0] - a.pos[0];
      const oz = b.pos[1] - a.pos[1];
      const dist = Math.hypot(ox, oz);
      if (dist > LOOK || dist < 1e-4 || dist > toGo + PERSONAL) continue;
      const ahead = (ox * fx + oz * fz) / dist; // 1 = straight ahead
      if (ahead < 0.2) continue;
      // Sideways from my path: which side of me is the other on?
      const side = -fz * ox + fx * oz; // > 0: on my left
      const away = side > 0.08 ? -1 : side < -0.08 ? 1 : -1; // dead ahead: go right
      const k = ahead * (1 - dist / LOOK) * 1.6;
      sx += -fz * away * k;
      sz += fx * away * k;
      // Someone walking towards me: also keep right; someone standing: just around.
      if (dist < PERSONAL * 1.4 && ahead > 0.7) slow = Math.min(slow, 0.45);
    }
    let vx = fx + sx;
    let vz = fz + sz;
    // Never backwards: at least a little progress towards the waypoint.
    const fwd = vx * fx + vz * fz;
    if (fwd < 0.25) {
      vx += fx * (0.25 - fwd);
      vz += fz * (0.25 - fwd);
    }
    const n = Math.hypot(vx, vz) || 1;
    return [vx / n, vz / n, slow];
  }

  /** Moves everyone along; dt and the clock in seconds. */
  update(dt: number) {
    this.clock += dt;
    if (this.game) {
      this.game.tick();
      if (this.game.done) this.endGame();
    }
    for (const a of this.agents.values()) {
      this.chatter(a);
      if (a.path.length) {
        const [tx, tz] = a.path[0];
        const dx = tx - a.pos[0];
        const dz = tz - a.pos[1];
        const d = Math.hypot(dx, dz);
        // Running round the ping pong table: a jog, 3 m/s; a sprint with three left (two crossings to get round).
        const step = (a.hurry ? ((this.game?.active.length ?? 9) <= 3 ? 4.2 : 3) : a.speed * (a.duty === 'patrol' || a.activity === 'rounds' ? 0.75 : 1)) * dt;
        // A corner on the way counts as passed a little early when the next one is in
        // plain sight: two walking the same way don't circle it shoving each other.
        // Someone has stopped right in the way since the walk was planned: find a way round.
        if (this.clock - a.planned > 1.5 && this.inTheWay(a)) {
          if (this.replan(a)) continue;
        }
        const early = a.path.length > 1 && d < 0.45 && sight(this.layout, a.pos, a.path[1]);
        if (d <= step || early) {
          if (!early) a.pos = [tx, tz];
          a.path.shift();
          if (!a.path.length) {
            a.hurry = false;
            a.pose = a.arrive.pose;
            a.face = a.arrive.face;
            a.prop = a.arrive.prop;
          }
        } else {
          const [vx, vz, slow] = this.steer(a, dx / d, dz / d, d);
          // On open floor, furniture is out of bounds. (The last leg of a path may end in
          // a chair or on the sofa, and the first may start there: no rule inside.)
          const open = !solid(this.layout, a.pos);
          let nx = a.pos[0] + vx * step * slow;
          let nz = a.pos[1] + vz * step * slow;
          if (open && solid(this.layout, [nx, nz])) {
            // Dodging someone would go into furniture: walk the path as planned instead,
            // and if that is blocked too (pushed off the path), find a new way.
            nx = a.pos[0] + (dx / d) * step * slow;
            nz = a.pos[1] + (dz / d) * step * slow;
            const intoSeat = a.path.length === 1 && solid(this.layout, a.path[0]);
            if (!intoSeat && solid(this.layout, [nx, nz])) {
              // Off the path at the edge of something: slide along it, as close to the
              // way as the furniture allows; boxed in, plan a new way.
              let slid = false;
              for (const k of [1, -1, 2, -2, 3, -3, 4, -4]) {
                const c = Math.cos(k * 0.4);
                const sn = Math.sin(k * 0.4);
                const ux = (dx / d) * c - (dz / d) * sn;
                const uz = (dx / d) * sn + (dz / d) * c;
                const q: P = [a.pos[0] + ux * step * slow, a.pos[1] + uz * step * slow];
                if (!solid(this.layout, q)) {
                  [nx, nz] = q;
                  slid = true;
                  break;
                }
              }
              if (!sight(this.layout, a.pos, a.path[0]) && this.replan(a)) continue;
              if (!slid) {
                nx = a.pos[0];
                nz = a.pos[1];
              }
            }
          }
          const px = nx;
          const pz = nz;
          // Never inside someone else: pushed back out to arm's length. Only sitting down
          // is exempt: chairs and sofa seats are where they are.
          const last = a.path.length === 1;
          const sits = last && /^(sit|sofa)/.test(a.arrive.pose);
          let pushed = false;
          // A few passes: out of one person may be into another (a group chatting).
          for (let pass = 0; pass < 3 && !sits; pass++) {
            let moved = false;
            for (const b of this.agents.values()) {
              if (b === a) continue;
              const ox = nx - b.pos[0];
              const oz = nz - b.pos[1];
              const od = Math.hypot(ox, oz);
              if (od < PERSONAL && od > 1e-4) {
                pushed = moved = true;
                nx = b.pos[0] + (ox / od) * PERSONAL;
                nz = b.pos[1] + (oz / od) * PERSONAL;
              }
            }
            if (!moved) break;
          }
          // Still too close to someone after that: hold still rather than walk into them.
          if (!sits && [...this.agents.values()].some((b) => b !== a && Math.hypot(nx - b.pos[0], nz - b.pos[1]) < PERSONAL * 0.95 && Math.hypot(nx - b.pos[0], nz - b.pos[1]) < Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]))) {
            nx = a.pos[0];
            nz = a.pos[1];
          }
          // Pushed into furniture: stay put instead.
          if (open && solid(this.layout, [nx, nz]) && !solid(this.layout, [px, pz])) {
            nx = a.pos[0];
            nz = a.pos[1];
          }
          // Held up for long (two face to face in a narrow gap, a crowd at the coffee):
          // squeeze past rather than stand there for ever.
          // Once squeezing, it keeps on until nobody is in the way any more.
          // Not getting closer (standing, or dancing round someone in a narrow gap).
          if (d - Math.hypot(tx - nx, tz - nz) < step * 0.25) a.stall += dt;
          else if (!pushed) a.stall = 0;
          // Held up a while: maybe there is another way round them.
          if (a.stall > 1.2 && this.replan(a)) continue;
          if (a.stall > 4) {
            nx = px;
            nz = pz;
            pushed = false;
          }
          // (Not at the ping pong table: the game needs them on their exact spot.)
          if (pushed && last && d < 0.9 && a.activity !== 'pingpong') {
            // Someone is standing where I was going: this is close enough.
            a.path = [];
            a.hurry = false;
            a.pose = a.arrive.pose;
            a.face = a.arrive.face;
            a.prop = a.arrive.prop;
            continue;
          }
          a.pos = [nx, nz];
          // Turn smoothly towards where it walks.
          const want = Math.atan2(vx, vz);
          let diff = want - a.face;
          diff = Math.atan2(Math.sin(diff), Math.cos(diff));
          a.face += diff * Math.min(1, dt * 8);
        }
        continue;
      }
      // Watching: a paper ball at the nearest bin now and then.
      if (a.pose === 'sit-feetup' && this.clock >= a.nextToss) {
        a.nextToss = this.clock + 4 + this.rand(a) * 6;
        const bin = this.layout.bins.reduce((best, b) => (Math.hypot(b[0] - a.pos[0], b[1] - a.pos[1]) < Math.hypot(best[0] - a.pos[0], best[1] - a.pos[1]) ? b : best), this.layout.bins[0]);
        const hit = this.rand(a) < 0.55;
        this.balls.push({
          from: [a.pos[0], 1.15, a.pos[1]],
          to: hit ? [bin[0], 0.35, bin[1]] : [bin[0] + (this.rand(a) - 0.5) * 1.2, 0.05, bin[1] + 0.4 + this.rand(a) * 0.5],
          start: this.clock,
          duration: 1.1,
          hit,
        });
        if (this.balls.length > 12) this.balls.shift();
      }
      if ((a.duty === 'free' || a.duty === 'patrol') && this.clock >= a.until) {
        if (this.game?.players.includes(a.id)) continue; // The game decides when it ends.
        if (a.activity === 'fridge') {
          // Door shut, a soda in hand, back to the desk with it.
          this.release(a);
          a.activity = 'desk';
          a.until = this.clock + 12 + this.rand(a) * 12;
          this.go(a, this.seat(a), 'sit-drink', 'soda');
          continue;
        }
        if (a.duty === 'patrol') {
          a.activity = 'rounds';
          a.until = this.clock + 20 + this.rand(a) * 20;
          a.path = this.rounds(a, 2);
          a.pose = 'walk-phone';
          a.prop = 'headset';
          a.arrive = { pose: 'stand-talk', face: 0, prop: 'headset' };
          continue;
        }
        this.pickActivity(a);
      }
      if (a.activity === 'handoff' && this.clock >= a.until) {
        a.activity = '';
        this.startDuty(a);
      }
    }
  }
}

/** Office small talk, by what they are doing. */
const LINES: Record<string, string[]> = {
  pingpong: ['Spring!', 'Kom igen!', 'Ojdå 😅', 'Snyggt!', 'Haha', 'Nu jäklar', 'Hinner du?'],
  watch: ['Heja!', 'Snyggt!', 'Bra boll!', 'Oj!', '👏', 'Kom igen!', 'Revansch sen!'],
  coffee: ['Kaffe?', 'Slut på mjölk igen…', 'Dubbel espresso', 'Mm ☕'],
  default: [
    'Såg du PR:en?',
    'Haha 😂',
    'Lunch?',
    'Funkar lokalt…',
    'Vem bröt bygget?',
    'Snart helg!',
    'Testerna är gröna ✅',
    'Match efter?',
    'Mm, precis',
    'Nä men seriöst',
    '👍',
    'Har du en minut?',
    'Den där buggen…',
    'Kul!',
    'Vad tycker du?',
    'Kör!',
  ],
};

function line(what: string, r: number): string {
  const set = LINES[what] ?? LINES.default;
  return set[Math.floor(r * set.length) % set.length];
}
