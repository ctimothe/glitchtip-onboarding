"use client";

import { useEffect, useRef, useState } from "react";

export function InstallPill({ command, compact = false }: { command: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // Clipboard unavailable (insecure context, test env) — the readonly input stays selectable.
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`flex max-w-full items-center gap-2 rounded-full border border-white/10 bg-black/50 font-mono ${compact ? "py-1 pl-3 pr-1 text-xs" : "py-1.5 pl-4 pr-1.5 text-sm"}`}>
      <span className="flex min-w-0 flex-1 select-all items-center text-ink">
        <span className="text-faint">$ </span>
        <input readOnly value={command} aria-label="Install command" className="w-full min-w-0 flex-1 bg-transparent outline-none sm:w-[38ch] sm:flex-none" />
      </span>
      <button
        type="button"
        onClick={copy}
        aria-live="polite"
        className="rounded-full bg-white/10 px-3 py-1 text-ink transition-colors hover:bg-white/20"
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}
