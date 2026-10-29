"use client";

import { motion, useReducedMotion } from "framer-motion";

export type TerminalLine = { text: string; pass: boolean };

export function Terminal({ lines }: { lines: TerminalLine[] }) {
  const reduce = useReducedMotion();
  return (
    <div role="log" aria-label="Verification output" className="rounded-xl border border-white/10 bg-black/60 p-4 font-mono text-[13px] leading-relaxed">
      {lines.map((line, index) =>
        reduce ? (
          <div key={index} className={line.pass ? "text-delivered" : "text-error"}>
            {line.text}
          </div>
        ) : (
          <motion.div
            key={index}
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: index * 0.15, ease: "easeOut" }}
            className={line.pass ? "text-delivered" : "text-error"}
          >
            {line.text}
          </motion.div>
        ),
      )}
    </div>
  );
}
