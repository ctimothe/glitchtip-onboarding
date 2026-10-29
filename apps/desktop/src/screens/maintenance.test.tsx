import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/remote")>()),
  deployRelay: vi.fn(),
  deploymentPreview: vi.fn(),
  relayAuditTail: vi.fn(),
  relayStatus: vi.fn(),
  rollbackRelay: vi.fn(),
}));
vi.mock("../lib/keychain", async (original) => ({
  ...(await original<typeof import("../lib/keychain")>()),
  secretGet: vi.fn(),
  secretPresence: vi.fn(),
  secretRemove: vi.fn(),
  secretSet: vi.fn(),
}));

import { createWorkspace, type ApplicationState, type WorkspaceState } from "../app/workspace";
import { t } from "../i18n";
import * as keychain from "../lib/keychain";
import { buildRelayEnv } from "../lib/relay-config";
import * as remote from "../lib/remote";
import type { AuditRecord } from "../lib/remote";
import CredentialsScreen from "./CredentialsScreen";
import DeliveryActivityScreen from "./DeliveryActivityScreen";
import RelayServerScreen from "./RelayServerScreen";

function workspace(): WorkspaceState {
  return {
    ...createWorkspace({
      id: "ws1",
      name: "Main",
      glitchtip: { baseUrl: "https://gt.example.com", organizationSlug: "acme", verifiedAt: "2026-10-01T00:00:00Z" },
    }),
    locale: "en",
    relay: {
      host: "relay.example.com",
      user: "deploy",
      port: 22,
      identityFile: "",
      dockerNetwork: "glitchtip_default",
      deploymentDir: "/opt/relay",
      revision: "r2",
      previousRevision: "r1",
      status: "unknown",
      verifiedAt: null,
    },
  };
}

function application(): ApplicationState {
  return {
    id: "web",
    name: "Web",
    projectSlug: "web",
    environments: ["production"],
    topicId: 7,
    topicColor: 7322096,
    alertPreset: "balanced",
    enabledStates: ["error", "warning", "resolved", "setup_complete", "test"],
    repositoryPath: null,
    agent: null,
    verifiedAt: null,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("relay server", () => {
  it("closes the rollback sheet on failure and says why on the page", async () => {
    vi.mocked(remote.rollbackRelay).mockResolvedValue({ ok: false, revision: "r2", previousRevision: "r1", failedStep: "compose-up" });
    const update = vi.fn();
    render(<RelayServerScreen workspace={workspace()} onWorkspaceUpdate={update} />);
    await userEvent.click(screen.getByRole("button", { name: t("en", "relay.rollback") }));
    const sheet = screen.getByRole("dialog", { name: t("en", "relay.rollbackConfirmTitle") });
    await userEvent.click(within(sheet).getByRole("button", { name: t("en", "relay.rollback") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("alert").textContent).toContain(t("en", "relay.failed", { detail: "compose-up" }));
    expect(update).not.toHaveBeenCalled();
  });

  it("records a health check on the workspace as it is when the check returns", async () => {
    vi.mocked(remote.relayStatus).mockResolvedValue({ reachable: true, healthy: true, revision: "r2", detail: "ok" });
    const update = vi.fn();
    render(<RelayServerScreen workspace={workspace()} onWorkspaceUpdate={update} />);
    await userEvent.click(screen.getByRole("button", { name: t("en", "relay.checkHealth") }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    const renamed = { ...workspace(), name: "Renamed meanwhile" };
    expect(update.mock.calls[0][0](renamed)).toMatchObject({ name: "Renamed meanwhile", relay: { status: "healthy" } });
  });

  it("says when the relay still runs settings from before a change, and when it is up to date", async () => {
    const tokens = { botToken: "123456:AA-bb", glitchtipToken: "gt" };
    const items: Record<string, string> = {
      "telegram-bot-token": tokens.botToken,
      "glitchtip-token": tokens.glitchtipToken,
      // Deployed while the workspace was in Russian.
      "relay.env": buildRelayEnv({ workspace: { ...workspace(), locale: "ru" }, ...tokens }),
    };
    vi.mocked(keychain.secretGet).mockImplementation(async (_, key) => items[key] ?? null);
    const { unmount } = render(<RelayServerScreen workspace={workspace()} />);
    expect(await screen.findByText(t("en", "relay.settingsOutdated"))).toBeTruthy();
    unmount();
    items["relay.env"] = buildRelayEnv({ workspace: workspace(), ...tokens });
    render(<RelayServerScreen workspace={workspace()} />);
    expect(await screen.findByText(t("en", "relay.settingsCurrent"))).toBeTruthy();
  });
});

describe("delivery activity", () => {
  // As the relay writes them (assets/relay/server.js writeAudit), oldest first.
  const records: AuditRecord[] = [
    { eventId: "e1:error", applicationId: "web", state: "error", status: "delivered", at: "2026-10-29T10:00:00.000Z", retryCount: 0 },
    {
      eventId: "e2:warning",
      applicationId: "web",
      state: "warning",
      status: "retrying",
      at: "2026-10-29T10:05:00.000Z",
      retryCount: 2,
      failureCode: "telegram-403",
      nextRetryAt: "2026-10-29T10:10:00.000Z",
    },
  ];

  it("names each delivery by application and state, newest first, and says where to fix a failed one", async () => {
    vi.mocked(remote.relayAuditTail).mockResolvedValue(records);
    const ws = { ...workspace(), applications: [{ ...application(), id: "web", name: "Acme web" }] };
    const navigate = vi.fn();
    render(<DeliveryActivityScreen workspace={ws} onNavigate={navigate} />);
    await userEvent.click(screen.getByRole("button", { name: t("en", "delivery.load") }));
    const rows = await screen.findAllByText(/^Acme web · /);
    expect(rows.map((row) => row.textContent)).toEqual(["Acme web · Warning", "Acme web · Error"]);
    expect(screen.getByText(new RegExp(t("en", "delivery.failure.telegram")))).toBeTruthy();
    expect(screen.getByText(t("en", "delivery.delivered"))).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: t("en", "delivery.fixIn", { route: t("en", "nav.telegram") }) }));
    expect(navigate).toHaveBeenCalledWith("telegram");
  });
});

describe("credentials", () => {
  it("removes an item still stored under its v1 name", async () => {
    vi.mocked(keychain.secretPresence).mockResolvedValueOnce(["glitchtip.token"]).mockResolvedValue([]);
    vi.mocked(keychain.secretRemove).mockResolvedValue(undefined);
    render(<CredentialsScreen workspace={workspace()} />);
    await screen.findByText(t("en", "credentials.present"));
    const [glitchtip, telegram] = screen.getAllByRole("button", { name: t("en", "credentials.remove") });
    expect(telegram).toBeDisabled();
    await userEvent.click(glitchtip);
    const sheet = screen.getByRole("dialog");
    await userEvent.click(within(sheet).getByRole("button", { name: t("en", "credentials.remove") }));
    await waitFor(() => expect(keychain.secretRemove).toHaveBeenCalledOnce());
    expect(keychain.secretRemove).toHaveBeenCalledWith("ws1", "glitchtip.token");
  });
});
