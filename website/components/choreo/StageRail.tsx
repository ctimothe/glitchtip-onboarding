"use client";

import { STAGES } from "./choreo-targets";
import { colors } from "@/theme/tokens";

const GLOW = [colors.ink, colors.error, colors.info, colors.warning, colors.delivered, colors.error, colors.delivered];

export function StageRail({ active }: { active: number }) {
  return (
    <nav aria-hidden className="fixed right-6 top-1/2 z-10 hidden -translate-y-1/2 flex-col gap-3 xl:flex">
      {STAGES.map((stage, index) => (
        <div key={stage.id} className="flex items-center justify-end gap-2">
          <span
            className="font-mono text-[10px] uppercase tracking-widest transition-opacity"
            style={{ color: colors.muted, opacity: index === active ? 1 : 0.35 }}
          >
            {stage.label}
          </span>
          <span
            className="inline-block size-1.5 rounded-full transition-transform"
            style={{
              background: GLOW[index],
              transform: index === active ? "scale(1.8)" : "scale(1)",
              boxShadow: index === active ? `0 0 8px ${GLOW[index]}` : "none",
            }}
          />
        </div>
      ))}
    </nav>
  );
}
