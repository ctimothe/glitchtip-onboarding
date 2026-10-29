"use client";

import { useEffect, useState } from "react";
import { shouldUseWebGL } from "@/lib/capabilities";

function probeWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return canvas.getContext("webgl2") != null || canvas.getContext("webgl") != null;
  } catch {
    return false;
  }
}

export function useWebGLCapable(): boolean {
  const [capable, setCapable] = useState(false);

  useEffect(() => {
    const nav = window.navigator as Navigator & { deviceMemory?: number };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-only client probe; window APIs unavailable during SSR.
    setCapable(
      shouldUseWebGL({
        prefersReducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        isMobileUA: /mobi|android|iphone|ipad/i.test(nav.userAgent),
        webglAvailable: probeWebGL(),
        deviceMemory: nav.deviceMemory,
        hardwareConcurrency: nav.hardwareConcurrency,
      }),
    );
  }, []);

  return capable;
}
