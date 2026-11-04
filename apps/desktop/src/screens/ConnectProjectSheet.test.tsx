import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/glitchtip", async (original) => ({
  ...(await original<typeof import("../lib/glitchtip")>()),
  provisionInventory: vi.fn(async () => [{ step: "project", status: "created", evidence: "" }]),
  projectDsn: vi.fn(async () => "https://k@errors.example.com/7"),
}));
vi.mock("../lib/secrets", () => ({ set: vi.fn(), get: vi.fn(async () => "tok"), remove: vi.fn() }));

import { createWorkspace } from "../app/workspace";
import * as glitchtip from "../lib/glitchtip";
import ConnectProjectSheet, { projectSlug } from "./ConnectProjectSheet";

const workspace = {
  ...createWorkspace({
    id: "ws-1",
    name: "Main",
    glitchtip: { baseUrl: "https://errors.example.com", organizationSlug: "acme", verifiedAt: "2026-10-29T00:00:00Z" },
  }),
  locale: "en" as const,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("Connect a project", () => {
  it("makes a slug of lowercase words joined by hyphens", () => {
    expect(projectSlug("  Acme Web — Admin! ")).toBe("acme-web-admin");
  });

  it("creates the project without an alert rule and shows its DSN to copy", async () => {
    render(<ConnectProjectSheet workspace={workspace} open onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Project name"), { target: { value: "Acme Web" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(await screen.findByLabelText("Project DSN")).toBeTruthy();
    expect(screen.getByLabelText("Project DSN").textContent).toBe("GLITCHTIP_DSN=https://k@errors.example.com/7");
    expect(glitchtip.provisionInventory).toHaveBeenCalledWith("https://errors.example.com", "tok", "acme", {
      team: "acme",
      project: "acme-web",
      projectName: "Acme Web",
    });
  });

  it("says why when GlitchTip refuses, and shows no DSN", async () => {
    vi.mocked(glitchtip.provisionInventory).mockResolvedValueOnce([
      { step: "project", status: "failed", evidence: "POST /api/0/teams/acme/acme/projects/ -> HTTP 403" },
    ]);
    render(<ConnectProjectSheet workspace={workspace} open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "web" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(/HTTP 403/)).toBeTruthy();
    expect(screen.queryByLabelText("Project DSN")).toBeNull();
    expect(glitchtip.projectDsn).not.toHaveBeenCalled();
  });
});
