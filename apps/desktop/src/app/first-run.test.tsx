import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => ({ workspace: undefined as unknown }));
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    get = vi.fn(async (key: string) => (key === "workspace" ? stored.workspace : undefined));
    set = vi.fn(async () => undefined);
    save = vi.fn(async () => undefined);
  },
}));
vi.mock("../components/TrayManager", () => ({ default: () => null }));
const inspect = vi.hoisted(() => vi.fn());
const pending = vi.hoisted(() => vi.fn(async (): Promise<{ project: string | null } | null> => null));
const retire = vi.hoisted(() => vi.fn<(projects: readonly string[]) => Promise<boolean>>(async () => false));
const turnOff = vi.hoisted(() => vi.fn(async () => true));
vi.mock("./migration", async (original) => ({
  ...(await original<typeof import("./migration")>()),
  inspectLegacyState: inspect,
  legacyPending: pending,
  retireLegacyInstall: retire,
  turnOffLegacyInstall: turnOff,
}));

import App from "../App";
import { t } from "../i18n";
import { migrateWorkspace } from "./workspace";

const languages = Object.getOwnPropertyDescriptor(Navigator.prototype, "languages");

afterEach(() => {
  stored.workspace = undefined;
  inspect.mockReset();
  pending.mockReset().mockResolvedValue(null);
  retire.mockClear();
  turnOff.mockReset().mockResolvedValue(true);
  if (languages) Object.defineProperty(Navigator.prototype, "languages", languages);
});

function preview(kind: "fresh" | "legacy") {
  return kind === "fresh"
    ? { kind }
    : {
        kind,
        legacy: {
          glitchtipUrl: "https://gt.example.com",
          organizationSlug: "acme",
          projectSlug: "web",
          hasGlitchtipToken: true,
          hasBotToken: true,
          macRelay: "running",
        },
      };
}

describe("first run", () => {
  it("opens the setup assistant in the Mac's language when nothing is installed", async () => {
    Object.defineProperty(Navigator.prototype, "languages", { configurable: true, get: () => ["ru-RU", "en-US"] });
    inspect.mockResolvedValue(preview("fresh"));
    render(<App />);
    expect(await screen.findByRole("heading", { name: t("ru", "setup.title") })).toBeTruthy();
    expect(document.documentElement.lang).toBe("ru");
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("offers the move from v1, or a fresh start instead", async () => {
    inspect.mockResolvedValue(preview("legacy"));
    render(<App />);
    expect(await screen.findByRole("heading", { name: t("en", "migration.title") })).toBeTruthy();
    expect(await screen.findByText("https://gt.example.com")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: t("en", "migration.setUpFresh") }));
    expect(await screen.findByRole("heading", { name: t("en", "setup.title") })).toBeTruthy();
  });

  it("says when the saved workspace cannot be read and offers to start over", async () => {
    stored.workspace = { schemaVersion: 99 };
    render(<App />);
    expect(await screen.findByText(t("en", "app.loadFailed"))).toBeTruthy();
    expect(inspect).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: t("en", "app.startOver") }));
    const sheet = screen.getByRole("dialog", { name: t("en", "app.startOverTitle") });
    await userEvent.click(within(sheet).getByRole("button", { name: t("en", "app.startOver") }));
    expect(await screen.findByRole("heading", { name: t("en", "setup.title") })).toBeTruthy();
  });

  function completed(applications: Array<{ project: string; verifiedAt: string | null }>) {
    return migrateWorkspace({
      schemaVersion: 1,
      id: "default",
      name: "Main",
      locale: "en",
      glitchtip: { baseUrl: "https://gt.example.com", organizationSlug: "acme", verifiedAt: "2026-10-01T00:00:00Z" },
      applications: applications.map(({ project, verifiedAt }, i) => ({
        id: project, name: project, projectSlug: project, environments: ["production"], topicId: 7 + i,
        topicColor: 7322096, alertPreset: "balanced", enabledStates: ["error"], repositoryPath: null, agent: null,
        verifiedAt,
      })),
      onboarding: { completedAt: "2026-10-02T00:00:00Z", currentStage: 6 },
    });
  }

  it("turns v1 off at launch only with a verified application for its project, and says while it is still on", async () => {
    // "web" was added after setup, and its verification has not passed yet.
    stored.workspace = completed([{ project: "api", verifiedAt: "2026-10-02T00:00:00Z" }, { project: "web", verifiedAt: null }]);
    pending.mockResolvedValue({ project: "web" });
    render(<App />);
    expect(await screen.findByText(t("en", "overview.macRelayProject", { project: "web" }))).toBeTruthy();
    expect(retire).toHaveBeenCalledWith(["api"]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("turns off a v1 whose project is unknown only when the user confirms", async () => {
    stored.workspace = completed([{ project: "api", verifiedAt: "2026-10-02T00:00:00Z" }]);
    pending.mockResolvedValue({ project: null });
    render(<App />);
    const row = await screen.findByTestId("health-mac-relay");
    expect(within(row).getByText(t("en", "overview.macRelayUnknown"))).toBeTruthy();
    turnOff.mockRejectedValueOnce(new Error("vault-not-verified"));
    await userEvent.click(within(row).getByRole("button", { name: t("en", "overview.macRelayTurnOff") }));
    const sheet = screen.getByRole("dialog", { name: t("en", "overview.macRelayTurnOffTitle") });
    await userEvent.click(within(sheet).getByRole("button", { name: t("en", "overview.macRelayTurnOff") }));
    expect(await within(sheet).findByText(t("en", "overview.macRelayTurnOffFailed"))).toBeTruthy();

    pending.mockResolvedValue(null);
    await userEvent.click(within(sheet).getByRole("button", { name: t("en", "overview.macRelayTurnOff") }));
    await waitFor(() => expect(screen.queryByTestId("health-mac-relay")).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(turnOff).toHaveBeenCalledTimes(2);
  });
});
