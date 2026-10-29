"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { colors } from "@/theme/tokens";
import { scrollToJourneyT } from "@/lib/journey-math";
import { useWebGLCapable } from "./useWebGLCapable";

gsap.registerPlugin(ScrollTrigger);

const FLIGHT_POINTS: Array<[number, number, number]> = [
  [6.2, 2.6, -1],
  [4.5, 0.8, 0.5],
  [-4.5, 2.2, -1.5],
  [-5.6, -0.6, 0],
  [-3, -2.4, 1],
  [3.5, -1.2, 2],
  [0, 0.2, 4.2],
];

function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
    if (Array.isArray(material)) {
      for (const entry of material) entry.dispose();
    } else if (material) {
      material.dispose();
    }
  });
}

export function PlaneCanvas() {
  const capable = useWebGLCapable();
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);

  useEffect(() => {
    if (!capable) return;
    // Double-guard: the WebGL gate already excludes reduced motion.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const mount = mountRef.current;
    if (!mount) return;

    let disposed = false;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 0.4, 11);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.HemisphereLight(0x8ea2ff, colors.void, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(4, 6, 8);
    scene.add(key);

    const accents: Array<{ color: string; intensity: number; distance: number; position: [number, number, number] }> = [
      { color: colors.error, intensity: 60, distance: 30, position: [-7, 2, 3] },
      { color: colors.info, intensity: 60, distance: 30, position: [7, -1, 3] },
      { color: colors.delivered, intensity: 40, distance: 25, position: [0, -3, 5] },
    ];
    for (const accent of accents) {
      const light = new THREE.PointLight(accent.color, accent.intensity, accent.distance);
      light.position.set(...accent.position);
      scene.add(light);
    }

    const curve = new THREE.CatmullRomCurve3(
      FLIGHT_POINTS.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
      false,
    );

    const readScrollT = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      return scrollToJourneyT(window.scrollY, max);
    };
    const target = { current: readScrollT() };
    let current = target.current;
    let roll = 0;

    // Read-only progress: scrub + onUpdate only, never drives the scroll position.
    const trigger = ScrollTrigger.create({
      start: 0,
      end: "max",
      scrub: 1,
      onUpdate: () => {
        target.current = readScrollT();
      },
    });

    let model: THREE.Group | null = null;
    const clock = new THREE.Clock();
    const up = new THREE.Vector3(0, 1, 0);
    const lookMatrix = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const tan = new THREE.Vector3();
    const lookTarget = new THREE.Vector3();

    const tick = () => {
      const delta = Math.min(clock.getDelta(), 0.1);
      current = THREE.MathUtils.damp(current, target.current, 4, delta);
      if (model) {
        curve.getPoint(current, pos);
        model.position.copy(pos);
        curve.getTangent(current, tan);
        lookTarget.copy(pos).add(tan);
        lookMatrix.lookAt(pos, lookTarget, up);
        model.quaternion.setFromRotationMatrix(lookMatrix);
        const rollTarget = THREE.MathUtils.clamp(-tan.x * 1.2, -0.9, 0.9);
        roll = THREE.MathUtils.damp(roll, rollTarget, 4, delta);
        model.rotateZ(roll);
      }
      renderer.render(scene, camera);
    };
    renderer.setAnimationLoop(tick);

    const onVisibility = () => {
      if (document.hidden) {
        renderer.setAnimationLoop(null);
      } else {
        clock.getDelta();
        if (!disposed) renderer.setAnimationLoop(tick);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", onResize);

    new GLTFLoader()
      .loadAsync("/models/paper-plane.glb")
      .then((gltf) => {
        if (disposed) {
          disposeObject(gltf.scene);
          return;
        }
        model = gltf.scene;
        model.scale.setScalar(9);
        scene.add(model);
      })
      .catch((error: unknown) => {
        if (!disposed) setLoadError(error instanceof Error ? error : new Error("Failed to load paper-plane.glb"));
      });

    return () => {
      disposed = true;
      trigger.kill();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
      renderer.setAnimationLoop(null);
      if (model) scene.remove(model);
      disposeObject(scene);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [capable]);

  if (!capable) return null;
  if (loadError) throw loadError;

  return <div aria-hidden className="pointer-events-none fixed inset-0 -z-[5]" ref={mountRef} />;
}
