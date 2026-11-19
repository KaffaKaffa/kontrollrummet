import { RoundedBox } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { TABLE } from './pingpong.ts';
import type { Layout, P } from './layout.ts';

/**
 * The office's furniture, built in code in the same soft clay look as the
 * characters: rounded shapes, matte colours, a warm pastel palette.
 */

export const C = {
  floor: '#efe5d8',
  floorEdge: '#d8c7b1',
  wall: '#f3ece4',
  desk: '#d9b38c',
  deskLeg: '#8c7a6b',
  chair: '#4d5b7c',
  chairLead: '#7c4d5b',
  screen: '#22252c',
  screenOn: '#7fd3ff',
  keyboard: '#e9e6e1',
  green: '#7fb36a',
  greenDark: '#4f8a49',
  pot: '#c9744f',
  sofa: '#e79f8f',
  pingpong: '#3f7f6f',
  net: '#f2f2f2',
  metal: '#9aa1ab',
  glass: '#bfe3ff',
  rug: '#c9d8e8',
  wood: '#b98e66',
  whiteboard: '#fbfbfb',
  bin: '#6c7a89',
  coffee: '#3a3d45',
  mugs: ['#f2c14e', '#e06c75', '#61afef', '#98c379'],
};

function Mat({ color, rough = 0.85, emissive, emissiveIntensity = 0 }: { color: string; rough?: number; emissive?: string; emissiveIntensity?: number }) {
  return <meshStandardMaterial color={color} roughness={rough} metalness={0} emissive={emissive ?? '#000000'} emissiveIntensity={emissiveIntensity} />;
}

const at = (p: P, y = 0): [number, number, number] => [p[0], y, p[1]];

export function Floor({ layout }: { layout: Layout }) {
  const w = layout.maxX - layout.minX;
  const d = layout.maxZ - layout.minZ;
  const cx = (layout.maxX + layout.minX) / 2;
  const cz = (layout.maxZ + layout.minZ) / 2;
  return (
    <group>
      {/* The floor as a thick slab, like a diorama base. */}
      <RoundedBox args={[w, 0.4, d]} radius={0.15} position={[cx, -0.2, cz]} receiveShadow>
        <Mat color={C.floor} />
      </RoundedBox>
      <RoundedBox args={[w + 0.3, 0.3, d + 0.3]} radius={0.12} position={[cx, -0.42, cz]}>
        <Mat color={C.floorEdge} />
      </RoundedBox>
      {/* A rug under the lounge. */}
      <RoundedBox args={[6.6, 0.02, 4.4]} radius={0.01} position={[layout.pingpong.table[0] - 0.4, 0.01, 0.2]} receiveShadow>
        <Mat color={C.rug} />
      </RoundedBox>
    </group>
  );
}

export function Walls({ layout }: { layout: Layout }) {
  const w = layout.maxX - layout.minX;
  const cx = (layout.maxX + layout.minX) / 2;
  const z = layout.minZ;
  return (
    <group>
      {/* The back wall with windows, and a low wall at the left. */}
      <RoundedBox args={[w, 2.9, 0.22]} radius={0.06} position={[cx, 1.45, z - 0.11]} receiveShadow castShadow>
        <Mat color={C.wall} />
      </RoundedBox>
      {layout.windows.map((win, i) => (
        <group key={i} position={[win.pane, 1.65, z + 0.01]}>
          <RoundedBox args={[2.2, 1.4, 0.06]} radius={0.04}>
            <Mat color={C.wood} />
          </RoundedBox>
          <mesh position={[0, 0, 0.035]}>
            <planeGeometry args={[2.0, 1.2]} />
            <meshStandardMaterial color={C.glass} emissive="#dff2ff" emissiveIntensity={0.6} roughness={0.2} />
          </mesh>
        </group>
      ))}
      <RoundedBox args={[0.22, 1.2, layout.maxZ - layout.minZ]} radius={0.06} position={[layout.minX - 0.11, 0.6, (layout.maxZ + layout.minZ) / 2]} receiveShadow>
        <Mat color={C.wall} />
      </RoundedBox>
    </group>
  );
}

