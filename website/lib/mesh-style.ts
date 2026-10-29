export type MeshStyle = {
  speed: number;
  swirl: number;
  distortion: number;
  grainOverlay: number;
};

const TABLE: MeshStyle[] = [
  { speed: 0.18, swirl: 0.2, distortion: 0.8, grainOverlay: 0.12 },
  { speed: 0.2, swirl: 0.24, distortion: 0.8, grainOverlay: 0.12 },
  { speed: 0.23, swirl: 0.28, distortion: 0.8, grainOverlay: 0.12 },
  { speed: 0.25, swirl: 0.3, distortion: 0.8, grainOverlay: 0.12 },
  { speed: 0.28, swirl: 0.34, distortion: 0.8, grainOverlay: 0.12 },
  { speed: 0.32, swirl: 0.4, distortion: 0.8, grainOverlay: 0.12 },
  { speed: 0.25, swirl: 0.3, distortion: 0.8, grainOverlay: 0.12 },
];

export function beatStyle(beat: number): MeshStyle {
  const index = Math.min(TABLE.length - 1, Math.max(0, Math.floor(beat)));
  return { ...TABLE[index] };
}
