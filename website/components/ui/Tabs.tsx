"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type Tab = { id: string; label: string; content: ReactNode };

export function Tabs({ tabs }: { tabs: Tab[] }) {
  const [active, setActive] = useState(tabs[0]?.id ?? "");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    if (next == null) return;
    event.preventDefault();
    setActive(tabs[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div>
      {tabs.length === 0 ? null : (
      <div role="tablist" aria-label="Quick start by framework" className="flex flex-wrap gap-1 rounded-full border border-white/10 bg-black/40 p-1">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            role="tab"
            aria-selected={tab.id === active}
            onClick={() => setActive(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`rounded-full px-3 py-1 text-sm ${tab.id === active ? "bg-white/15 text-ink" : "text-muted hover:text-ink"}`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      )}
      {tabs.map((tab) =>
        tab.id === active ? (
          <div key={tab.id} role="tabpanel" className="mt-3">
            {tab.content}
          </div>
        ) : null,
      )}
    </div>
  );
}
