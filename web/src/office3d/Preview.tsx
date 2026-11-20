import { OrbitControls, useGLTF } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { Suspense, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { ANIMATIONS_URL, modelUrl } from './characters.ts';

/**
 * One character up close, turning slowly: for picking a character without
 * hunting for it in the office.
 */
function Figure({ character }: { character: string }) {
  const model = useGLTF(modelUrl(character));
  const anims = useGLTF(ANIMATIONS_URL);
  const scene = useMemo(() => {
    const s = cloneSkinned(model.scene);
    s.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    return s;
  }, [model.scene]);
  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene]);
  useEffect(() => {
    const clip = anims.animations.find((c) => c.name === 'stand_idle') ?? anims.animations.find((c) => c.name === 'chat');
    if (clip) mixer.clipAction(clip).play();
    return () => {
      mixer.stopAllAction();
    };
  }, [anims.animations, mixer]);
  useFrame((_, dt) => mixer.update(dt));
  // Every character the same height, feet on the floor, so the frame fits them all.
  const fit = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const height = Math.max(box.max.y - box.min.y, 1e-3);
    const k = 1.7 / height;
    return { k, y: -box.min.y * k };
  }, [scene]);
  return (
    <group scale={fit.k} position={[0, fit.y, 0]}>
      <primitive object={scene} />
    </group>
  );
}

export default function Preview({ character }: { character: string }) {
  return (
    <div className="looks-preview">
      <Canvas shadows camera={{ position: [0, 1.3, 2.4], fov: 30 }} dpr={[1, 2]}>
        <color attach="background" args={['#f4ede4']} />
        <ambientLight intensity={0.9} />
        <directionalLight position={[2, 4, 3]} intensity={1.6} castShadow />
        <Suspense fallback={null}>
          <Figure key={character} character={character} />
        </Suspense>
        <OrbitControls target={[0, 1.1, 0]} enablePan={false} minDistance={0.5} maxDistance={4} autoRotate autoRotateSpeed={1.2} />
      </Canvas>
    </div>
  );
}
