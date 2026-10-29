import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => undefined);
type Listener = (event: { payload: string }) => void;
const listen = vi.fn<(event: string, handler: Listener) => Promise<() => void>>(async () => () => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...(args as [])) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: Listener) => listen(event, handler),
}));

import { installAppMenu, menuLabels, onMenuCommand } from "./menu";

const destinations = [{ id: "overview", text: "Обзор" }];

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  delete window.__COMPANION_PREVIEW__;
  invoke.mockClear();
  listen.mockClear();
});

describe("menu bar", () => {
  it("labels every item in the workspace's language", () => {
    const labels = menuLabels("ru", destinations);
    expect(labels.settings).toBe("Настройки…");
    expect(labels.addApplication).toBe("Добавить приложение…");
    expect(labels.quit).toBe("Завершить GlitchTip Companion");
    expect(labels.destinations).toBe(destinations);
  });

  it("does nothing outside the Tauri window, including the design preview", async () => {
    await installAppMenu("en", destinations, true);
    window.__TAURI_INTERNALS__ = {};
    window.__COMPANION_PREVIEW__ = true;
    await installAppMenu("en", destinations, true);
    onMenuCommand(() => undefined)();
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it("sends the labels to Rust and hands chosen commands back", async () => {
    window.__TAURI_INTERNALS__ = {};
    await installAppMenu("uz", destinations, false);
    expect(invoke).toHaveBeenCalledWith("app_menu_update", {
      labels: menuLabels("uz", destinations),
      navigation: false,
    });

    const handler = vi.fn();
    onMenuCommand(handler);
    expect(listen).toHaveBeenCalledWith("app-menu", expect.any(Function));
    listen.mock.calls[0][1]({ payload: "relay" });
    expect(handler).toHaveBeenCalledWith("relay");
  });
});
