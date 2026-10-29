import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import MigrationScreen, { type MigrationApi } from "./MigrationScreen";
import { draftWorkspace } from "../app/workspace";
import { t } from "../i18n";

const LEGACY = {
  glitchtipUrl: "https://gt.example.com",
  organizationSlug: "acme",
  projectSlug: "web",
  hasGlitchtipToken: true,
  hasBotToken: false,
  macRelay: "running" as const,
};

describe("MigrationScreen", () => {
  it("shows what carries over, then opens setup on the imported draft", async () => {
    const draft = draftWorkspace("default", "en");
    const api: MigrationApi = {
      inspectLegacyState: async () => ({ kind: "legacy", legacy: LEGACY }),
      importLegacyInstall: vi.fn(async () => draft),
    };
    const onImported = vi.fn();
    render(<MigrationScreen locale="en" workspaceId="default" api={api} onImported={onImported} onStartFresh={() => undefined} />);
    expect(await screen.findByText("https://gt.example.com")).toBeTruthy();
    expect(screen.getByText("acme")).toBeTruthy();
    // Secrets show presence only.
    expect(screen.getByText(t("en", "migration.present"))).toBeTruthy();
    expect(screen.getByText(t("en", "migration.missing"))).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: t("en", "migration.continue") }));
    expect(api.importLegacyInstall).toHaveBeenCalledWith("default", "en");
    expect(onImported).toHaveBeenCalledWith(draft);
  });

  it("says why the settings could not be carried over and stays put", async () => {
    const api: MigrationApi = {
      inspectLegacyState: async () => ({ kind: "legacy", legacy: LEGACY }),
      importLegacyInstall: async () => {
        throw new Error("keychain-locked");
      },
    };
    const onImported = vi.fn();
    render(<MigrationScreen locale="en" workspaceId="default" api={api} onImported={onImported} onStartFresh={() => undefined} />);
    await userEvent.click(await screen.findByRole("button", { name: t("en", "migration.continue") }));
    expect((await screen.findByRole("alert")).textContent).toContain("keychain-locked");
    expect(onImported).not.toHaveBeenCalled();
  });
});
