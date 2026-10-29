import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    get = vi.fn(async () => undefined);
    set = vi.fn(async () => undefined);
    save = vi.fn(async () => undefined);
  },
}));
vi.mock("../components/TrayManager", () => ({ default: () => null }));
const menu = vi.hoisted(() => ({
  install: vi.fn<(locale: string, destinations: unknown, navigation: boolean) => Promise<void>>(async () => undefined),
  handler: null as ((command: string) => void) | null,
}));
vi.mock("./menu", () => ({
  installAppMenu: menu.install,
  onMenuCommand: (handler: (command: string) => void) => {
    menu.handler = handler;
    return () => {
      menu.handler = null;
    };
  },
}));
vi.mock("../lib/keychain", async (original) => ({
  ...(await original<typeof import("../lib/keychain")>()),
  secretPresence: vi.fn(async () => ["glitchtip-token"]),
}));

import App from "../App";
import { migrateWorkspace, type WorkspaceState } from "./workspace";

function workspace(completedAt: string | null): WorkspaceState {
  return migrateWorkspace({
    schemaVersion: 1,
    id: "ws-1",
    name: "Main",
    locale: "en",
    glitchtip: { baseUrl: "https://gt.example.com", organizationSlug: "org", verifiedAt: "2026-10-01T00:00:00Z" },
    onboarding: { completedAt, currentStage: completedAt === null ? 2 : 6 },
  });
}

describe("dashboard navigation", () => {
  it("opens setup, without the sidebar, while onboarding is incomplete", () => {
    render(<App initialWorkspace={workspace(null)} />);
    expect(screen.getByRole("heading", { name: "Setup" })).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("opens Overview with the seven destinations in order once onboarding is complete", () => {
    render(<App initialWorkspace={workspace("2026-10-02T00:00:00Z")} />);
    const nav = screen.getByRole("navigation");
    const labels = within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(labels).toEqual([
      "Overview",
      "Applications",
      "Telegram",
      "Relay server",
      "Delivery activity",
      "Credentials",
      "Settings",
      "Add application",
    ]);
    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(screen.getByText("Prepare agent brief")).toBeTruthy();
  });

  it("moves focus with arrow keys and opens a destination on activation", async () => {
    const user = userEvent.setup();
    render(<App initialWorkspace={workspace("2026-10-02T00:00:00Z")} />);
    const overview = screen.getByRole("button", { name: "Overview" });
    overview.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Applications" }));
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "Applications" })).toBeTruthy();
  });

  it("reuses the setup assistant in add-application mode", async () => {
    const user = userEvent.setup();
    render(<App initialWorkspace={workspace("2026-10-02T00:00:00Z")} />);
    await user.click(screen.getByRole("button", { name: "Add application" }));
    expect(screen.getByRole("heading", { name: "Add application" })).toBeTruthy();
  });

  it("never renders stored credential values", async () => {
    const user = userEvent.setup();
    render(<App initialWorkspace={workspace("2026-10-02T00:00:00Z")} />);
    await user.click(screen.getByRole("button", { name: "Credentials" }));
    expect(await screen.findByText("Stored")).toBeTruthy();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("gives each failure exactly one owning surface on its route", async () => {
    const user = userEvent.setup();
    render(<App initialWorkspace={workspace("2026-10-02T00:00:00Z")} />);
    await user.click(screen.getByRole("button", { name: "Relay server" }));
    expect(screen.getByRole("heading", { name: "Relay server" })).toBeTruthy();
    expect(screen.queryAllByRole("alert").length).toBeLessThanOrEqual(1);
  });

  it("disables the menu bar's commands while onboarding is incomplete", () => {
    render(<App initialWorkspace={workspace(null)} />);
    expect(menu.install).toHaveBeenLastCalledWith("en", expect.any(Array), false);
    expect(menu.handler).toBeNull();
  });

  it("lists the destinations but Settings under View and follows the menu bar's commands", () => {
    render(<App initialWorkspace={workspace("2026-10-02T00:00:00Z")} />);
    const [, destinations, navigation] = menu.install.mock.lastCall!;
    expect(navigation).toBe(true);
    expect((destinations as Array<{ id: string }>).map((item) => item.id)).toEqual([
      "overview",
      "applications",
      "telegram",
      "relay",
      "delivery",
      "credentials",
    ]);
    act(() => menu.handler!("relay"));
    expect(screen.getByRole("heading", { name: "Relay server" })).toBeTruthy();
    act(() => menu.handler!("settings"));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    act(() => menu.handler!("add-application"));
    expect(screen.getByRole("heading", { name: "Add application" })).toBeTruthy();
  });

  it("ignores menu bar commands while a sheet is open", () => {
    render(<App initialWorkspace={workspace("2026-10-02T00:00:00Z")} />);
    const sheet = document.createElement("div");
    sheet.setAttribute("role", "dialog");
    document.body.append(sheet);
    act(() => menu.handler!("relay"));
    sheet.remove();
    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
  });
});