/** A desk with a screen, keyboard and mug. The screen glows while its owner works. */
export function Desk({ at: p, face, lead, on, bare, top }: { at: P; face: number; lead?: boolean; on: () => boolean; bare?: boolean; top?: boolean }) {
  const screen = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(() => {
    if (!screen.current) return;
    const target = on() ? 0.9 : 0.05;
    screen.current.emissiveIntensity += (target - screen.current.emissiveIntensity) * 0.08;
  });
  const width = lead ? 1.9 : 1.5;
  return (
    <group position={at(p)} rotation={[0, face, 0]}>
      {/* top: false when the desk itself is a model; bare: when the workstation on it is. */}
      {top !== false && (
        <>
      <RoundedBox args={[width, 0.06, 0.75]} radius={0.025} position={[0, 0.74, 0]} castShadow receiveShadow>
        <Mat color={lead ? C.wood : C.desk} />
      </RoundedBox>
      {[-1, 1].map((sx) => (
        <RoundedBox key={sx} args={[0.06, 0.72, 0.68]} radius={0.02} position={[sx * (width / 2 - 0.08), 0.36, 0]} castShadow>
          <Mat color={C.deskLeg} />
        </RoundedBox>
      ))}
        </>
      )}
      {!bare && (
        <>
      {/* Screen on a stand, at the far edge, facing the seat. */}
      <group position={[0, 0.77, 0.22]}>
        <RoundedBox args={[0.12, 0.2, 0.08]} radius={0.02} position={[0, 0.1, 0]}>
          <Mat color={C.metal} />
        </RoundedBox>
        <RoundedBox args={[0.7, 0.42, 0.05]} radius={0.03} position={[0, 0.38, 0]} castShadow>
          <Mat color={C.screen} />
        </RoundedBox>
        <mesh position={[0, 0.38, -0.03]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[0.62, 0.34]} />
          <meshStandardMaterial ref={screen} color="#1b2230" emissive={C.screenOn} emissiveIntensity={0.05} roughness={0.4} />
        </mesh>
      </group>
      <RoundedBox args={[0.46, 0.025, 0.15]} radius={0.01} position={[0, 0.785, -0.06]}>
        <Mat color={C.keyboard} />
      </RoundedBox>
      <mesh position={[width / 2 - 0.25, 0.83, -0.12]} castShadow>
        <cylinderGeometry args={[0.045, 0.04, 0.1, 16]} />
        <Mat color={C.mugs[Math.abs(Math.round(p[0] * 7 + p[1] * 3)) % C.mugs.length]} />
      </mesh>
        </>
      )}
    </group>
  );
}

/** An office chair; it follows its sitter (rocking, turning) through `pose`. */
export function Chair({ lead, pose, model }: { lead?: boolean; pose: () => { at: P; face: number; tilt: number }; model?: ReactNode }) {
  const g = useRef<THREE.Group>(null);
  const back = useRef<THREE.Group>(null);
  useFrame(() => {
    const p = pose();
    if (!g.current || !back.current) return;
    g.current.position.set(p.at[0], 0, p.at[1]);
    g.current.rotation.y = p.face;
    back.current.rotation.x = -0.12 - p.tilt;
    // A model chair has no separate backrest: the whole chair leans a little.
    if (model) g.current.rotation.x = -p.tilt * 0.35;
  });
  const color = lead ? C.chairLead : C.chair;
  if (model)
    return (
      <group ref={g}>
        {/* Meshy models face +z, like the sitter: the backrest is behind them. */}
        {model}
        <group ref={back} />
      </group>
    );
  return (
    <group ref={g}>
      <mesh position={[0, 0.25, 0]} castShadow>
        <cylinderGeometry args={[0.035, 0.035, 0.42, 10]} />
        <Mat color={C.metal} />
      </mesh>
      <mesh position={[0, 0.04, 0]}>
        <cylinderGeometry args={[0.28, 0.3, 0.04, 5]} />
        <Mat color={C.metal} />
      </mesh>
      <RoundedBox args={[0.52, 0.09, 0.5]} radius={0.04} position={[0, 0.47, 0]} castShadow>
        <Mat color={color} />
      </RoundedBox>
      <group ref={back} position={[0, 0.5, -0.24]}>
        <RoundedBox args={[0.5, 0.62, 0.08]} radius={0.04} position={[0, 0.33, 0]} castShadow>
          <Mat color={color} />
        </RoundedBox>
      </group>
    </group>
  );
}

