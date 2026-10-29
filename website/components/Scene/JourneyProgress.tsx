"use client";

import { createContext, useContext, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { beatAt, scrollToJourneyT } from "@/lib/journey-math";

const JourneyContext = createContext<MutableRefObject<number> | null>(null);

export function JourneyProgress({ children }: { children: ReactNode }) {
  const t = useRef(0);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      t.current = scrollToJourneyT(window.scrollY, max);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <JourneyContext.Provider value={t}>{children}</JourneyContext.Provider>;
}

export function useJourney(): MutableRefObject<number> {
  const ref = useContext(JourneyContext);
  if (!ref) throw new Error("useJourney must be used inside JourneyProgress");
  return ref;
}

export function useJourneyBeat(): number {
  const t = useJourney();
  const [beat, setBeat] = useState(() => beatAt(t.current));

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      t.current = scrollToJourneyT(window.scrollY, max);
      setBeat((prev) => {
        const next = beatAt(t.current);
        return next === prev ? prev : next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [t]);

  return beat;
}
