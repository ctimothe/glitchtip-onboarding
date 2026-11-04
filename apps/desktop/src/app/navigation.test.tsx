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
    telegram:
      completedAt === null
        ? null
        : { botId: 1, botUsername: "acme_bot", chatId: -1001, chatTitle: "Acme", allowedMemberIds: [1], pairedAt: completedAt },
    onboarding: { completedAt, currentStage: completedAt === null ? 2 : 6 },
  });
}

/** Setup finished without Telegram: GlitchTip only. */
function inboxOnly(): WorkspaceState {
  return { ...workspace("2026-10-02T00:00:00Z"), telegram: null, onboarding: { completedAt: "2026-10-02T00:00:00Z", currentStage: 2 } };
}

describe("dashboard navigation", () => {
  it("shows a quiet spinner while the workspace loads", () => {
    render(<App />);
    const main = screen.getByRole("main");
    expect(main.getAttribute("aria-busy")).toBe("true");
    expect(main.querySelector(".ui-spinner")).not.toBeNull();
    expect(within(main).getByText("Loading workspace")).toBeDefined();
  });

  it("opens setup, without the sidebar, while onboarding is incomplete", () => {
    render(<App initialWorkspace={workspace(null)} />);
    expect(screen.getByRole("heading", { name: "Setup" })).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("opens the Inbox with the eight destinations in order once onboarding is complete", () => {
    render(<App initialWorkspace={workspace("2026-10-02T00:00:00Z")} />);
    const nav = screen.getByRole("navigation");
    const labels = within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(labels).toEqual([
      "Inbox",
      "Overview",
      "Applications",
      "Telegram",
      "Relay server",
      "Delivery activity",
      "Credentials",
      "Settings",
      "Add application",
    ]);
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeTruthy();
  });

  it("leaves out the delivery screens and Add application while Telegram is off", () => {
    render(<App initialWorkspace={inboxOnly()} />);
    const labels = within(screen.getByRole("navigation"))
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(labels).toEqual(["Inbox", "Overview", "Applications", "Credentials", "Settings"]);
    const [, destinations] = menu.install.mock.lastCall!;
    expect((destinations as Array<{ id: string }>).map((item) => item.id)).toEqual([
      "inbox",
      "overview",
      "applications",
      "credentials",
    ]);
    act(() => menu.handler!("add-application"));
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeTruthy();
    // Adding an application needs the relay, so the Applications toolbar offers no Add either.
    act(() => menu.handler!("applications"));
    expect(screen.getByRole("heading", { name: "Applications" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add application" })).toBeNull();
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
      "inbox",
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
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeTruthy();
  });
});
