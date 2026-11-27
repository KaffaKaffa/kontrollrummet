import { Environment, Html, Lightformer, OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { EffectComposer, N8AO, SMAA, Vignette } from '@react-three/postprocessing';
import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { avatarUrl, type Approval, type Role, type Subtask, type Task } from '../api.ts';
import { Character } from './Character.tsx';
import { characterOf, jobOf, styleOf } from './characters.ts';
import { ModelCharacter } from './ModelCharacter.tsx';
import { Artwork, Asset, useOfficeIndex, workstationOf } from './assets.tsx';
import type { Agent, Director } from './director.ts';
import { PINGIS } from './life.ts';
import { buildLayout, coffeeTable, type Layout } from './layout.ts';
import { Bin, Chair, Desk, Floor, FridgeDoor, Kitchen, PingPong, Plant, Sofa, TestBench, Walls, Whiteboard } from './props.tsx';
import { themeOf, type Theme } from './themes.ts';

/**
 * Kontoret i 3D: the team at its desks, seen from above like a diorama. Who
 * does what comes from the cards, through the director; clicking someone
 * opens their card, or their settings when they have none.
 */

export interface Office3DProps {
  /** The team's office, kept going by life.ts whether or not it is shown. */
  director: Director;
  team: string;
  roles: Role[];
  subtasks: Subtask[];
  tasks: Task[];
  approvals: Approval[];
  onOpenCard: (id: number) => void;
  onOpenAgent: (roleId: string) => void;
  /** The project's look (themes.ts): the office, or the Christmas workshop. */
  theme?: string;
}

const DUTY_TEXT: Record<string, string> = {
  work: 'Arbetar',
  test: 'Testar',
  ask: 'Väntar på dig',
  approve: 'Vill ha ditt godkännande',
  watch: 'Bevakar sina kort',
  pr: 'PR öppen',
  queue: 'I kön',
  sleep: 'Kvotstopp',
  despair: 'Det gick inte',
  patrol: 'Följer upp teamet',
  whiteboard: 'Planerar',
  free: 'Ledig',
};

/** Hidden longer than this (the Mac slept, the window was away): the scene is built again on return. */
const STALE_HIDDEN_MS = 10 * 60 * 1000;

/**
 * The scene made again when the GPU lost it. After sleep, the Mac app's web view
 * can lose the WebGL context; three.js gets it back, but the lighting baked once
 * into the environment map does not come with it, and every desk and person
 * turns black while the floor still shows. A new Canvas bakes it again. A long
 * hidden spell counts too, since a lost context there is not always reported.
 */
function useFreshScene() {
  const [key, setKey] = useState(0);
  const hiddenAt = useRef<number | null>(null);
  useEffect(() => {
    const seen = () => {
      if (document.hidden) hiddenAt.current = Date.now();
      else if (hiddenAt.current && Date.now() - hiddenAt.current > STALE_HIDDEN_MS) setKey((k) => k + 1);
      if (!document.hidden) hiddenAt.current = null;
    };
    document.addEventListener('visibilitychange', seen);
    return () => document.removeEventListener('visibilitychange', seen);
  }, []);
  const onCreated = useCallback(({ gl }: { gl: THREE.WebGLRenderer }) => {
    const canvas = gl.domElement;
    // Without preventDefault the context is never given back.
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => setKey((k) => k + 1), { once: true });
  }, []);
  return { key, onCreated };
}

/** A day in the office: warm in the morning, bright at noon, golden in the evening, blue at night. */
function daylight(hour: number) {
  if (hour < 6 || hour >= 22) return { sun: 0.5, sky: '#8a96c4', amb: 0.55, color: '#c3cfff' };
  if (hour < 9) return { sun: 1.6, sky: '#ffe6cc', amb: 0.65, color: '#ffe2c2' };
  if (hour < 17) return { sun: 2.0, sky: '#dcecff', amb: 0.7, color: '#fff6ea' };
  return { sun: 1.6, sky: '#ffe0c4', amb: 0.65, color: '#ffd9b3' };
}

