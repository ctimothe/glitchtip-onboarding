import { colors } from "@/theme/tokens";

export function StaticHero() {
  return (
    <div
      aria-hidden
      className="fixed inset-0 -z-10"
      style={{
        background: `radial-gradient(60% 50% at 20% 30%, ${colors.error}22, transparent 70%), radial-gradient(50% 45% at 80% 60%, ${colors.info}22, transparent 70%), radial-gradient(45% 40% at 55% 85%, ${colors.delivered}1a, transparent 70%), linear-gradient(${colors.void}, ${colors.abyss})`,
      }}
    />
  );
}
