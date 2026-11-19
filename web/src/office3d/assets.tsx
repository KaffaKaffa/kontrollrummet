import { useGLTF, useTexture } from '@react-three/drei';
import type { ThreeElements } from '@react-three/fiber';
import { Component, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import catalog from './catalog.json';

type GroupProps = ThreeElements['group'];

/**
 * Furniture and workstations made with Meshy (scripts/characters.mjs props),
 * and paintings for the walls. Each model is scaled to its size in the
 * catalogue; until it exists, the clay piece built in code stands in.
 */

export interface OfficeIndex {
  props: Set<string>;
  art: string[];
}

export function useOfficeIndex(): OfficeIndex {
  const [index, setIndex] = useState<OfficeIndex>({ props: new Set(), art: [] });
  useEffect(() => {
    fetch('/office/index.json')
      .then((r) => (r.headers.get('content-type')?.includes('json') ? r.json() : null))
      .then((d: { props?: string[]; art?: string[] } | null) => setIndex({ props: new Set(d?.props ?? []), art: d?.art ?? [] }))
      .catch(() => undefined);
  }, []);
  return index;
}

const SIZES = new Map(catalog.props.map((p) => [p.id, p]));

class Fallback extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function Model({ id }: { id: string }) {
  const gltf = useGLTF(`/office/${id}.glb`);
  const object = useMemo(() => {
    const o = gltf.scene.clone(true);
    o.traverse((m) => {
      if ((m as THREE.Mesh).isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    // To the catalogue's size, standing on the floor, centred.
    const spec = SIZES.get(id);
    const box = new THREE.Box3().setFromObject(o);
    const size = box.getSize(new THREE.Vector3());
    const dims = spec && 'dims' in spec ? (spec.dims as number[]) : null;
    if (dims && size.x > 0 && size.y > 0 && size.z > 0) {
      // Exact width × height × depth: Meshy's proportions are not to be trusted for tables and sofas.
      o.scale.set(dims[0] / size.x, dims[1] / size.y, dims[2] / size.z);
    } else {
      const measure = spec?.fit === 'height' ? size.y : Math.max(size.x, size.z);
      let k = spec && measure > 0 ? spec.size / measure : 1;
      // Workstations stay on the desk: no deeper than the desk top allows.
      if (spec && 'depth' in spec && size.z > 0) k = Math.min(k, (spec.depth as number) / size.z);
      o.scale.setScalar(k);
    }
    const b2 = new THREE.Box3().setFromObject(o);
    const c = b2.getCenter(new THREE.Vector3());
    o.position.set(-c.x, -b2.min.y, -c.z);
    const g = new THREE.Group();
    g.add(o);
    return g;
  }, [gltf.scene, id]);
  return <primitive object={object} />;
}

/** A Meshy model if it is built, otherwise the fallback. */
export function Asset({ model, index, fallback, ...group }: { model: string; index: OfficeIndex; fallback?: ReactNode } & Omit<GroupProps, 'id'>) {
  if (!index.props.has(model)) return <group {...group}>{fallback ?? null}</group>;
  return (
    <group {...group}>
      <Fallback fallback={fallback ?? null}>
        <Suspense fallback={fallback ?? null}>
          <Model id={model} />
        </Suspense>
      </Fallback>
    </group>
  );
}

/** A painting in a wooden frame, hung on a wall. */
export function Artwork({ art, width = 0.9, ...group }: { art: string; width?: number } & Omit<GroupProps, 'id'>) {
  const tex = useTexture(`/office/art/${art}.jpg`);
  const t = useMemo(() => {
    const c = tex.clone();
    c.colorSpace = THREE.SRGBColorSpace;
    c.needsUpdate = true;
    return c;
  }, [tex]);
  const h = width * 1.5;
  return (
    <group {...group}>
      <mesh castShadow>
        <boxGeometry args={[width + 0.08, h + 0.08, 0.04]} />
        <meshStandardMaterial color="#6b4f3a" roughness={0.7} />
      </mesh>
      <mesh position={[0, 0, 0.022]}>
        <planeGeometry args={[width - 0.04, h - 0.04]} />
        <meshStandardMaterial map={t} roughness={0.85} />
      </mesh>
    </group>
  );
}

/** The workstation that fits a role's job, by its character. */
export const workstationOf = (character: string, kind: string) => (kind === 'lead' ? 'ws_lead' : `ws_${character}`);
