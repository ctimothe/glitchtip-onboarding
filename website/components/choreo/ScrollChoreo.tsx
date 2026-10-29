"use client";

import { useLayoutEffect, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { STAGES } from "./choreo-targets";
import { StageRail } from "./StageRail";

gsap.registerPlugin(ScrollTrigger);

export function ScrollChoreo() {
  const [active, setActive] = useState(0);

  useLayoutEffect(() => {
    const ctx = gsap.context(() => {
      const reduce = gsap.matchMedia();
      reduce.add("(prefers-reduced-motion: no-preference)", () => {
        // 1. Pinned scrubbed hero.
        gsap.timeline({
          scrollTrigger: { trigger: "#top", start: "top top", end: "+=100%", pin: true, scrub: 1 },
        })
          .from("#top h1", { y: 60, opacity: 0, duration: 1 }, 0)
          .from("#top p", { y: 40, opacity: 0, duration: 1, stagger: 0.12 }, 0.15)
          .from("#top .hero-cta", { y: 30, opacity: 0, duration: 0.8 }, 0.4);

        // 2. Panel parallax drift.
        gsap.utils.toArray<HTMLElement>('section[id^="beat-"]').forEach((section) => {
          gsap.fromTo(
            section,
            { yPercent: 8 },
            {
              yPercent: -8,
              ease: "none",
              scrollTrigger: { trigger: section, start: "top bottom", end: "bottom top", scrub: true },
            },
          );
        });

        // 3. Stage rail activation.
        STAGES.forEach((stage, index) => {
          ScrollTrigger.create({
            trigger: `#${stage.id}`,
            start: "top center",
            end: "bottom center",
            onToggle: (self) => {
              if (self.isActive) setActive(index);
            },
          });
        });

        // 4. Nav intensify after hero.
        ScrollTrigger.create({
          trigger: "#top",
          start: "bottom 80px",
          end: "max",
          toggleClass: { targets: "header", className: "nav-solid" },
        });
      });
    });
    return () => ctx.revert();
  }, []);

  return <StageRail active={active} />;
}
