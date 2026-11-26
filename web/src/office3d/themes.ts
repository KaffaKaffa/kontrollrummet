import type { Role } from '../api.ts';
import type { Palette } from './props.tsx';

/**
 * How the office looks, picked per project: the ordinary office, or the
 * Christmas workshop. A theme swaps the furniture by model id, who the team
 * is drawn as, and the colours of the floor, walls and sky. A model the theme
 * names that is not built yet falls back to the office's own.
 */

export type OfficeThemeId = 'kontor' | 'verkstad';

export const OFFICE_THEMES: { id: OfficeThemeId; label: string }[] = [
  { id: 'kontor', label: 'Kontoret' },
  { id: 'verkstad', label: 'Tomteverkstaden' },
];

export interface Theme {
  id: OfficeThemeId;
  /** Office model id → the theme's. */
  models: Record<string, string>;
  /** The workstation on a role's desk, by the template it does the job of. */
  workstation: (job: string, kind: string) => string | null;
  /** The character a role is drawn as, or null for its own. */
  character: (role: Role, index: number) => string | null;
  /** The colour of the cap on a role's head, or null for none. */
  hat: (role: Role, index: number) => string | null;
  /** Which of the built paintings hang on the walls. */
  art: (id: string) => boolean;
  colors: Palette;
  sky: string;
  /** The door that opens when someone goes for a snack. */
  fridgeDoor: string;
}

const XMAS = 'xmas_';

const office: Theme = {
  id: 'kontor',
  models: {},
  workstation: (job, kind) => (kind === 'lead' ? 'ws_lead' : `ws_${job}`),
  character: () => null,
  hat: () => null,
  art: (id) => !id.startsWith(XMAS),
  colors: {},
  sky: '#f4ede4',
  fridgeDoor: '#a9dcc6',
};

/** Cap colours, in turn: red, green, blue, mustard, plum, teal, orange, grey. */
const CAPS = ['#c62828', '#2e7d32', '#1f5fa8', '#d9a53a', '#7b3f7a', '#2a8c86', '#d8642a', '#7a7a80'];

/** What each kind of job does at the workbench. */
const BENCH: Record<string, string> = {
  designer: 'xmas_ws_paint',
  web: 'xmas_ws_paint',
  tester: 'xmas_ws_wrap',
  bug: 'xmas_ws_wrap',
  docs: 'xmas_ws_wrap',
  architect: 'xmas_ws_toys',
  backend: 'xmas_ws_toys',
  devops: 'xmas_ws_toys',
  windows: 'xmas_ws_toys',
  android: 'xmas_ws_toys',
};

const workshop: Theme = {
  id: 'verkstad',
  models: {
    desk: 'xmas_bench',
    lead_desk: 'xmas_lead_bench',
    office_chair: 'xmas_chair',
    plant_monstera: 'xmas_tree',
    plant_fiddle: 'xmas_tree_small',
    plant_snake: 'xmas_poinsettia',
    bookshelf: 'xmas_toyshelf',
    kitchen: 'xmas_kitchen',
    coffee_machine: 'xmas_glogg',
    fridge: 'xmas_pantry',
    water_cooler: 'xmas_fireplace',
    sofa: 'xmas_sofa',
    coffee_table: 'xmas_presents',
    armchair: 'xmas_armchair',
    floor_lamp: 'xmas_lantern',
    bean_bag: 'xmas_sack',
    whiteboard: 'xmas_wishlist',
    bin: 'xmas_basket',
  },
  workstation: (job, kind) => (kind === 'lead' ? 'xmas_ws_lead' : (BENCH[job] ?? 'xmas_ws_laptop')),
  // The lead is Santa; everyone else a nisse, the two kinds taking turns.
  character: (role, index) => (role.kind === 'lead' ? 'tomte' : index % 2 ? 'nisse-2' : 'nisse'),
  hat: (role, index) => (role.kind === 'lead' ? null : CAPS[index % CAPS.length]),
  art: (id) => id.startsWith(XMAS),
  colors: {
    floor: '#b98a5e',
    floorEdge: '#7a5a3e',
    wall: '#d9b48a',
    wood: '#7a5a3e',
    rug: '#a8322a',
    glass: '#2c3e66',
    glassGlow: '#4a6aa8',
  },
  sky: '#2a3350',
  fridgeDoor: '#8e2b25',
};

const THEMES: Record<OfficeThemeId, Theme> = { kontor: office, verkstad: workshop };

/** ?tema=<id> in the address shows that look whatever the project has picked, for previewing it. */
const PREVIEW = new URLSearchParams(location.search).get('tema');

export const themeOf = (id: string | null | undefined): Theme => THEMES[(PREVIEW ?? id) as OfficeThemeId] ?? office;
