import { useTexture } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { Component, Suspense, useMemo, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import type { Agent, Pose, Prop } from './director.ts';
import type { Style } from './characters.ts';

/**
 * A clay figure with joints, drawn in code: the stand-in for a character
 * until its 3D model from Meshy is in place, and the fallback after. Every
 * pose is a set of joint angles; the body eases towards them, and small
 * loops (typing, waving, sipping, a swing of the paddle) play on top.
 */

interface Joints {
  hipY: number;
  torso: number;
  torsoRoll: number;
  torsoYaw: number;
  head: number;
  headYaw: number;
  headRoll: number;
  shL: number;
  shR: number;
  shLz: number;
  shRz: number;
  elL: number;
  elR: number;
  hipL: number;
  hipR: number;
  knL: number;
  knR: number;
}

const STAND: Joints = { hipY: 0.66, torso: 0, torsoRoll: 0, torsoYaw: 0, head: 0, headYaw: 0, headRoll: 0, shL: 0, shR: 0, shLz: 0.12, shRz: -0.12, elL: -0.15, elR: -0.15, hipL: 0, hipR: 0, knL: 0, knR: 0 };
const SIT: Joints = { ...STAND, hipY: 0.56, hipL: -1.5, hipR: -1.5, knL: 1.45, knR: 1.45, shL: -0.5, shR: -0.5, elL: -0.9, elR: -0.9 };

const wave = (t: number, f: number, phase = 0) => Math.sin(t * f + phase);

/** The joint angles of a pose at time t; `s` is the agent's own phase so no two move in step. */
function pose(p: Pose, t: number, s: number): Joints {
  const breathe = wave(t, 1.6, s) * 0.02;
  const look = wave(t, 0.23, s * 3) * 0.5 + wave(t, 0.61, s) * 0.15;
  switch (p) {
    case 'sit-type': {
      const glance = wave(t, 0.17, s) > 0.92 ? -0.5 : 0;
      return { ...SIT, torso: 0.12 + breathe, head: 0.18, headYaw: glance, shL: -1.05, shR: -1.05, elL: -0.75 + wave(t, 17, s) * 0.07, elR: -0.75 + wave(t, 15, s + 1) * 0.07, shLz: 0.2, shRz: -0.2 };
    }
    case 'sit-idle':
      return { ...SIT, torso: breathe, headYaw: look, head: 0.05 };
    case 'sit-rock':
      return { ...SIT, torso: -0.18 + wave(t, 1.4, s) * 0.12, headYaw: look * 0.6, head: -0.1, shL: -0.2, shR: -0.2, elL: -0.4, elR: -0.4 };
    case 'sit-lean':
      return { ...SIT, torso: -0.32, head: -0.15, headYaw: look * 0.4, shL: -2.7, shR: -2.7, shLz: 0.6, shRz: -0.6, elL: -2.1, elR: -2.1 };
    case 'sit-feetup': {
      // A toss every few seconds; the arm winds up and throws.
      const toss = Math.max(0, wave(t, 1.1, s) - 0.6) * 2.5;
      return { ...SIT, hipY: 0.6, torso: -0.42, head: -0.1, hipL: -1.75, hipR: -1.65, knL: 0.15, knR: 0.25, shL: -0.6, elL: -1.2, shR: -1.4 - toss * 1.1, elR: -0.9 + toss * 0.6, shRz: -0.3 };
    }
    case 'sit-sleep':
      return { ...SIT, torso: 0.85 + breathe * 2, head: 0.35, headRoll: 0.3, shL: -1.4, shR: -1.4, elL: -1.7, elR: -1.7, shLz: 0.5, shRz: -0.5 };
    case 'sit-despair':
      return { ...SIT, torso: 0.45, head: 0.65 + wave(t, 0.9, s) * 0.05, shL: -1.85, shR: -1.85, elL: -2.3, elR: -2.3, shLz: 0.35, shRz: -0.35 };
    case 'sit-raise':
      return { ...SIT, torso: -0.05, head: -0.15, headYaw: 0.35, shR: -2.9, shRz: -0.35 + wave(t, 6, s) * 0.25, elR: -0.3, shL: -0.6, elL: -0.9 };
    case 'sit-phone':
      return { ...SIT, torso: -0.12, head: 0.1, headRoll: 0.2, shR: -1.3, shRz: -0.5, elR: -2.5, headYaw: look * 0.5 };
    case 'sit-drink': {
      const sip = Math.max(0, wave(t, 0.5, s) - 0.4) * 1.6;
      return { ...SIT, torso: -0.1, head: -sip * 0.3, shR: -0.6 - sip * 0.9, elR: -1.3 - sip * 0.9, headYaw: look * 0.4 };
    }
    case 'stand':
      return { ...STAND, torso: breathe, headYaw: look * 0.6, shL: wave(t, 0.8, s) * 0.04, shR: -wave(t, 0.8, s) * 0.04 };
    case 'stand-wave':
      return { ...STAND, head: -0.12, headYaw: 0.25, shR: -2.9, shRz: -0.4 + wave(t, 7, s) * 0.35, elR: -0.25, shL: 0.05 };
    case 'stand-talk': {
      const g = wave(t, 2.3, s);
      return { ...STAND, head: wave(t, 3.1, s) * 0.06, headYaw: wave(t, 0.4, s) * 0.2, shL: -0.6 + g * 0.25, elL: -1.2 + g * 0.3, shR: -0.5 - g * 0.25, elR: -1.1 - g * 0.3, torsoYaw: g * 0.06 };
    }
    case 'stand-drink': {
      const sip = Math.max(0, wave(t, 0.6, s) - 0.35) * 1.5;
      return { ...STAND, head: -sip * 0.3, shR: -0.5 - sip * 0.9, elR: -1.5 - sip * 0.8, headYaw: look * 0.5 };
    }
    case 'stand-look':
      return { ...STAND, head: -0.12, headYaw: look * 0.4, shL: 0.35, shR: 0.35, elL: -0.6, elR: -0.6, shLz: 0.25, shRz: -0.25 };
    case 'walk':
    case 'walk-phone': {
      const stride = wave(t, 8.5, s);
      const phone = p === 'walk-phone';
      return {
        ...STAND,
        hipY: 0.66 + Math.abs(stride) * 0.025,
        torso: 0.05,
        torsoYaw: stride * 0.06,
        hipL: stride * 0.5,
        hipR: -stride * 0.5,
        knL: Math.max(0, -stride) * 0.7,
        knR: Math.max(0, stride) * 0.7,
        shL: -stride * 0.45,
        shR: phone ? -1.3 : stride * 0.45,
        shRz: phone ? -0.5 : -0.12,
        elL: -0.3,
        elR: phone ? -2.5 : -0.3,
        headRoll: phone ? 0.15 : 0,
      };
    }
    case 'pingpong': {
      const swing = wave(t, 4.5, s);
      return { ...STAND, hipY: 0.6, hipL: -0.35, hipR: -0.35, knL: 0.6, knR: 0.6, torso: 0.2, torsoYaw: swing * 0.35, shR: -1.0 + swing * 0.5, shRz: -0.7, elR: -0.5, shL: -0.4, elL: -1.0, head: 0.1 };
    }
    case 'water':
      return { ...STAND, torso: 0.25, head: 0.35, shR: -1.2, elR: -0.3, shRz: -0.15 + wave(t, 1.3, s) * 0.08, shL: -0.2 };
    case 'stretch': {
      const side = wave(t, 0.9, s);
      return { ...STAND, torsoRoll: side * 0.2, shL: -3.0, shR: -3.0, shLz: 0.2, shRz: -0.2, elL: -0.2, elR: -0.2, head: -0.2 };
    }
    case 'dance': {
      const b = wave(t, 7, s);
      return { ...STAND, hipY: 0.63 + Math.abs(b) * 0.04, torsoYaw: wave(t, 3.5, s) * 0.4, torsoRoll: b * 0.1, shL: -2.6 + b * 0.5, shR: -2.6 - b * 0.5, shLz: 0.6, shRz: -0.6, elL: -0.6, elR: -0.6, hipL: b * 0.2, hipR: -b * 0.2, knL: Math.max(0, b) * 0.4, knR: Math.max(0, -b) * 0.4, head: b * 0.1 };
    }
    case 'sofa-phone':
      return { ...SIT, hipY: 0.48, torso: -0.25, head: 0.35, shL: -0.9, shR: -0.9, elL: -1.5, elR: -1.5, shLz: 0.3, shRz: -0.3 };
    case 'sofa-nap':
      return { ...SIT, hipY: 0.46, torso: -0.5 + breathe * 2, head: -0.2, headRoll: 0.45, shL: -0.1, shR: -0.1, elL: -0.5, elR: -0.5, hipL: -1.3, hipR: -1.35 };
    case 'whiteboard': {
      const draw = wave(t, 2.2, s);
      return { ...STAND, head: -0.15, headYaw: wave(t, 0.5, s) * 0.2, shR: -2.1 + draw * 0.25, shRz: -0.3 + wave(t, 3.1, s) * 0.2, elR: -0.4, shL: 0.1 };
    }
    case 'test':
      return { ...STAND, torso: 0.25, head: 0.45, shL: -1.0, shR: -1.0, elL: -0.8, elR: -0.8 + wave(t, 6, s) * 0.12, headYaw: wave(t, 0.4, s) * 0.3 };
  }
}

function Prop({ prop }: { prop: Prop }) {
  switch (prop) {
    case 'mug':
      return (
        <mesh position={[0, -0.05, 0.05]} castShadow>
          <cylinderGeometry args={[0.045, 0.04, 0.1, 14]} />
          <meshStandardMaterial color="#f2c14e" roughness={0.7} />
        </mesh>
      );
    case 'phone':
      return (
        <mesh position={[0, -0.03, 0.04]} rotation={[0.2, 0, 0]} castShadow>
          <boxGeometry args={[0.07, 0.14, 0.012]} />
          <meshStandardMaterial color="#20232a" emissive="#7fd3ff" emissiveIntensity={0.3} />
        </mesh>
      );
    case 'can':
      return (
        <group position={[0, -0.08, 0.08]} rotation={[0.6, 0, 0]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.07, 0.08, 0.16, 14]} />
            <meshStandardMaterial color="#5bb7a5" roughness={0.6} />
          </mesh>
          <mesh position={[0, 0.03, 0.12]} rotation={[1.2, 0, 0]}>
            <cylinderGeometry args={[0.012, 0.015, 0.2, 8]} />
            <meshStandardMaterial color="#5bb7a5" />
          </mesh>
        </group>
      );
    case 'paddle':
      return (
        <group position={[0, -0.06, 0.06]}>
          <mesh rotation={[Math.PI / 2, 0, 0]} castShadow>
            <cylinderGeometry args={[0.08, 0.08, 0.015, 18]} />
            <meshStandardMaterial color="#c0392b" />
          </mesh>
          <mesh position={[0, -0.1, 0]}>
            <boxGeometry args={[0.03, 0.1, 0.02]} />
            <meshStandardMaterial color="#b98e66" />
          </mesh>
        </group>
      );
    default:
      return null;
  }
}