export function Bin({ at: p }: { at: P }) {
  return (
    <mesh position={at(p, 0.2)} castShadow receiveShadow>
      <cylinderGeometry args={[0.2, 0.16, 0.4, 20, 1, true]} />
      <meshStandardMaterial color={C.bin} roughness={0.8} side={THREE.DoubleSide} />
    </mesh>
  );
}

export function Plant({ at: p, size = 1 }: { at: P; size?: number }) {
  const leaves = useMemo(() => Array.from({ length: 7 }, (_, i) => [Math.cos(i * 2.4) * 0.18, 0.55 + (i % 3) * 0.16, Math.sin(i * 2.4) * 0.18] as const), []);
  return (
    <group position={at(p)} scale={size}>
      <mesh position={[0, 0.2, 0]} castShadow>
        <cylinderGeometry args={[0.22, 0.17, 0.4, 20]} />
        <Mat color={C.pot} />
      </mesh>
      {leaves.map((l, i) => (
        <mesh key={i} position={l as unknown as [number, number, number]} castShadow>
          <sphereGeometry args={[0.2 - (i % 3) * 0.03, 16, 12]} />
          <Mat color={i % 2 ? C.green : C.greenDark} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * A classic blue indoor table: regulation size, white edge and centre lines,
 * a net on black posts, and the folding undercarriage on wheels. Built here
 * rather than generated, so it is exactly the size the game is timed to.
 */
export function PingPong({ layout, ball }: { layout: Layout; ball: () => [number, number, number] | null }) {
  const b = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const p = ball();
    if (!b.current) return;
    b.current.visible = Boolean(p);
    if (p) b.current.position.set(...p);
  });
  const [x, z] = layout.pingpong.table;
  const L = TABLE.length;
  const W = TABLE.width;
  const H = TABLE.height;
  const top = H - 0.025;
  const white = '#f4f6f8';
  const frame = '#20242c';
  return (
    <group>
      <group position={[x, 0, z]}>
        {/* The two halves of the top, a hair apart at the net. */}
        {[-1, 1].map((side) => (
          <mesh key={side} position={[(side * L) / 4, top, 0]} castShadow receiveShadow>
            <boxGeometry args={[L / 2 - 0.004, 0.025, W]} />
            <meshStandardMaterial color="#1f4e9c" roughness={0.55} />
          </mesh>
        ))}
        {/* Lines: 2 cm round the edge, 3 mm down the middle. */}
        {[-1, 1].map((sz) => (
          <mesh key={`s${sz}`} position={[0, H + 0.0006, sz * (W / 2 - 0.01)]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[L, 0.02]} />
            <meshBasicMaterial color={white} />
          </mesh>
        ))}
        {[-1, 1].map((sx) => (
          <mesh key={`e${sx}`} position={[sx * (L / 2 - 0.01), H + 0.0006, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.02, W]} />
            <meshBasicMaterial color={white} />
          </mesh>
        ))}
        <mesh position={[0, H + 0.0006, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[L, 0.003]} />
          <meshBasicMaterial color={white} />
        </mesh>
        {/* The apron under the edge. */}
        {[-1, 1].map((sz) => (
          <mesh key={`a${sz}`} position={[0, top - 0.05, sz * (W / 2 - 0.03)]}>
            <boxGeometry args={[L - 0.06, 0.07, 0.025]} />
            <meshStandardMaterial color={frame} roughness={0.6} />
          </mesh>
        ))}
        {/* The net: 15.25 cm high, 15.25 cm out past each side, on clamps. */}
        <mesh position={[0, H + TABLE.net / 2, 0]}>
          <boxGeometry args={[0.004, TABLE.net, W + 0.305]} />
          <meshStandardMaterial color="#14161c" transparent opacity={0.55} roughness={0.9} />
        </mesh>
        <mesh position={[0, H + TABLE.net - 0.008, 0]}>
          <boxGeometry args={[0.006, 0.016, W + 0.305]} />
          <meshStandardMaterial color={white} roughness={0.7} />
        </mesh>
        {[-1, 1].map((sz) => (
          <mesh key={`p${sz}`} position={[0, H + TABLE.net / 2 - 0.01, sz * (W / 2 + 0.152)]}>
            <boxGeometry args={[0.03, TABLE.net + 0.02, 0.025]} />
            <meshStandardMaterial color="#111" roughness={0.5} />
          </mesh>
        ))}
        {/* Undercarriage: each half on a pair of legs with wheels, braced to the middle. */}
        {[-1, 1].map((sx) =>
          [-1, 1].map((sz) => (
            <group key={`l${sx}${sz}`} position={[sx * (L / 2 - 0.42), 0, sz * (W / 2 - 0.16)]}>
              <mesh position={[0, (top - 0.06) / 2 + 0.05, 0]} castShadow>
                <boxGeometry args={[0.045, top - 0.06 - 0.05, 0.045]} />
                <meshStandardMaterial color={frame} roughness={0.5} metalness={0.3} />
              </mesh>
              <mesh position={[0, 0.04, 0]} rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry args={[0.04, 0.04, 0.03, 14]} />
                <meshStandardMaterial color="#2b2b2b" roughness={0.7} />
              </mesh>
            </group>
          )),
        )}
        {[-1, 1].map((sx) => (
          <group key={`b${sx}`}>
            <mesh position={[sx * (L / 2 - 0.42), 0.18, 0]}>
              <boxGeometry args={[0.035, 0.035, W - 0.32]} />
              <meshStandardMaterial color={frame} roughness={0.5} metalness={0.3} />
            </mesh>
            <mesh position={[(sx * (L / 2 - 0.42)) / 2, 0.42, 0]} rotation={[0, 0, sx * -0.62]}>
              <boxGeometry args={[0.03, 0.62, 0.03]} />
              <meshStandardMaterial color={frame} roughness={0.5} metalness={0.3} />
            </mesh>
          </group>
        ))}
      </group>
      <mesh ref={b} castShadow>
        <sphereGeometry args={[0.02, 12, 10]} />
        <meshStandardMaterial color="#ffffff" roughness={0.35} />
      </mesh>
    </group>
  );
}

/**
 * The fridge door, shown only when it is open: someone in front of it, a
 * light inside. Hinged at the fridge's front edge, swinging out.
 */
export function FridgeDoor({ at, face, open }: { at: P; face: number; open: () => boolean }) {
  const door = useRef<THREE.Group>(null);
  const glow = useRef<THREE.Mesh>(null);
  const angle = useRef(0);
  useFrame((_, dt) => {
    const want = open() ? 1.75 : 0;
    angle.current += (want - angle.current) * Math.min(1, dt * 3.5);
    const shown = angle.current > 0.04;
    if (door.current) {
      door.current.visible = shown;
      door.current.rotation.y = angle.current;
    }
    if (glow.current) glow.current.visible = shown;
  });
  // In the fridge's own frame: its front is +z, 0.68 deep, 0.7 wide.
  return (
    <group position={[at[0], 0, at[1]]} rotation={[0, face, 0]}>
      <mesh ref={glow} position={[0, 1.05, 0.345]} visible={false}>
        <planeGeometry args={[0.6, 1.3]} />
        <meshStandardMaterial color="#fffbea" emissive="#fff6d6" emissiveIntensity={0.9} />
      </mesh>
      <group ref={door} position={[0.35, 0, 0.35]} visible={false}>
        <mesh position={[-0.33, 1.02, 0.03]} castShadow>
          <boxGeometry args={[0.66, 1.45, 0.06]} />
          <meshStandardMaterial color="#a9dcc6" roughness={0.45} />
        </mesh>
        {[1.25, 0.95, 0.65].map((y) => (
          <mesh key={y} position={[-0.33, y, -0.03]}>
            <boxGeometry args={[0.54, 0.02, 0.08]} />
            <meshStandardMaterial color="#eef2f4" />
          </mesh>
        ))}
      </group>
    </group>
  );
}

export function Kitchen({ layout }: { layout: Layout }) {
  const m = layout.coffee.machine.at;
  return (
    <group>
      <RoundedBox args={[2.6, 0.9, 0.7]} radius={0.05} position={[m[0] - 0.7, 0.45, m[1] - 0.55]} castShadow receiveShadow>
        <Mat color={C.wood} />
      </RoundedBox>
      <RoundedBox args={[0.5, 0.55, 0.42]} radius={0.06} position={[m[0], 1.18, m[1] - 0.6]} castShadow>
        <Mat color={C.coffee} />
      </RoundedBox>
      <mesh position={[m[0], 1.25, m[1] - 0.38]}>
        <circleGeometry args={[0.06, 16]} />
        <meshStandardMaterial color="#ff6b6b" emissive="#ff6b6b" emissiveIntensity={0.8} />
      </mesh>
      {C.mugs.map((c, i) => (
        <mesh key={c} position={[m[0] - 0.7 - i * 0.18, 0.95, m[1] - 0.6]} castShadow>
          <cylinderGeometry args={[0.045, 0.04, 0.1, 14]} />
          <Mat color={c} />
        </mesh>
      ))}
      <Plant at={[m[0] - 1.8, m[1] - 0.6]} size={0.6} />
    </group>
  );
}

export function Sofa({ layout }: { layout: Layout }) {
  const [x, z] = layout.sofa.at;
  return (
    <group position={[x, 0, z]} rotation={[0, layout.sofa.face, 0]}>
      <RoundedBox args={[2.4, 0.42, 0.9]} radius={0.15} position={[0, 0.3, 0]} castShadow receiveShadow>
        <Mat color={C.sofa} />
      </RoundedBox>
      <RoundedBox args={[2.4, 0.6, 0.3]} radius={0.14} position={[0, 0.7, -0.33]} castShadow>
        <Mat color={C.sofa} />
      </RoundedBox>
      {[-1, 1].map((s) => (
        <RoundedBox key={s} args={[0.28, 0.55, 0.9]} radius={0.13} position={[s * 1.18, 0.5, 0]} castShadow>
          <Mat color={C.sofa} />
        </RoundedBox>
      ))}
      <RoundedBox args={[1.1, 0.3, 0.6]} radius={0.06} position={[0, 0.15, 1.6]} castShadow receiveShadow>
        <Mat color={C.wood} />
      </RoundedBox>
    </group>
  );
}

export function Whiteboard({ layout }: { layout: Layout }) {
  const [x, z] = layout.whiteboard.at;
  return (
    <group position={[x, 0, z + 0.05]}>
      <RoundedBox args={[2.2, 1.2, 0.06]} radius={0.03} position={[0, 1.55, 0]} castShadow>
        <Mat color={C.whiteboard} rough={0.4} />
      </RoundedBox>
      {/* Boxes and arrows: the architect's latest plan. */}
      {[
        [-0.6, 1.75, '#61afef'],
        [0.1, 1.45, '#e06c75'],
        [0.65, 1.75, '#98c379'],
      ].map(([px, py, c]) => (
        <mesh key={String(c)} position={[px as number, py as number, 0.035]}>
          <planeGeometry args={[0.36, 0.22]} />
          <meshBasicMaterial color={c as string} transparent opacity={0.6} />
        </mesh>
      ))}
    </group>
  );
}

export function TestBench({ layout }: { layout: Layout }) {
  const [x, z] = layout.testBench.at;
  return (
    <group position={[x, 0, z]}>
      <RoundedBox args={[1.8, 0.06, 0.6]} radius={0.02} position={[0, 0.95, 0]} castShadow receiveShadow>
        <Mat color={C.desk} />
      </RoundedBox>
      {[-0.8, 0.8].map((sx) => (
        <mesh key={sx} position={[sx, 0.47, 0]}>
          <boxGeometry args={[0.06, 0.94, 0.5]} />
          <Mat color={C.deskLeg} />
        </mesh>
      ))}
      {[-0.55, -0.25, 0.05, 0.35, 0.62].map((px, i) => (
        <RoundedBox key={px} args={[i === 4 ? 0.3 : 0.14, i === 4 ? 0.22 : 0.26, 0.02]} radius={0.015} position={[px, 1.12, 0.05]} rotation={[-0.25, 0, 0]} castShadow>
          <meshStandardMaterial color="#1b1f27" emissive="#9be7c4" emissiveIntensity={0.25} roughness={0.5} />
        </RoundedBox>
      ))}
    </group>
  );
}