function Lights({ layout }: { layout: Layout }) {
  const hour = new Date().getHours();
  const d = daylight(hour);
  const cx = (layout.minX + layout.maxX) / 2;
  return (
    <>
      <hemisphereLight args={[d.sky, '#e8d8c3', d.amb]} />
      {/* The sun comes in through the windows at the back, from high up. */}
      <directionalLight
        position={[cx + 6, 12, layout.minZ - 6]}
        intensity={d.sun}
        color={d.color}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-camera-left={-16}
        shadow-camera-right={16}
        shadow-camera-top={12}
        shadow-camera-bottom={-12}
      />
      <directionalLight position={[cx - 8, 10, 10]} intensity={0.55} color="#ffffff" />
      <Environment resolution={128}>
        <Lightformer intensity={1.6} position={[0, 6, -10]} scale={[20, 6, 1]} color={d.color} />
        <Lightformer intensity={0.6} position={[10, 4, 10]} scale={[10, 10, 1]} color="#ffffff" />
        <Lightformer intensity={0.4} position={[-10, 4, 0]} rotation-y={Math.PI / 2} scale={[10, 6, 1]} color="#cfe0ff" />
      </Environment>
    </>
  );
}

/** Paper balls in flight and on the floor. */
function PaperBalls({ director }: { director: Director }) {
  const group = useRef<THREE.Group>(null);
  const meshes = useRef<THREE.Mesh[]>([]);
  useFrame(() => {
    const now = director.clock;
    director.balls.forEach((b, i) => {
      const m = meshes.current[i];
      if (!m) return;
      const t = Math.min(1, (now - b.start) / b.duration);
      // A hit drops into the bin and is gone; a miss stays on the floor a while.
      m.visible = !(b.hit && t >= 1) && now - b.start < 40;
      m.position.set(
        b.from[0] + (b.to[0] - b.from[0]) * t,
        b.from[1] + (b.to[1] - b.from[1]) * t + Math.sin(t * Math.PI) * 1.1,
        b.from[2] + (b.to[2] - b.from[2]) * t,
      );
      m.rotation.set(t * 9, t * 7, 0);
    });
    for (let i = director.balls.length; i < meshes.current.length; i++) if (meshes.current[i]) meshes.current[i].visible = false;
  });
  return (
    <group ref={group}>
      {Array.from({ length: 12 }, (_, i) => (
        <mesh
          key={i}
          visible={false}
          castShadow
          ref={(m) => {
            if (m) meshes.current[i] = m;
          }}
        >
          <icosahedronGeometry args={[0.05, 0]} />
          <meshStandardMaterial color="#f7f4ee" roughness={0.95} flatShading />
        </mesh>
      ))}
    </group>
  );
}

/** A bubble above a head: a question, an approval, sleep; the name and what they do on hover. */
function Label({ agent, hovered }: { agent: () => Agent; hovered: boolean }) {
  const g = useRef<THREE.Group>(null);
  const [state, setState] = useState<{ bubble: string | null; duty: string; brief: string | null; say: string | null }>({ bubble: null, duty: 'free', brief: null, say: null });
  useFrame(() => {
    const a = agent();
    if (g.current) g.current.position.set(a.pos[0], a.pose.startsWith('sit') || a.pose.startsWith('sofa') ? 1.75 : 2.05, a.pos[1]);
    const brief = a.card?.brief.split('\n')[0].slice(0, 90) ?? null;
    if (a.bubble !== state.bubble || a.duty !== state.duty || brief !== state.brief || a.say !== state.say) setState({ bubble: a.bubble, duty: a.duty, brief, say: a.say });
  });
  const a = agent();
  return (
    <group ref={g}>
      {state.say && !state.bubble && !hovered && (
        <Html center distanceFactor={9} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
          <div className="o3d-say">{state.say}</div>
        </Html>
      )}
      {(state.bubble || hovered) && (
        <Html center distanceFactor={9} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
          <div className={`o3d-label ${state.bubble ? `o3d-bubble o3d-${state.duty}` : ''}`}>
            {state.bubble && <span className="o3d-mark">{state.bubble}</span>}
            {hovered && (
              <span className="o3d-text">
                <strong>{a.role.nick ? `${a.role.nick} (${a.role.name})` : a.role.name}</strong> · {DUTY_TEXT[state.duty] ?? state.duty}
                {state.brief && <em>{state.brief}</em>}
              </span>
            )}
          </div>
        </Html>
      )}
    </group>
  );
}

