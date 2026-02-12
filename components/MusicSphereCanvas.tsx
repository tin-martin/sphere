"use client";

import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Billboard, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { SphereTrack } from "@/lib/types";

type Props = {
  tracks: SphereTrack[];
  selectedTrackId: string | null;
  onSelectTrack: (trackId: string) => void;
};

function BaseSphere() {
  return (
    <mesh scale={1.32}>
      <sphereGeometry args={[1, 64, 64]} />
      <meshPhysicalMaterial
        color="#1a0d2a"
        roughness={0.46}
        metalness={0.1}
        clearcoat={0.24}
        clearcoatRoughness={0.62}
        emissive="#10051e"
        emissiveIntensity={0.26}
      />
    </mesh>
  );
}

function TrackPoints({ tracks, selectedTrackId }: { tracks: SphereTrack[]; selectedTrackId: string | null }) {
  const { camera } = useThree();
  const markerRefs = useRef<Array<THREE.Object3D | null>>([]);
  const fallbackTexture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return "";
    }
    const grad = ctx.createLinearGradient(0, 0, 64, 64);
    grad.addColorStop(0, "#4f2f7d");
    grad.addColorStop(1, "#26113d");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    return canvas.toDataURL("image/png");
  }, []);

  const coverUrls = useMemo(
    () => tracks.map((track) => track.albumArtUrl ?? fallbackTexture),
    [tracks, fallbackTexture]
  );
  const textures = useLoader(THREE.TextureLoader, coverUrls);

  useEffect(() => {
    textures.forEach((texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
    });
  }, [textures]);

  useFrame(() => {
    const viewAxis = camera.position.clone().normalize();
    for (let i = 0; i < tracks.length; i += 1) {
      const marker = markerRefs.current[i];
      if (!marker) {
        continue;
      }
      const p = tracks[i].position;
      const facing = viewAxis.x * p[0] + viewAxis.y * p[1] + viewAxis.z * p[2];
      marker.visible = facing > 0.03;
    }
  });

  return (
    <group>
      {tracks.map((track, index) => {
        const selected = track.id === selectedTrackId;
        const markerPos: [number, number, number] = [
          track.position[0] * 1.42,
          track.position[1] * 1.42,
          track.position[2] * 1.42
        ];
        return (
          <Billboard
            key={track.id}
            ref={(node) => {
              markerRefs.current[index] = node;
            }}
            position={markerPos}
            follow
            lockX={false}
            lockY={false}
            lockZ={false}
          >
            <mesh scale={selected ? 0.11 : 0.08}>
              <circleGeometry args={[1, 32]} />
              <meshBasicMaterial map={textures[index]} transparent depthTest depthWrite />
            </mesh>
            {selected ? (
              <mesh scale={0.13}>
                <ringGeometry args={[1.05, 1.2, 32]} />
                <meshBasicMaterial color="#bf9aff" transparent opacity={0.9} depthTest depthWrite={false} />
              </mesh>
            ) : null}
          </Billboard>
        );
      })}
    </group>
  );
}

function DirectionSelector({ tracks, onSelectTrack }: { tracks: SphereTrack[]; onSelectTrack: (trackId: string) => void }) {
  const { camera } = useThree();
  const viewAxis = useRef(new THREE.Vector3(0, 0, 1));
  const current = useRef<{ id: string | null; score: number; lastSwitchTs: number }>({
    id: null,
    score: -2,
    lastSwitchTs: 0
  });

  useFrame(({ clock }) => {
    if (!tracks.length) {
      return;
    }

    viewAxis.current.copy(camera.position).normalize();

    let bestId: string | null = null;
    let bestScore = -2;

    for (const track of tracks) {
      const score =
        viewAxis.current.x * track.position[0] +
        viewAxis.current.y * track.position[1] +
        viewAxis.current.z * track.position[2];

      if (score > bestScore) {
        bestId = track.id;
        bestScore = score;
      }
    }

    const now = clock.elapsedTime * 1000;
    const canSwitch = now - current.current.lastSwitchTs > 120;
    const isInitial = current.current.id === null;
    const changedTrack = bestId !== null && bestId !== current.current.id;
    const acceptableSwitch = bestScore >= current.current.score - 0.015;

    if (bestId && (isInitial || (canSwitch && changedTrack && acceptableSwitch))) {
      current.current = { id: bestId, score: bestScore, lastSwitchTs: now };
      onSelectTrack(bestId);
      return;
    }

    if (bestId === current.current.id) {
      current.current.score = bestScore;
    }
  });

  return null;
}

export default function MusicSphereCanvas({ tracks, selectedTrackId, onSelectTrack }: Props) {
  return (
    <Canvas camera={{ position: [0, 0, 3], fov: 46 }} dpr={[1, 2]}>
      <color attach="background" args={["#05020b"]} />
      <ambientLight intensity={0.34} color="#2b1841" />
      <pointLight position={[2.7, 2.3, 3.9]} intensity={1.1} color="#5f2d97" />
      <pointLight position={[-2.2, -1.9, -2.6]} intensity={0.36} color="#2f1546" />

      <BaseSphere />
      <TrackPoints tracks={tracks} selectedTrackId={selectedTrackId} />
      <DirectionSelector tracks={tracks} onSelectTrack={onSelectTrack} />

      <OrbitControls
        enablePan={false}
        rotateSpeed={0.7}
        enableDamping
        dampingFactor={0.08}
        minDistance={2.4}
        maxDistance={4.15}
      />
    </Canvas>
  );
}
