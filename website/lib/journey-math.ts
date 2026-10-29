export const BEAT_COUNT = 7;

export function scrollToJourneyT(scrollY: number, maxScroll: number): number {
  if (maxScroll <= 0) return 0;
  return Math.min(1, Math.max(0, scrollY / maxScroll));
}

export function beatAt(t: number): number {
  return Math.min(BEAT_COUNT - 1, Math.floor(Math.min(1, Math.max(0, t)) * BEAT_COUNT));
}
