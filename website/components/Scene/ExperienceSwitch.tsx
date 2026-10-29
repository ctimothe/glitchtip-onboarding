"use client";

import dynamic from "next/dynamic";
import { SceneErrorBoundary } from "./SceneErrorBoundary";
import { StaticHero } from "./StaticHero";
import { useWebGLCapable } from "./useWebGLCapable";

const AmbientBackground = dynamic(() => import("./AmbientBackground").then((m) => m.AmbientBackground), {
  ssr: false,
  loading: () => <StaticHero />,
});

const PlaneCanvas = dynamic(() => import("./PlaneCanvas").then((m) => m.PlaneCanvas), {
  ssr: false,
});

export function ExperienceSwitch() {
  const capable = useWebGLCapable();
  if (!capable) return <StaticHero />;
  return (
    <SceneErrorBoundary>
      <AmbientBackground />
      <PlaneCanvas />
    </SceneErrorBoundary>
  );
}
