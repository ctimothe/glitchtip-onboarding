// Native window behaviour that the web view does not give for free.
//
// - `data-vibrancy`: inside the Tauri window on macOS the window is
//   transparent over the sidebar material (tauri.conf.json `windowEffects`),
//   so the sidebar token turns transparent.
// - `data-window-inactive`: selection and default buttons turn grey while
//   another app is frontmost, as AppKit draws them.
// - The web view's own context menu (Reload, Inspect Element) is suppressed
//   in release builds except where text can be selected or edited.

import { useEffect } from "react";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    /** Set by the browser design preview (preview.html), which fakes Tauri IPC. */
    __COMPANION_PREVIEW__?: boolean;
  }
}

export function hasNativeVibrancy(): boolean {
  return (
    typeof window !== "undefined" &&
    window.__TAURI_INTERNALS__ !== undefined &&
    window.__COMPANION_PREVIEW__ !== true &&
    /Macintosh|Mac OS X/.test(navigator.userAgent)
  );
}

function allowsContextMenu(target: EventTarget | null): boolean {
  if (window.getSelection()?.toString()) return true;
  return target instanceof Element && target.closest("input, textarea, pre, code, [data-selectable]") !== null;
}

export function useWindowChrome(): void {
  useEffect(() => {
    const root = document.documentElement;
    if (hasNativeVibrancy()) root.setAttribute("data-vibrancy", "");
    const onBlur = () => root.setAttribute("data-window-inactive", "");
    const onFocus = () => root.removeAttribute("data-window-inactive");
    // A window opened behind another app (a login item) never gets a first blur.
    if (!document.hasFocus()) onBlur();
    const onContextMenu = (event: MouseEvent) => {
      if (!allowsContextMenu(event.target)) event.preventDefault();
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    if (!import.meta.env.DEV) window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);
}
