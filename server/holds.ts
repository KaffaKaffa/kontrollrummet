/**
 * Work besides the agents that a restart must wait for (a build streaming into
 * a release job): each part reports how many it has running. Its own module,
 * so the restart can ask without importing everything that runs.
 */
const holds: (() => number)[] = [];

export function holdRestart(count: () => number) {
  holds.push(count);
}

export const heldBy = () => holds.reduce((n, count) => n + count(), 0);