const Mat = ({ color }: { color: string }) => <meshStandardMaterial color={color} roughness={0.85} />;

function Hair({ style }: { style: Style }) {
  const c = style.hair;
  switch (style.hairdo) {
    case 'bald':
      return (
        <mesh position={[0, -0.04, -0.03]} scale={[1.02, 0.55, 1.02]}>
          <sphereGeometry args={[0.2, 20, 16, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.4]} />
          <Mat color={c} />
        </mesh>
      );
    case 'afro':
    case 'curly':
      return (
        <mesh position={[0, 0.07, -0.03]} scale={style.hairdo === 'afro' ? 1.25 : 1.1}>
          <sphereGeometry args={[0.19, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.55]} />
          <Mat color={c} />
        </mesh>
      );
    case 'long':
      return (
        <group>
          <mesh position={[0, 0.04, -0.02]} scale={1.08}>
            <sphereGeometry args={[0.19, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.55]} />
            <Mat color={c} />
          </mesh>
          <mesh position={[0, -0.2, -0.13]}>
            <capsuleGeometry args={[0.06, 0.3, 6, 12]} />
            <Mat color={c} />
          </mesh>
        </group>
      );
    case 'bun':
      return (
        <group>
          <mesh position={[0, 0.04, -0.02]} scale={1.06}>
            <sphereGeometry args={[0.19, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.5]} />
            <Mat color={c} />
          </mesh>
          <mesh position={[0, 0.2, -0.06]}>
            <sphereGeometry args={[0.08, 16, 12]} />
            <Mat color={c} />
          </mesh>
        </group>
      );
    case 'cap':
      return (
        <group>
          <mesh position={[0, 0.06, -0.01]} scale={1.08}>
            <sphereGeometry args={[0.19, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.5]} />
            <Mat color="#151515" />
          </mesh>
          <mesh position={[0, 0.07, -0.2]} rotation={[0.2, 0, 0]}>
            <boxGeometry args={[0.2, 0.02, 0.16]} />
            <Mat color="#151515" />
          </mesh>
        </group>
      );
    case 'beret':
      return (
        <group>
          <mesh position={[0, 0.02, 0]} scale={1.07}>
            <sphereGeometry args={[0.19, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.6]} />
            <Mat color={c} />
          </mesh>
          <mesh position={[0.03, 0.17, 0]} rotation={[0, 0, 0.2]} scale={[1, 0.35, 1]}>
            <sphereGeometry args={[0.17, 20, 12]} />
            <Mat color="#1d1d20" />
          </mesh>
        </group>
      );
    default:
      return (
        <mesh position={[0, 0.04, -0.02]} scale={1.06}>
          <sphereGeometry args={[0.19, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.5]} />
          <Mat color={c} />
        </mesh>
      );
  }
}

