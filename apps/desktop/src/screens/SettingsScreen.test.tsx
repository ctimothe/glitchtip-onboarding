import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-autostart", () => ({
  enable: vi.fn(async () => {}),
  disable: vi.fn(async () => {}),
  isEnabled: vi.fn(async () => false),
}));
vi.mock("../lib/glitchtip", async (original) => ({
  ...(await original<typeof import("../lib/glitchtip")>()),
  checkInstance: vi.fn(async () => ({ url: "x", glitchtipTitle: true, latencyMs: 1 })),
  listIssues: vi.fn(async () => ({ issues: [], nextCursor: null })),
}));
vi.mock("../lib/secrets", () => ({ set: vi.fn(async () => {}), get: vi.fn(), remove: vi.fn(async () => {}) }));

import { createWorkspace, type WorkspaceState } from "../app/workspace";
import * as glitchtip from "../lib/glitchtip";
import * as secrets from "../lib/secrets";
import SettingsScreen, { newSourceId } from "./SettingsScreen";

const workspace: WorkspaceState = {
  ...createWorkspace({
    id: "ws-1",
    name: "Main",
    glitchtip: { baseUrl: "https://errors.example.net", organizationSlug: "acme", verifiedAt: "2026-10-29T00:00:00Z" },
  }),
  locale: "en",
};

function fill(label: string, value: string) {
  fireEvent.change(within(screen.getByRole("dialog")).getByLabelText(label), { target: { value } });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("Settings: GlitchTip servers", () => {
  it("names a new server after its host, unique and Keychain-safe", () => {
    expect(newSourceId("https://errors.example.org/", [])).toBe("errors-example-org");
    expect(newSourceId("https://errors.example.org", ["errors-example-org"])).toBe(
      "errors-example-org-2",
    );
  });

  it("adds a server only after its token reads the organization's issues, and keeps the token in the Keychain", async () => {
    const onWorkspaceChange = vi.fn();
    render(<SettingsScreen workspace={workspace} onWorkspaceChange={onWorkspaceChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Add server…" }));
    fill("GlitchTip address", "https://errors.example.org/");
    fill("Organization slug", "lex");
    fill("API token", "secret-token");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onWorkspaceChange).toHaveBeenCalled());
    expect(glitchtip.listIssues).toHaveBeenCalledWith("https://errors.example.org", "secret-token", "lex");
    expect(secrets.set).toHaveBeenCalledWith("ws-1", "glitchtip-token.errors-example-org", "secret-token");
    const next = onWorkspaceChange.mock.lastCall![0] as WorkspaceState;
    expect(next.sources).toEqual([
      expect.objectContaining({ id: "errors-example-org", baseUrl: "https://errors.example.org", organizationSlug: "lex" }),
    ]);
  });

  it("keeps the sheet open and says why when the token is refused", async () => {
    vi.mocked(glitchtip.listIssues).mockRejectedValueOnce(new Error("GET /api/0/organizations/lex/issues/ -> HTTP 401"));
    const onWorkspaceChange = vi.fn();
    render(<SettingsScreen workspace={workspace} onWorkspaceChange={onWorkspaceChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Add server…" }));
    fill("GlitchTip address", "https://errors.example.org");
    fill("Organization slug", "lex");
    fill("API token", "bad");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Couldn't connect: GET /api/0/organizations/lex/issues/ -> HTTP 401")).toBeTruthy();
    expect(onWorkspaceChange).not.toHaveBeenCalled();
    expect(secrets.set).not.toHaveBeenCalled();
  });

  it("refuses the primary server twice", async () => {
    render(<SettingsScreen workspace={workspace} onWorkspaceChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add server…" }));
    fill("GlitchTip address", "https://errors.example.net/");
    fill("Organization slug", "acme");
    fill("API token", "t");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add" }));
    expect(await screen.findByText("This server and organization are already in the inbox.")).toBeTruthy();
    expect(glitchtip.checkInstance).not.toHaveBeenCalled();
  });

  it("refuses a server that is not HTTPS before sending the token anywhere", async () => {
    render(<SettingsScreen workspace={workspace} onWorkspaceChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add server…" }));
    fill("GlitchTip address", "http://errors.example.org");
    fill("Organization slug", "acme");
    fill("API token", "t");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add" }));
    expect(await screen.findByText(/must start with https:\/\//)).toBeTruthy();
    expect(glitchtip.checkInstance).not.toHaveBeenCalled();
    expect(secrets.set).not.toHaveBeenCalled();
  });

  it("offers Telegram setup only while no chat is paired", () => {
    const onSetUpTelegram = vi.fn();
    const { rerender } = render(
      <SettingsScreen workspace={workspace} onWorkspaceChange={vi.fn()} onSetUpTelegram={onSetUpTelegram} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Set up…" }));
    expect(onSetUpTelegram).toHaveBeenCalled();
    rerender(
      <SettingsScreen
        workspace={{
          ...workspace,
          telegram: { botId: 1, botUsername: "b", chatId: -1001, chatTitle: "c", allowedMemberIds: [1], pairedAt: "x" },
        }}
        onWorkspaceChange={vi.fn()}
        onSetUpTelegram={onSetUpTelegram}
      />,
    );
    expect(screen.queryByRole("button", { name: "Set up…" })).toBeNull();
  });
});
