"use client";

// Background: MeshGradient by Paper Shaders (Apache-2.0) — https://shaders.paper.design
// Zero-dependency canvas shader; installed via npm, not vendored.

import { MeshGradient } from "@paper-design/shaders-react";
import { colors } from "@/theme/tokens";
import { beatStyle } from "@/lib/mesh-style";
import { useJourneyBeat } from "./JourneyProgress";

export function AmbientBackground() {
  const beat = useJourneyBeat();
  const style = beatStyle(beat);

  return (
    <div aria-hidden className="fixed inset-0 -z-10 bg-void">
      <MeshGradient
        colors={[colors.error, colors.warning, colors.info, colors.delivered]}
        distortion={0.8}
        swirl={style.swirl}
        grainMixer={0}
        grainOverlay={0.12}
        speed={style.speed}
        width="100%"
        height="100%"
        fit="cover"
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(120% 90% at 50% 10%, transparent 40%, ${colors.void}cc 100%), linear-gradient(${colors.void}99, transparent 30%, transparent 70%, ${colors.void}99)`,
        }}
      />
    </div>
  );
}