/** A role without a portrait yet (just added, still drawing) gets a blank face, not a broken office. */
class FaceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The portrait's face on the front of the head. */
function Face({ url }: { url: string }) {
  const tex = useTexture(url);
  const face = useMemo(() => {
    const t = tex.clone();
    t.colorSpace = THREE.SRGBColorSpace;
    // The face in the portraits sits a little above the middle.
    t.repeat.set(0.46, 0.46);
    t.offset.set(0.27, 0.38);
    t.needsUpdate = true;
    return t;
  }, [tex]);
  return (
    <mesh position={[0, -0.01, 0.168]}>
      <circleGeometry args={[0.135, 32]} />
      <meshStandardMaterial map={face} roughness={0.8} />
    </mesh>
  );
}

export function Character({ agent, style, portrait, onClick, onHover }: { agent: () => Agent; style: Style; portrait: string; onClick: () => void; onHover: (on: boolean) => void }) {
  const root = useRef<THREE.Group>(null);
  const j = useRef<Record<string, THREE.Group | null>>({});
  const current = useRef<Joints>({ ...SIT });
  const prop = useRef<Prop>(null);
  const propGroup = useRef<THREE.Group>(null);
  const headset = useRef<THREE.Group>(null);
  const seat = useRef(0);

  useFrame((state, dt) => {
    const a = agent();
    const g = root.current;
    if (!g) return;
    g.position.set(a.pos[0], 0, a.pos[1]);
    g.rotation.y = a.face;
    const target = pose(a.pose, state.clock.elapsedTime, a.seed / 100);
    const c = current.current;
    const k = Math.min(1, dt * 6);
    for (const key of Object.keys(c) as (keyof Joints)[]) c[key] += (target[key] - c[key]) * k;
    const set = (name: string, x = 0, y = 0, z = 0) => {
      const o = j.current[name];
      if (o) o.rotation.set(x, y, z);
    };
    const hips = j.current.hips;
    if (hips) hips.position.y = c.hipY * style.height;
    set('torso', c.torso, c.torsoYaw, c.torsoRoll);
    set('head', c.head, c.headYaw, c.headRoll);
    set('shL', c.shL, 0, c.shLz);
    set('shR', c.shR, 0, c.shRz);
    set('elL', c.elL);
    set('elR', c.elR);
    set('hipL', c.hipL);
    set('hipR', c.hipR);
    set('knL', c.knL);
    set('knR', c.knR);
    if (prop.current !== a.prop && propGroup.current) {
      prop.current = a.prop;
      propGroup.current.userData.prop = a.prop;
    }
    if (headset.current) headset.current.visible = a.prop === 'headset' || a.role.kind === 'lead';
    seat.current = c.hipY;
  });

  const w = style.width;
  const ref = (name: string) => (o: THREE.Group | null) => {
    j.current[name] = o;
  };
  return (
    <group
      ref={root}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        onHover(false);
        document.body.style.cursor = '';
      }}
    >
      <group ref={ref('hips')} scale={[1, style.height, 1]}>
        {/* Legs: thigh from the hip, shin from the knee, and a shoe. */}
        {(['L', 'R'] as const).map((side) => (
          <group key={side} ref={ref(`hip${side}`)} position={[(side === 'L' ? 0.09 : -0.09) * w, 0, 0]}>
            <mesh position={[0, -0.15, 0]} castShadow>
              <capsuleGeometry args={[0.065 * w, 0.18, 6, 12]} />
              <Mat color={style.bottom} />
            </mesh>
            <group ref={ref(`kn${side}`)} position={[0, -0.31, 0]}>
              <mesh position={[0, -0.14, 0]} castShadow>
                <capsuleGeometry args={[0.055, 0.17, 6, 12]} />
                <Mat color={style.bottom} />
              </mesh>
              <mesh position={[0, -0.29, 0.04]} castShadow>
                <boxGeometry args={[0.1, 0.06, 0.18]} />
                <Mat color={style.shoes} />
              </mesh>
            </group>
          </group>
        ))}
        <group ref={ref('torso')}>
          <mesh position={[0, 0.24, 0]} castShadow>
            <capsuleGeometry args={[0.16 * w, 0.24, 8, 16]} />
            <Mat color={style.top} />
          </mesh>
          {/* Arms: upper arm from the shoulder, forearm from the elbow, a hand holding the prop. */}
          {(['L', 'R'] as const).map((side) => (
            <group key={side} ref={ref(`sh${side}`)} position={[(side === 'L' ? 0.2 : -0.2) * w, 0.42, 0]}>
              <mesh position={[0, -0.11, 0]} castShadow>
                <capsuleGeometry args={[0.05, 0.13, 6, 10]} />
                <Mat color={style.top} />
              </mesh>
              <group ref={ref(`el${side}`)} position={[0, -0.23, 0]}>
                <mesh position={[0, -0.1, 0]} castShadow>
                  <capsuleGeometry args={[0.045, 0.12, 6, 10]} />
                  <Mat color={style.top} />
                </mesh>
                <mesh position={[0, -0.2, 0]} castShadow>
                  <sphereGeometry args={[0.05, 12, 10]} />
                  <Mat color={style.skin} />
                </mesh>
                {side === 'R' && (
                  <group ref={propGroup} position={[0, -0.22, 0]}>
                    <PropHolder agent={agent} />
                  </group>
                )}
              </group>
            </group>
          ))}
          <group ref={ref('head')} position={[0, 0.55, 0]}>
            <mesh position={[0, 0.16, 0]} castShadow>
              <sphereGeometry args={[0.19, 24, 20]} />
              <Mat color={style.skin} />
            </mesh>
            <group position={[0, 0.16, 0]}>
              <Hair style={style} />
              <FaceBoundary key={portrait}>
                <Suspense fallback={null}>
                  <Face url={portrait} />
                </Suspense>
              </FaceBoundary>
            </group>
            <group ref={headset} position={[0, 0.16, 0]} visible={false}>
              <mesh rotation={[0, 0, 0]}>
                <torusGeometry args={[0.2, 0.015, 8, 24, Math.PI]} />
                <meshStandardMaterial color="#222" />
              </mesh>
              <mesh position={[-0.19, -0.04, 0.08]} rotation={[0, 0.5, 0]}>
                <cylinderGeometry args={[0.008, 0.008, 0.16, 6]} />
                <meshStandardMaterial color="#222" />
              </mesh>
            </group>
          </group>
        </group>
      </group>
    </group>
  );
}

/** The prop in the right hand follows the agent's state without re-rendering the body. */
function PropHolder({ agent }: { agent: () => Agent }) {
  const g = useRef<THREE.Group>(null);
  const shown = useRef<Prop>(null);
  const kids = useRef<Record<string, THREE.Group | null>>({});
  useFrame(() => {
    const p = agent().prop;
    if (p === shown.current) return;
    shown.current = p;
    for (const [k, o] of Object.entries(kids.current)) if (o) o.visible = k === p;
  });
  return (
    <group ref={g}>
      {(['mug', 'phone', 'can', 'paddle'] as const).map((p) => (
        <group
          key={p}
          visible={false}
          ref={(o) => {
            kids.current[p] = o;
          }}
        >
          <Prop prop={p} />
        </group>
      ))}
    </group>
  );
}
