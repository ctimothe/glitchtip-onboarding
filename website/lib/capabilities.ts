export type CapabilityInput = {
  prefersReducedMotion: boolean;
  isMobileUA: boolean;
  webglAvailable: boolean;
  deviceMemory?: number;
  hardwareConcurrency?: number;
};

export function shouldUseWebGL(input: CapabilityInput): boolean {
  if (input.prefersReducedMotion) return false;
  if (input.isMobileUA) return false;
  if (!input.webglAvailable) return false;
  if (input.deviceMemory != null && input.deviceMemory < 4) return false;
  if (input.hardwareConcurrency != null && input.hardwareConcurrency < 4) return false;
  return true;
}
