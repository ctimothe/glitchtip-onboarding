import type { ReactNode } from "react";
import { colors, type ColorName } from "@/theme/tokens";

export function BeatSplit({
  id,
  side,
  glow,
  kicker,
  title,
  children,
  panel,
}: {
  id?: string;
  side: "left" | "right";
  glow: ColorName;
  kicker: string;
  title: string;
  children: ReactNode;
  panel: ReactNode;
}) {
  const panelLeft = side === "left";
  return (
    <section id={id} className="flex min-h-[85vh] items-center px-6 md:px-16">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-10 lg:grid-cols-2">
        <div className={panelLeft ? "lg:order-2" : ""}>
          <p className="font-mono text-xs uppercase tracking-widest" style={{ color: colors[glow] }}>
            {kicker}
          </p>
          <h2 className="mt-2 font-display text-3xl text-ink md:text-4xl">{title}</h2>
          <div className="mt-4 space-y-4 text-muted">{children}</div>
        </div>
        <div className={panelLeft ? "lg:order-1" : ""}>
          <div
            className="w-full rounded-2xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur-md md:p-8"
            style={{ boxShadow: `0 0 80px -20px ${colors[glow]}55` }}
          >
            {panel}
          </div>
        </div>
      </div>
    </section>
  );
}
