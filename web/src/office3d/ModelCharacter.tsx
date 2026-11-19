import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { ANIMATIONS_URL, modelUrl } from './characters.ts';
import type { Agent, Pose, Prop } from './director.ts';
import { STROKE } from './pingpong.ts';

/**
 * A character from Meshy: its rigged model, animated with the shared clips in
 * animations.glb (same mixamo skeleton for everyone, so one set of clips
 * fits all). Each pose plays a clip; changing pose cross-fades. Props sit in
 * the right hand. At the ping pong table the stroke is not left to run: it is
 * set from the game's clock every frame, so the paddle meets the ball.
 */

/** The clip for each pose, with fallbacks for clips that are not made yet. */
const CLIPS: Record<Pose, string[]> = {
  'sit-type': ['sit_type', 'sit_idle'],
  'sit-idle': ['sit_idle', 'sit_idle_f'],
  'sit-rock': ['sit_rock', 'sit_idle'],
  'sit-lean': ['sit_lean', 'sit_idle'],
  'sit-feetup': ['sit_feetup', 'sit_lean'],
  'sit-sleep': ['sit_sleep', 'sit_doze'],
  'sit-despair': ['sit_despair', 'sit_sleep'],
  'sit-raise': ['sit_raise', 'sit_cheer', 'sit_idle'],
  'sit-phone': ['sit_idle_f', 'sit_idle'],
  'sit-drink': ['sit_drink', 'sit_idle'],
  stand: ['stand_idle', 'chat', 'talk'],
  'stand-wave': ['wave', 'wave_one'],
  'stand-talk': ['talk', 'chat'],
  'stand-drink': ['stand_drink', 'chat'],
  'stand-look': ['stand_idle', 'chat'],
  walk: ['walk'],
  'walk-phone': ['walk_phone', 'walk'],
  // Between points: ready, waiting for the serve (the stroke itself runs on the game's clock).
  pingpong: ['stand_idle', 'chat'],
  water: ['water', 'stand_drink'],
  stretch: ['stretch', 'dance'],
  dance: ['dance'],
  'sofa-phone': ['sit_idle_f', 'sit_idle'],
  'sofa-nap': ['sit_doze', 'sit_sleep'],
  whiteboard: ['whiteboard', 'talk'],
  test: ['test_phones', 'chat'],
};

function PropMesh({ prop }: { prop: Prop }) {
  switch (prop) {
    case 'mug':
      return (
        <mesh position={[0, 0.06, 0.04]}>
          <cylinderGeometry args={[0.045, 0.04, 0.1, 14]} />
          <meshStandardMaterial color="#f2c14e" roughness={0.7} />
        </mesh>
      );
    case 'phone':
      return (
        <mesh position={[0, 0.08, 0.03]}>
          <boxGeometry args={[0.07, 0.14, 0.012]} />
          <meshStandardMaterial color="#20232a" emissive="#7fd3ff" emissiveIntensity={0.3} />
        </mesh>
      );
    case 'can':
      return (
        <mesh position={[0, 0.06, 0.05]}>
          <cylinderGeometry args={[0.07, 0.08, 0.16, 14]} />
          <meshStandardMaterial color="#5bb7a5" roughness={0.6} />
        </mesh>
      );
    case 'paddle':
      // Shakehand grip: the handle in the palm along the fingers, the blade past
      // them, its faces to the front and back of the hand (measured: the blade
      // faces the ball at contact). Red rubber one side, black the other.
      return (
        <group>
          <mesh position={[0, 0.075, 0]}>
            <boxGeometry args={[0.028, 0.1, 0.022]} />
            <meshStandardMaterial color="#c99a62" roughness={0.6} />
          </mesh>
          <group position={[0, 0.2, 0]}>
            <mesh rotation={[Math.PI / 2, 0, 0]} scale={[1, 1, 1.08]}>
              <cylinderGeometry args={[0.075, 0.075, 0.007, 24]} />
              <meshStandardMaterial color="#c99a62" roughness={0.6} />
            </mesh>
            <mesh position={[0, 0, 0.0045]} rotation={[Math.PI / 2, 0, 0]} scale={[1, 1, 1.08]}>
              <cylinderGeometry args={[0.074, 0.074, 0.002, 24]} />
              <meshStandardMaterial color="#c62828" roughness={0.8} />
            </mesh>
            <mesh position={[0, 0, -0.0045]} rotation={[Math.PI / 2, 0, 0]} scale={[1, 1, 1.08]}>
              <cylinderGeometry args={[0.074, 0.074, 0.002, 24]} />
              <meshStandardMaterial color="#1b1b1b" roughness={0.8} />
            </mesh>
          </group>
        </group>
      );
    case 'soda':
      return (
        <group position={[0.02, 0.07, 0.04]}>
          <mesh>
            <cylinderGeometry args={[0.033, 0.033, 0.12, 16]} />
            <meshStandardMaterial color="#d6453d" metalness={0.5} roughness={0.35} />
          </mesh>
          <mesh position={[0, 0.062, 0]}>
            <cylinderGeometry args={[0.029, 0.033, 0.006, 16]} />
            <meshStandardMaterial color="#c9ccd1" metalness={0.8} roughness={0.3} />
          </mesh>
        </group>
      );
    default:
      return null;
  }
}

