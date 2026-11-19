import type { Role } from '../api.ts';

/**
 * How each library character is drawn while it has no 3D model of its own:
 * the colours of its skin, hair and clothes, matching its portrait. A team
 * role uses the template with its id, or the one named in `character:`.
 */
export interface Style {
  skin: string;
  hair: string;
  top: string;
  bottom: string;
  shoes: string;
  /** Height relative to an average adult. */
  height: number;
  /** Build: 1 slim, 1.25 heavyset. */
  width: number;
  /** Hair shape on the placeholder. */
  hairdo: 'short' | 'long' | 'bun' | 'bald' | 'afro' | 'cap' | 'beret' | 'curly';
}

const STYLES: Record<string, Style> = {
  teamleader: { skin: '#7a4a33', hair: '#2b2220', top: '#24345e', bottom: '#2b2b33', shoes: '#1d1d22', height: 1.06, width: 1, hairdo: 'afro' },
  architect: { skin: '#f1c4a4', hair: '#f4f1ec', top: '#d8c7a8', bottom: '#5b5048', shoes: '#4a3b30', height: 0.97, width: 1.2, hairdo: 'bald' },
  bug: { skin: '#a8714f', hair: '#1f1715', top: '#c9a77a', bottom: '#3b3530', shoes: '#3a2a20', height: 0.98, width: 0.92, hairdo: 'long' },
  designer: { skin: '#f0cfa8', hair: '#f4a7c3', top: '#1f1f22', bottom: '#2a2a2e', shoes: '#111', height: 0.9, width: 0.88, hairdo: 'beret' },
  tester: { skin: '#c99272', hair: '#cfcfd4', top: '#f2efe9', bottom: '#2b2b2f', shoes: '#333', height: 0.95, width: 1.15, hairdo: 'short' },
  web: { skin: '#f6d2bc', hair: '#d4622b', top: '#b8a3e0', bottom: '#3b4a6b', shoes: '#f0f0f0', height: 0.96, width: 1, hairdo: 'curly' },
  backend: { skin: '#5e3a28', hair: '#1c1512', top: '#3a3d45', bottom: '#2a2c33', shoes: '#1b1b1f', height: 1.02, width: 1.3, hairdo: 'bun' },
  ios: { skin: '#c8956f', hair: '#1d1714', top: '#18181b', bottom: '#2a2a30', shoes: '#f2f2f2', height: 1.0, width: 0.95, hairdo: 'curly' },
  android: { skin: '#d9a77c', hair: '#222', top: '#55b84b', bottom: '#2f3540', shoes: '#f2f2f2', height: 0.88, width: 0.88, hairdo: 'short' },
  mac: { skin: '#f3cfb3', hair: '#e2c27a', top: '#8fb2d6', bottom: '#5a4a3a', shoes: '#6b4a32', height: 1.1, width: 0.9, hairdo: 'bun' },
  windows: { skin: '#a8714f', hair: '#8f8f95', top: '#a9c8ec', bottom: '#30343c', shoes: '#2b2118', height: 0.97, width: 1.3, hairdo: 'short' },
  fullstack: { skin: '#b07b58', hair: '#2a1d17', top: '#c0392b', bottom: '#2f3a52', shoes: '#f0f0f0', height: 0.98, width: 1, hairdo: 'afro' },
  devops: { skin: '#f0cfa8', hair: '#1a1a1a', top: '#1f1f22', bottom: '#5b5a3f', shoes: '#2a2a2a', height: 0.98, width: 0.92, hairdo: 'cap' },
  docs: { skin: '#f4d3bd', hair: '#b9b9be', top: '#d9a53a', bottom: '#5b4a5a', shoes: '#5a3a2a', height: 0.88, width: 1.15, hairdo: 'bun' },
};

/** The library character a role is drawn as. */
/** ?gubbe=<id> in the address shows everyone as that character, for previewing a new model. */
const PREVIEW = new URLSearchParams(location.search).get('gubbe');

export function characterOf(role: Role): string {
  if (PREVIEW) return PREVIEW;
  if (role.character) return role.character;
  if (STYLES[role.id]) return role.id;
  // A role with its own id: the template of its kind.
  return { lead: 'teamleader', architect: 'architect', bug: 'bug', tester: 'tester', designer: 'designer', app: 'fullstack' }[role.kind];
}

export function styleOf(role: Role): Style {
  return STYLES[characterOf(role)] ?? STYLES.fullstack;
}

/** The 3D model, once Meshy has made it (scripts/characters.mjs). */
export const modelUrl = (character: string) => `/characters/${character}.glb`;
export const ANIMATIONS_URL = '/characters/animations.glb';