/** A model that fails to load falls back to the clay stand-in instead of taking the office down. */
class ModelBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Which characters have a 3D model (scripts/characters.mjs build writes the list). */
function useBuiltCharacters(): Set<string> {
  const [built, setBuilt] = useState<Set<string>>(new Set());
  useEffect(() => {
    fetch('/characters/index.json')
      .then((r) => (r.headers.get('content-type')?.includes('json') ? r.json() : null))
      .then((d: { characters?: string[] } | null) => setBuilt(new Set(d?.characters ?? [])))
      .catch(() => undefined);
  }, []);
  return built;
}

function Person({ director, id, team, built, onOpen, theme, index, caps }: { director: Director; id: string; team: string; built: Set<string>; onOpen: (a: Agent) => void; theme: Theme; index: number; caps: boolean }) {
  const [hovered, setHovered] = useState(false);
  const get = () => director.agents.get(id)!;
  const a = get();
  // The theme's character once it is built (a nisse, Santa); until then the role's own.
  const themed = theme.character(a.role, index);
  const character = themed && built.has(themed) ? themed : characterOf(a.role);
  const hat = themed && character === themed && caps ? theme.hat(a.role, index) : null;
  const clay = <Character agent={get} style={styleOf(a.role)} portrait={avatarUrl(team, a.role)} onClick={() => onOpen(get())} onHover={setHovered} />;
  return (
    <>
      {built.has(character) ? (
        <ModelBoundary fallback={clay}>
          <Suspense fallback={clay}>
            <ModelCharacter character={character} agent={get} hat={hat} onClick={() => onOpen(get())} onHover={setHovered} />
          </Suspense>
        </ModelBoundary>
      ) : (
        clay
      )}
      <Label agent={get} hovered={hovered} />
    </>
  );
}

/** Ticks the director and keeps the camera's target inside the office. */
/** Frames the whole office from the front, a little from the right and high up, like a diorama on a table. */
function FitCamera({ layout }: { layout: Layout }) {
  const { camera, size, controls } = useThree();
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const w = layout.maxX - layout.minX;
    const d = layout.maxZ - layout.minZ;
    let cx = (layout.minX + layout.maxX) / 2;
    let cz = (layout.minZ + layout.maxZ) / 2;
    const aspect = size.width / Math.max(1, size.height);
    const vfov = (cam.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    // Far enough that the width fits across and the depth (foreshortened) fits up and down.
    const polar = 0.82;
    const azimuth = 0.22;
    let r = Math.max((w / 2) / Math.tan(hfov / 2), ((d * Math.cos(polar) + 2.4) / 2) / Math.tan(vfov / 2)) * 1.22;
    // ?pingis: up close at the table.
    if (PINGIS) {
      [cx, cz] = layout.pingpong.table;
      r = 7;
    }
    cam.position.set(cx + r * Math.sin(polar) * Math.sin(azimuth), r * Math.cos(polar), cz + r * Math.sin(polar) * Math.cos(azimuth));
    cam.lookAt(cx, 0, cz);
    const c = controls as unknown as { target?: THREE.Vector3; update?: () => void } | null;
    c?.target?.set(cx, 0, cz);
    c?.update?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, size.width, size.height, controls]);
  return null;
}