export function ModelCharacter({ character, agent, onClick, onHover }: { character: string; agent: () => Agent; onClick: () => void; onHover: (on: boolean) => void }) {
  const model = useGLTF(modelUrl(character));
  const anims = useGLTF(ANIMATIONS_URL);
  // Each person gets their own copy of the model and its skeleton.
  const scene = useMemo(() => {
    const s = cloneSkinned(model.scene);
    s.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return s;
  }, [model.scene]);
  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene]);
  const clips = useMemo(() => new Map(anims.animations.map((c) => [c.name, c])), [anims.animations]);
  const root = useRef<THREE.Group>(null);
  const hand = useRef<THREE.Object3D | null>(null);
  const propRoot = useMemo(() => new THREE.Group(), []);
  const current = useRef<{ pose: Pose | 'stroke' | 'run' | null; action: THREE.AnimationAction | null; seam: THREE.AnimationAction | null; since: number }>({ pose: null, action: null, seam: null, since: 0 });
  // The stroke twice: the loop's end blends into its start, so it never jumps.
  const stroke = useMemo(() => {
    const c = clips.get('pingpong');
    return c ? { main: mixer.clipAction(c), seam: mixer.clipAction(c.clone()) } : null;
  }, [clips, mixer]);
  const propShown = useRef<Prop>(null);
  const propKids = useRef<Record<string, THREE.Object3D | null>>({});

  useEffect(() => {
    // The right hand, whatever the template calls it (mixamorig:RightHand, mixamorigRightHand …).
    scene.traverse((o) => {
      if (!hand.current && /right_?hand$/i.test(o.name.replace(/^mixamorig:?/i, ''))) hand.current = o;
    });
    hand.current?.add(propRoot);
    return () => {
      hand.current?.remove(propRoot);
      mixer.stopAllAction();
    };
  }, [scene, mixer, propRoot]);

  useFrame((_, dt) => {
    const a = agent();
    const g = root.current;
    if (!g) return;
    g.position.set(a.pos[0], 0, a.pos[1]);
    g.rotation.y = a.face;
    const cur = current.current;
    // At the table with the game running: the stroke, on the game's clock.
    // Running round the table: the run, if it is made.
    const playing = a.pose === 'pingpong' && a.beat != null && stroke ? 'stroke' : a.hurry && a.pose === 'walk' && clips.has('run') ? 'run' : a.pose;
    if (playing !== cur.pose) {
      cur.action?.fadeOut(0.35);
      cur.seam?.fadeOut(0.35);
      cur.seam = null;
      if (playing === 'stroke' && stroke) {
        for (const x of [stroke.main, stroke.seam]) {
          x.reset().play();
          x.timeScale = 0;
        }
        cur.action = stroke.main;
        cur.seam = stroke.seam;
        cur.since = 0;
      } else {
        const name = playing === 'run' ? 'run' : CLIPS[a.pose].find((n) => clips.has(n));
        const clip = name ? clips.get(name) : undefined;
        if (clip) {
          const next = mixer.clipAction(clip);
          // Everyone starts their loop at their own point, so two never move in step.
          next.reset().setEffectiveWeight(1).fadeIn(0.35).play();
          next.time = (a.seed / 1000) * clip.duration;
          cur.action = next;
        }
      }
      cur.pose = playing;
    }
    if (playing === 'stroke' && stroke && a.beat != null) {
      cur.since += dt;
      const t = a.beat * STROKE.length;
      const edge = 0.25;
      // The last bit of the loop fades into the pose just before its start.
      const w = t > STROKE.length - edge ? (t - (STROKE.length - edge)) / edge : 0;
      const ramp = Math.min(1, cur.since / 0.35);
      stroke.main.time = STROKE.start + t;
      stroke.seam.time = STROKE.start + t - STROKE.length;
      stroke.main.setEffectiveWeight(ramp * (1 - w));
      stroke.seam.setEffectiveWeight(ramp * w);
    }
    mixer.update(dt);
    if (a.prop !== propShown.current) {
      propShown.current = a.prop;
      for (const [k, o] of Object.entries(propKids.current)) if (o) o.visible = k === a.prop;
    }
  });

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
      <primitive object={scene} />
      <primitive object={propRoot}>
        {(['mug', 'phone', 'can', 'paddle', 'soda'] as const).map((p) => (
          <group
            key={p}
            visible={false}
            ref={(o) => {
              propKids.current[p] = o;
            }}
          >
            <PropMesh prop={p} />
          </group>
        ))}
      </primitive>
    </group>
  );
}
