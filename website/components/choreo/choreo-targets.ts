export type Stage = { id: string; label: string };

export const STAGES: Stage[] = [
  { id: "top", label: "Intro" },
  { id: "beat-1", label: "Capture" },
  { id: "beat-2", label: "Transport" },
  { id: "beat-3", label: "Groups" },
  { id: "beat-4", label: "Scrub" },
  { id: "beat-5", label: "Relay" },
  { id: "beat-6", label: "Human" },
];

export function railLabel(beat: number): string {
  const index = Math.min(STAGES.length - 1, Math.max(0, Math.floor(beat)));
  return STAGES[index].label;
}
