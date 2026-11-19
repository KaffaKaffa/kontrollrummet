import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { Approval, Role, Subtask, Task } from '../api.ts';
import { Director, dutyOf, type Agent } from './director.ts';
import { buildLayout } from './layout.ts';

/**
 * Life in the office goes on whichever way it is shown: one director per
 * team, kept here and moved along every frame, so the desks in the list can
 * say what the people in the 3D office are up to (and the 3D view picks up
 * where they are when it opens). No three.js here: the list stays light.
 */

const lives = new Map<string, Director>();
let running = false;

/** ?pingis=5 in the address: a game with that many players right away (to look at the table). */
export const PINGIS = Number(new URLSearchParams(location.search).get('pingis')) || 0;
const played = new WeakSet<Director>();

function run() {
  if (running) return;
  running = true;
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    for (const d of lives.values()) {
      d.update(dt);
      if (PINGIS && !played.has(d) && d.clock > 1.5) {
        played.add(d);
        d.play(PINGIS);
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** The team's office, its duties kept in step with the board. */
export function useOfficeLife(team: string, roles: Role[], subtasks: Subtask[], tasks: Task[], approvals: Approval[]): Director {
  const roleKey = roles.map((r) => `${r.id}:${r.kind}`).join(',');
  const director = useMemo(() => {
    const key = `${team}|${roleKey}`;
    let d = lives.get(key);
    if (!d) {
      // A team's roles changed: its old office goes.
      for (const k of lives.keys()) if (k.startsWith(`${team}|`)) lives.delete(k);
      d = new Director(buildLayout(roles), roles);
      lives.set(key, d);
    }
    run();
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team, roleKey]);

  // The cards decide each agent's duty; a new card from the lead sends it over to hand it out.
  const seen = useRef<Set<number> | null>(null);
  useEffect(() => {
    const duties = new Map(roles.map((r) => [r.id, dutyOf(r, subtasks, tasks, approvals)]));
    director.setDuties(duties);
    const ids = new Set(subtasks.map((s) => s.id));
    if (seen.current) {
      const leads = new Set(roles.filter((r) => r.kind === 'lead').map((r) => r.id));
      for (const s of subtasks) {
        if (seen.current.has(s.id) || s.parentId == null) continue;
        const parent = subtasks.find((p) => p.id === s.parentId);
        if (parent && leads.has(parent.agent)) director.handOff(parent.agent, s.agent);
      }
    }
    seen.current = ids;
  }, [director, roles, subtasks, tasks, approvals]);
  return director;
}

/** Re-render now and then, to follow the office. */
export function useLifeTick(ms = 1000) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const t = setInterval(bump, ms);
    return () => clearInterval(t);
  }, [ms]);
}

const names = (d: Director, ids: string[]) => {
  const list = ids.map((id) => d.agents.get(id)?.role.name ?? id);
  return list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} och ${list[list.length - 1]}`;
};

/** Duties that leave no running card on the desk, as the office shows them. */
const DUTY: Partial<Record<Agent['duty'], string>> = {
  queue: 'Står i kö vid kaffemaskinen tills det blir hens tur',
  pr: 'Lutar sig bakåt med händerna bakom huvudet, väntar på granskning',
  sleep: 'Sover på skrivbordet: kvoten är slut',
  despair: 'Huvudet i händerna efter ett kort som gick fel',
};

/** Where a walk is going, by what it is for. */
const HEADING: Record<string, string> = {
  coffee: 'kaffemaskinen',
  pingpong: 'pingisbordet',
  sofa: 'soffan',
  nap: 'soffan',
  window: 'fönstret',
  water: 'blommorna',
  fridge: 'kylskåpet',
  chat: 'whiteboarden',
  desk: 'skrivbordet',
  rounds: 'nästa skrivbord',
};

/**
 * What someone is doing in the office right now, in a few words, for a
 * free agent's desk: the game of ping pong with lives and score, the coffee,
 * the chat and who with. Null when the cards say what they do.
 */
export function doing(d: Director, id: string): string | null {
  const a = d.agents.get(id);
  if (!a) return null;
  const g = d.game;
  if (g && g.players.includes(id)) {
    const others = g.players.filter((x) => x !== id && !g.out.includes(x));
    if (g.out.includes(id)) return `Utslagen ur rundpingisen, hejar på ${names(d, g.active)}`;
    if (g.mode === 'round') {
      const lives = g.lives.get(id) ?? 0;
      const lead = a.hurry ? 'Springer runt pingisbordet' : g.q[0][0] === id || g.q[1][0] === id ? 'Står vid bordet i rundpingisen' : 'Väntar på sin tur i rundpingisen';
      return `${lead} · ${'❤️'.repeat(Math.max(0, lives))}`;
    }
    const other = others[0];
    const score = `${g.score.get(id) ?? 0}–${other ? (g.score.get(other) ?? 0) : 0}`;
    const final = g.out.length > 0;
    return `${final ? 'Spelar pingisfinal' : 'Spelar pingis'} mot ${names(d, other ? [other] : [])} · ${score}`;
  }
  const duty = DUTY[a.duty];
  if (duty) return duty;
  if (a.path.length) {
    if (a.activity === 'visit') return `På väg till ${visited(d, a)}`;
    if (a.activity === 'huddle') return 'På väg till ett snack';
    if (a.activity === 'handoff') return 'Går över med ett nytt kort';
    const to = HEADING[a.activity];
    return to ? `På väg till ${to}` : 'Går genom kontoret';
  }
  switch (a.activity) {
    case 'coffee':
      return 'Dricker kaffe vid maskinen';
    case 'fridge':
      return 'Letar i kylskåpet';
    case 'sofa':
      return 'Scrollar mobilen i soffan';
    case 'nap':
      return 'Tar en tupplur i soffan';
    case 'window':
      return 'Tittar ut genom fönstret';
    case 'water':
      return 'Vattnar blommorna';
    case 'stretch':
      return 'Sträcker på sig';
    case 'dance':
      return 'Dansar 💃';
    case 'rounds':
      return 'Går runt med headset och följer upp';
    case 'handoff':
      return 'Lämnar över ett kort';
    case 'visit':
      return `Snackar vid ${visited(d, a)}`;
    case 'chat':
    case 'huddle': {
      const with_ = [...d.agents.values()].filter((b) => b !== a && b.activity === a.activity && !b.path.length && Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1]) < 2);
      if (a.activity === 'chat') return with_.length ? `Ritar på whiteboarden med ${names(d, with_.map((b) => b.id))}` : 'Står vid whiteboarden';
      return with_.length ? `Snackar med ${names(d, with_.map((b) => b.id))}` : 'Väntar på de andra för ett snack';
    }
  }
  switch (a.pose) {
    case 'sit-rock':
      return 'Gungar på stolen';
    case 'sit-phone':
      return 'Kollar mobilen';
    case 'sit-drink':
      return a.prop === 'soda' ? 'Dricker en läsk vid skrivbordet' : 'Tar en kaffe vid skrivbordet';
    default:
      return 'Sitter vid skrivbordet';
  }
}

/** Whose desk someone visits (they hold `visit-<id>`). */
function visited(d: Director, a: Agent): string {
  const id = a.holds?.startsWith('visit-') ? a.holds.slice(6) : '';
  const b = d.agents.get(id);
  return b ? `${b.role.name}s skrivbord` : 'en kollegas skrivbord';
}
