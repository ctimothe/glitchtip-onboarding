// Per-Mac preferences that are not part of the workspace (which describes the
// Companion setup, not this window). Persisted through the store plugin in
// `preferences.json`; every failure falls back to the default silently, so a
// missing store never blocks the window from rendering.

import { LazyStore } from "@tauri-apps/plugin-store";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type Appearance = "system" | "light" | "dark";

const APPEARANCES: Appearance[] = ["system", "light", "dark"];
const store = new LazyStore("preferences.json");

export async function loadAppearance(): Promise<Appearance> {
  try {
    const value = await store.get<unknown>("appearance");
    return APPEARANCES.includes(value as Appearance) ? (value as Appearance) : "system";
  } catch {
    return "system";
  }
}

export async function saveAppearance(appearance: Appearance): Promise<void> {
  try {
    await store.set("appearance", appearance);
    await store.save();
  } catch {
    // Applied for this session even when it cannot be remembered.
  }
}

/**
 * Pin or release the theme. The window theme drives the native sidebar
 * material, the traffic lights and `prefers-color-scheme`; `data-theme`
 * pins the CSS tokens as well, so the page matches even outside Tauri.
 */
export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  if (appearance === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", appearance);
  try {
    void getCurrentWindow()
      .setTheme(appearance === "system" ? null : appearance)
      .catch(() => undefined);
  } catch {
    // Not inside a Tauri window (tests, browser preview).
  }
}
