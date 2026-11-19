import type { P } from './layout.ts';

/**
 * Ping pong timing. The pingpong clip (Meshy text-to-motion) has strokes at
 * odd intervals, so the game plays one forehand out of it on a loop
 * (measured with public/office/measure.html): from 1.93 s to 3.33 s, the
 * paddle meeting the ball at 2.40 s. Both players' clips and the ball run on
 * the director's clock, so every hit lands on the paddle.
 */
export const STROKE = {
  /** The loop in the clip (seconds). */
  start: 1.933,
  length: 1.4,
  /** When in the loop the paddle meets the ball. */
  contact: 2.4 - 1.933,
  /** Played a little slower than recorded: a friendly office rally. */
  speed: 0.8,
};

/** Seconds between two hits from the same end. */
export const PERIOD = STROKE.length / STROKE.speed;
/** Seconds the ball takes from one end to the other. */
export const HALF = PERIOD / 2;
/**
 * Round the table the rally goes a little slower: whoever hit has a lap of
 * about six metres to run before their next turn (with four players, three
 * crossings later).
 */
export const ROUND_HALF = STROKE.length / 0.62 / 2;

/** Regulation size (metres). */
export const TABLE = { length: 2.74, width: 1.525, height: 0.76, net: 0.1525 };

/**
 * Where the paddle's face is at contact, relative to the player's feet: to
 * the right (x < 0), up, and forward (+z). The same for everyone: all share
 * one skeleton.
 */
export const PADDLE_AT_CONTACT: [number, number, number] = [-0.76, 0.89, 0.88];

/** How far through the stroke loop (0..1) a player at an end is. */
export function beat(clock: number, t0: number, end: 0 | 1, half = HALF): number {
  const t = (clock - t0 - end * half) / (2 * half) + STROKE.contact / STROKE.length;
  return t - Math.floor(t);
}

/** The world point of the paddle at contact for someone standing at a spot. */
export function contactPoint(at: P, face: number): [number, number, number] {
  const [lx, y, lz] = PADDLE_AT_CONTACT;
  const c = Math.cos(face);
  const s = Math.sin(face);
  return [at[0] + lx * c + lz * s, y, at[1] - lx * s + lz * c];
}

/**
 * The ball between two contact points: over the net, one bounce on the far
 * half, up to the other paddle. u runs 0..1.
 */
export function ballAt(from: [number, number, number], to: [number, number, number], u: number): [number, number, number] {
  const x = from[0] + (to[0] - from[0]) * u;
  const z = from[2] + (to[2] - from[2]) * u;
  const bounce = 0.66;
  const top = TABLE.height + 0.02;
  let y: number;
  if (u < bounce) {
    const s = u / bounce;
    y = from[1] + (top - from[1]) * s + 0.32 * 4 * s * (1 - s);
  } else {
    const s = (u - bounce) / (1 - bounce);
    y = top + (to[1] - top) * s + 0.22 * 4 * s * (1 - s);
  }
  return [x, y, z];
}
