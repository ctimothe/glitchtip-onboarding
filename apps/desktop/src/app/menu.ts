// The macOS menu bar (src-tauri/src/app_menu.rs). Rust builds it from the labels sent here, in
// the workspace's language, and sends back the command of an item the user chose: a sidebar
// destination, `settings` or `add-application`. Outside the Tauri window both calls do nothing.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { t, type Locale } from "../i18n";

/** A sidebar destination, in sidebar order: the n-th gets ⌘n. */
export type MenuDestination = { id: string; text: string };

function inNativeWindow(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined && window.__COMPANION_PREVIEW__ !== true;
}

export function menuLabels(locale: Locale, destinations: MenuDestination[]) {
  return {
    app: t(locale, "appName"),
    about: t(locale, "menu.about"),
    settings: t(locale, "menu.settings"),
    services: t(locale, "menu.services"),
    hide: t(locale, "menu.hide"),
    hideOthers: t(locale, "menu.hideOthers"),
    showAll: t(locale, "menu.showAll"),
    quit: t(locale, "menu.quit"),
    file: t(locale, "menu.file"),
    addApplication: t(locale, "menu.addApplication"),
    closeWindow: t(locale, "menu.closeWindow"),
    edit: t(locale, "menu.edit"),
    undo: t(locale, "menu.undo"),
    redo: t(locale, "menu.redo"),
    cut: t(locale, "menu.cut"),
    copy: t(locale, "menu.copy"),
    paste: t(locale, "menu.paste"),
    selectAll: t(locale, "menu.selectAll"),
    view: t(locale, "menu.view"),
    fullScreen: t(locale, "menu.fullScreen"),
    window: t(locale, "menu.window"),
    minimize: t(locale, "menu.minimize"),
    zoom: t(locale, "menu.zoom"),
    help: t(locale, "menu.help"),
    destinations,
  };
}

/** `navigation` is false until setup is done: the app's own commands are then disabled. */
export async function installAppMenu(locale: Locale, destinations: MenuDestination[], navigation: boolean): Promise<void> {
  if (!inNativeWindow()) return;
  await invoke("app_menu_update", { labels: menuLabels(locale, destinations), navigation });
}

/** Calls `handler` with each chosen command; returns the unsubscribe. */
export function onMenuCommand(handler: (command: string) => void): () => void {
  if (!inNativeWindow()) return () => undefined;
  const unlisten = listen<string>("app-menu", (event) => handler(event.payload));
  return () => void unlisten.then((stop) => stop());
}