export default function Office3D(props: Office3DProps) {
  const { director, roles, team } = props;
  const layout = director.layout;

  const built = useBuiltCharacters();
  const office = useOfficeIndex();
  const theme = themeOf(props.theme);
  /** The theme's model for an office piece, once it is built; otherwise the office's own. */
  const m = (id: string) => {
    const t = theme.models[id];
    return t && office.props.has(t) ? t : id;
  };
  const art = office.art.filter(theme.art);
  // Nisses count from the first non-lead, so the two kinds and the cap colours take turns.
  const crew = roles.filter((r) => r.kind !== 'lead').map((r) => r.id);
  const open = (a: Agent) => (a.card ? props.onOpenCard(a.card.id) : props.onOpenAgent(a.id));
  const cx = (layout.minX + layout.maxX) / 2;
  const cz = (layout.minZ + layout.maxZ) / 2;

  // The ball, from the game (paddle to paddle, into the net, past someone).
  const pingBall = () => director.game?.ball() ?? null;
  const fresh = useFreshScene();

  return (
    <div className="office3d">
      <Canvas
        key={fresh.key}
        onCreated={fresh.onCreated}
        shadows
        dpr={[1, 2]}
        camera={{ fov: 32, near: 0.1, far: 200 }}
        gl={{ antialias: false, toneMapping: THREE.ACESFilmicToneMapping }}
      >
        <color attach="background" args={[theme.sky]} />
        <fog attach="fog" args={[theme.sky, 30, 70]} />
        <FitCamera layout={layout} />
        <Lights layout={layout} />
        <Suspense fallback={null}>
          <Floor layout={layout} colors={theme.colors} />
          <Walls layout={layout} colors={theme.colors} />
          {[...layout.desks.values()].map((d) => {
            const role = roles.find((r) => r.id === d.roleId);
            const themedWs = role ? theme.workstation(jobOf(role), role.kind) : null;
            const ws = themedWs && office.props.has(themedWs) ? themedWs : role ? workstationOf(jobOf(role), role.kind) : '';
            const deskModel = m(d.kind === 'lead' ? 'lead_desk' : 'desk');
            return (
            <group key={d.roleId}>
              <Desk
                at={d.desk}
                face={d.face}
                lead={d.kind === 'lead'}
                top={!office.props.has(deskModel)}
                bare={office.props.has(ws)}
                on={() => director.agents.get(d.roleId)?.pose === 'sit-type'}
              />
              {office.props.has(deskModel) && <Asset model={deskModel} index={office} position={[d.desk[0], 0, d.desk[1]]} rotation={[0, d.face, 0]} />}
              {/* The role's own workstation on the desk; its screens face the chair. */}
              {office.props.has(ws) && <Asset model={ws} index={office} position={[d.desk[0], 0.77, d.desk[1]]} rotation={[0, d.face + Math.PI, 0]} />}
              <Chair
                lead={d.kind === 'lead'}
                model={office.props.has(m('office_chair')) ? <Asset model={m('office_chair')} index={office} /> : undefined}
                pose={() => {
                  const a = director.agents.get(d.roleId);
                  // The chair goes with its sitter, and stays pushed out when they are away.
                  const sitting = a && a.path.length === 0 && Math.hypot(a.pos[0] - d.seat.at[0], a.pos[1] - d.seat.at[1]) < 0.1 && a.pose.startsWith('sit');
                  const tilt = !a ? 0 : a.pose === 'sit-rock' ? 0.1 + Math.sin(director.clock * 1.4 + a.seed) * 0.12 : a.pose === 'sit-lean' || a.pose === 'sit-feetup' ? 0.25 : 0;
                  return sitting ? { at: a.pos, face: a.face, tilt } : { at: d.seat.at, face: d.seat.face + 0.4, tilt: 0 };
                }}
              />
            </group>
            );
          })}
          {layout.bins.map((b, i) => (
            <Asset key={i} model={m('bin')} index={office} position={[b[0], 0, b[1]]} fallback={<Bin at={[0, 0]} />} />
          ))}
          {layout.plants.map((p, i) => (
            <Asset
              key={i}
              model={m(['plant_monstera', 'plant_fiddle', 'plant_snake'][i % 3])}
              index={office}
              position={[p.at[0], 0, p.at[1]]}
              fallback={<Plant at={[0, 0]} size={i === 0 ? 1.2 : 1} />}
            />
          ))}
          <PingPong layout={layout} ball={pingBall} />
          {office.props.has('kitchen') ? (
            <>
              <Asset model={m('kitchen')} index={office} position={[layout.coffee.machine.at[0] - 0.7, 0, layout.coffee.machine.at[1] - 0.55]} />
              <Asset model={m('coffee_machine')} index={office} position={[layout.coffee.machine.at[0], 0.92, layout.coffee.machine.at[1] - 0.6]} />
            </>
          ) : (
            <Kitchen layout={layout} />
          )}
          {office.props.has('sofa') ? (
            <>
              <Asset model={m('sofa')} index={office} position={[layout.sofa.at[0], 0, layout.sofa.at[1]]} rotation={[0, layout.sofa.face, 0]} />
              <Asset model={m('coffee_table')} index={office} position={[coffeeTable(layout)[0], 0, coffeeTable(layout)[1]]} />
            </>
          ) : (
            <Sofa layout={layout} />
          )}
          {office.props.has('whiteboard') ? (
            <Asset model={m('whiteboard')} index={office} position={[layout.whiteboard.at[0], 0, layout.whiteboard.at[1] + 0.35]} />
          ) : (
            <Whiteboard layout={layout} />
          )}
          <TestBench layout={layout} />
          {/* Furniture that is only there to look at, once it is made. */}
          <Asset model={m('bookshelf')} index={office} position={[layout.decor.bookshelf.at[0], 0, layout.decor.bookshelf.at[1]]} rotation={[0, layout.decor.bookshelf.face, 0]} />
          <Asset model={m('fridge')} index={office} position={[layout.decor.fridge.at[0], 0, layout.decor.fridge.at[1]]} rotation={[0, layout.decor.fridge.face, 0]} />
          <FridgeDoor color={theme.fridgeDoor} at={layout.decor.fridge.at} face={layout.decor.fridge.face} open={() => [...director.agents.values()].some((a) => a.activity === 'fridge' && !a.path.length)} />
          <Asset model={m('water_cooler')} index={office} position={[layout.decor.waterCooler.at[0], 0, layout.decor.waterCooler.at[1]]} rotation={[0, layout.decor.waterCooler.face, 0]} />
          <Asset model={m('armchair')} index={office} position={[layout.decor.armchair.at[0], 0, layout.decor.armchair.at[1]]} rotation={[0, layout.decor.armchair.face, 0]} />
          <Asset model={m('floor_lamp')} index={office} position={[layout.decor.floorLamp.at[0], 0, layout.decor.floorLamp.at[1]]} rotation={[0, layout.decor.floorLamp.face, 0]} />
          {layout.decor.beanbags.map((b, i) => (
            <Asset key={i} model={m('bean_bag')} index={office} position={[b.at[0], 0, b.at[1]]} rotation={[0, b.face, 0]} />
          ))}
          {art.length > 0 &&
            layout.art.map((slot, i) => (
              <Artwork key={i} art={art[i % art.length]} position={[slot.x, 1.7, slot.z + 0.03]} width={i % 2 ? 0.75 : 0.95} />
            ))}
          <PaperBalls director={director} />
          {roles.map((r) => (
            <Person key={r.id} director={director} id={r.id} team={team} built={built} onOpen={open} theme={theme} index={Math.max(0, crew.indexOf(r.id))} caps={office.props.has('xmas_luva')} />
          ))}
        </Suspense>
        <OrbitControls
          makeDefault
          target={[cx, 0, cz]}
          enableDamping
          dampingFactor={0.08}
          minPolarAngle={0.35}
          maxPolarAngle={1.2}
          minDistance={6}
          maxDistance={60}
          screenSpacePanning={false}
        />
        <EffectComposer multisampling={0}>
          <N8AO aoRadius={0.6} intensity={2.2} distanceFalloff={0.8} />
          <Vignette offset={0.4} darkness={0.2} />
          <SMAA />
        </EffectComposer>
      </Canvas>
    </div>
  );
}
