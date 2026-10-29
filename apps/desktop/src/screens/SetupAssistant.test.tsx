import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkspace, type WorkspaceState } from "../app/workspace";

vi.mock("../lib/glitchtip", () => ({
  checkInstance: vi.fn(),
  fetchInventory: vi.fn(),
  provisionInventory: vi.fn(),
}));
vi.mock("../lib/secrets", () => ({ set: vi.fn(), get: vi.fn(), remove: vi.fn() }));
vi.mock("../lib/remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/remote")>()),
  serverPreflight: vi.fn(),
  deploymentPreview: vi.fn(),
  deployRelay: vi.fn(),
  relayControl: vi.fn(),
  relayAuditTail: vi.fn(),
}));
vi.mock("../lib/pairing", () => ({ createPairingCode: vi.fn(), waitForPairing: vi.fn() }));
vi.mock("../lib/telegram", () => ({ validateBotToken: vi.fn() }));
vi.mock("../lib/agent", () => ({ agentInstall: vi.fn(), agentInstallPreview: vi.fn(), agentVerify: vi.fn() }));
// The setup store, in memory: it outlives one rendered assistant, as it outlives an app restart.
const topics = vi.hoisted(() => new Map<string, number>());
vi.mock("../app/created-topics", () => ({
  createdTopic: async (key: string) => topics.get(key) ?? null,
  rememberTopic: async (key: string, topicId: number) => void topics.set(key, topicId),
  forgetCreatedTopics: async () => topics.clear(),
}));
vi.mock("../app/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/workspace")>();
  return { ...actual };
});

import * as agent from "../lib/agent";
import * as glitchtip from "../lib/glitchtip";
import * as pairing from "../lib/pairing";
import * as remote from "../lib/remote";
import * as secrets from "../lib/secrets";
import * as telegram from "../lib/telegram";
import { SetupAssistant } from "./SetupAssistant";

function fresh(): WorkspaceState {
  return { ...createWorkspace({
    id: "ws1",
    name: "Test",
    glitchtip: { baseUrl: "https://gt.example.com", organizationSlug: "acme", verifiedAt: "2026-01-01T00:00:00.000Z" },
  }), locale: "en" };
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function click(name: RegExp | string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

beforeEach(() => {
  vi.mocked(glitchtip.checkInstance).mockResolvedValue({ url: "x", glitchtipTitle: true, latencyMs: 1 });
  vi.mocked(glitchtip.fetchInventory).mockResolvedValue({
    org: "acme", team: null, project: null, key: false, alertRule: false, teams: [], projects: [],
  });
  // A Keychain that keeps what is written, so the relay environment can be built from it.
  const keychain = new Map<string, string>([["ws1/glitchtip-token", "gt-token"]]);
  vi.mocked(secrets.set).mockImplementation(async (workspaceId, key, value) => void keychain.set(`${workspaceId}/${key}`, value));
  vi.mocked(secrets.get).mockImplementation(async (workspaceId, key) => keychain.get(`${workspaceId}/${key}`) ?? null);
  vi.mocked(telegram.validateBotToken).mockResolvedValue("acme_bot");
});

afterEach(() => {
  topics.clear();
  cleanup();
  vi.clearAllMocks();
});

describe("setup assistant", () => {
  it("blocks stage 1 until verify succeeds, then saves the token and never shows it again", async () => {
    vi.mocked(glitchtip.fetchInventory).mockRejectedValueOnce(new Error("401"));
    const onChange = vi.fn();
    render(<SetupAssistant workspace={fresh()} onWorkspaceChange={onChange} />);
    expect(screen.queryByLabelText("Host")).toBeNull();
    type("API token", "secret-token");
    click("Verify GlitchTip");
    await waitFor(() => expect(screen.getAllByText(/rejected the address or token/)).toHaveLength(1));
    expect(onChange).not.toHaveBeenCalled();
    expect(secrets.set).not.toHaveBeenCalled();

    click("Verify GlitchTip");
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(secrets.set).toHaveBeenCalledWith("ws1", "glitchtip-token", "secret-token");
    expect(onChange.mock.calls[0][0].onboarding.currentStage).toBe(2);
    expect(await screen.findByLabelText("Server host")).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret-token");
  });

  it("uses a token already in the Keychain when the field is left empty", async () => {
    const onChange = vi.fn();
    render(<SetupAssistant workspace={fresh()} onWorkspaceChange={onChange} />);
    const field = screen.getByLabelText("API token") as HTMLInputElement;
    await waitFor(() => expect(field.placeholder).toBe("Saved in Keychain"));
    expect(field.value).toBe("");
    click("Verify GlitchTip");
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(glitchtip.fetchInventory).toHaveBeenCalledWith("https://gt.example.com", "gt-token", "acme");
    expect(secrets.set).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("gt-token");
  });

  it("says when the address is not a GlitchTip server", async () => {
    vi.mocked(glitchtip.checkInstance).mockRejectedValueOnce(new Error("not-a-glitchtip-instance"));
    render(<SetupAssistant workspace={fresh()} onWorkspaceChange={vi.fn()} />);
    type("GlitchTip address", "https://example.com");
    type("Organization slug", "acme");
    type("API token", "secret-token");
    click("Verify GlitchTip");
    await screen.findByText("No GlitchTip server answers at this address.");
    expect(screen.getByLabelText("GlitchTip address")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when GlitchTip does not accept the token", async () => {
    vi.mocked(glitchtip.fetchInventory).mockRejectedValueOnce(new Error("GET /api/0/organizations/acme/ -> HTTP 401"));
    render(<SetupAssistant workspace={fresh()} onWorkspaceChange={vi.fn()} />);
    type("GlitchTip address", "https://gt.example.com");
    type("Organization slug", "acme");
    type("API token", "secret-token");
    click("Verify GlitchTip");
    await screen.findByText("GlitchTip did not accept this token.");
    expect(screen.getByLabelText("API token")).toHaveAttribute("aria-invalid", "true");
    expect(secrets.set).not.toHaveBeenCalled();
  });

  it("shows the confirm sheet before deploy is called", async () => {
    const ws = { ...fresh(), onboarding: { completedAt: null, currentStage: 2 as const } };
    vi.mocked(remote.deploymentPreview).mockResolvedValue({
      revision: "r2", previousRevision: null, files: [{ path: "compose.yml", mode: "0644" }],
      composeServices: ["relay"], publishedPorts: [], commands: ["docker compose up -d"],
    });
    vi.mocked(remote.serverPreflight).mockResolvedValue({ ok: true, checks: [], existingRevision: null });
    vi.mocked(remote.deployRelay).mockResolvedValue({ ok: true, revision: "r2", previousRevision: null, failedStep: null });
    const onChange = vi.fn();
    render(<SetupAssistant workspace={ws} onWorkspaceChange={onChange} />);
    type("Server host", "10.0.0.1");
    type("Bot token from BotFather", "123456:AA-bb");
    click("Confirm");
    click("Preview deployment");
    await screen.findByText("Deployment preview");
    expect(remote.deployRelay).not.toHaveBeenCalled();
    click("Deploy relay");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(remote.deployRelay).not.toHaveBeenCalled();
    click("Deploy now");
    await waitFor(() => expect(remote.deployRelay).toHaveBeenCalledTimes(1));
    // The first deploy runs unpaired, before any application exists, from the default directory.
    expect(remote.deployRelay).toHaveBeenCalledWith(
      expect.objectContaining({ identityFile: "", deploymentDir: "$HOME/.local/share/glitchtip-companion", applicationIds: [] }),
    );
    const env = vi.mocked(secrets.set).mock.calls.find(([, key]) => key === "relay.env")?.[2] ?? "";
    expect(env).toContain("TELEGRAM_BOT_TOKEN='123456:AA-bb'\n");
    expect(env).toContain("GLITCHTIP_API_TOKEN='gt-token'\n");
    expect(env).not.toContain("TELEGRAM_CHAT_ID");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0].onboarding.currentStage).toBe(3);
    expect(document.body.textContent).not.toContain("123456:AA-bb");
  });

  it("names the pre-flight checks the server failed", async () => {
    const ws = { ...fresh(), onboarding: { completedAt: null, currentStage: 2 as const } };
    vi.mocked(remote.deploymentPreview).mockResolvedValue({
      revision: "r2", previousRevision: null, files: [], composeServices: [], publishedPorts: [], commands: [],
    });
    vi.mocked(remote.serverPreflight).mockResolvedValue({
      ok: false,
      checks: [
        { id: "docker", ok: true, detail: "Docker 29" },
        { id: "network", ok: false, detail: "glitchtip_default not found" },
        { id: "deployment-dir", ok: false, detail: "not writable" },
      ],
      existingRevision: null,
    });
    render(<SetupAssistant workspace={ws} onWorkspaceChange={vi.fn()} />);
    type("Server host", "10.0.0.1");
    type("Bot token from BotFather", "123456:AA-bb");
    click("Confirm");
    click("Preview deployment");
    await screen.findByText("Deployment preview");
    click("Deploy relay");
    click("Deploy now");
    expect(await screen.findByText("The server failed these checks: Docker network, Deployment directory.")).toBeTruthy();
    expect(remote.deployRelay).not.toHaveBeenCalled();
  });

  it("says how to let GlitchTip send to the relay when the server finds private webhooks refused", async () => {
    const ws = { ...fresh(), onboarding: { completedAt: null, currentStage: 2 as const } };
    vi.mocked(remote.deploymentPreview).mockResolvedValue({
      revision: "r2", previousRevision: null, files: [], composeServices: [], publishedPorts: [], commands: [],
    });
    vi.mocked(remote.serverPreflight).mockResolvedValue({
      ok: false,
      checks: [
        { id: "glitchtip-network", ok: true, detail: "2 GlitchTip containers on glitchtip" },
        { id: "glitchtip-webhooks", ok: false, detail: "GLITCHTIP_ALLOW_PRIVATE_IPS off in 2 of 2" },
      ],
      existingRevision: null,
    });
    render(<SetupAssistant workspace={ws} onWorkspaceChange={vi.fn()} />);
    type("Server host", "10.0.0.1");
    type("Bot token from BotFather", "123456:AA-bb");
    click("Confirm");
    click("Preview deployment");
    await screen.findByText("Deployment preview");
    click("Deploy relay");
    click("Deploy now");
    expect(await screen.findByText(/GLITCHTIP_ALLOW_PRIVATE_IPS=true on GlitchTip's web and worker containers/)).toBeTruthy();
    expect(remote.deployRelay).not.toHaveBeenCalled();
  });

  it("says when Telegram does not accept the bot token, before anything reaches the server", async () => {
    const ws = { ...fresh(), onboarding: { completedAt: null, currentStage: 2 as const } };
    vi.mocked(remote.deploymentPreview).mockResolvedValue({
      revision: "r2", previousRevision: null, files: [], composeServices: [], publishedPorts: [], commands: [],
    });
    vi.mocked(telegram.validateBotToken).mockRejectedValue(new Error("invalid-bot-token"));
    render(<SetupAssistant workspace={ws} onWorkspaceChange={vi.fn()} />);
    type("Server host", "10.0.0.1");
    type("Bot token from BotFather", "123456:wrong");
    click("Confirm");
    click("Preview deployment");
    await screen.findByText("Deployment preview");
    click("Deploy relay");
    click("Deploy now");
    expect(await screen.findByText("Telegram did not accept this bot token.")).toBeTruthy();
    expect(remote.serverPreflight).not.toHaveBeenCalled();
    expect(remote.deployRelay).not.toHaveBeenCalled();
  });

  it("sets completedAt only after stage 6 verification", async () => {
    const ws: WorkspaceState = {
      ...fresh(),
      onboarding: { completedAt: null, currentStage: 6 },
      applications: [{
        id: "web", name: "Web", projectSlug: "web", environments: ["production"], topicId: 5, topicColor: 1,
        alertPreset: "balanced", enabledStates: ["error"], repositoryPath: "/repo",
        agent: { providers: ["codex"], skillVersion: "1", helperVersion: "1", verifiedAt: null }, verifiedAt: null,
      }],
    };
    vi.mocked(remote.relayControl).mockResolvedValue({ eventId: "test-1:test" });
    vi.mocked(remote.relayAuditTail).mockResolvedValue([
      { eventId: "test-1:test", applicationId: "web", state: "test", status: "delivered", at: "2026-10-29T10:00:00.000Z", retryCount: 0 },
    ]);
    vi.mocked(glitchtip.provisionInventory).mockResolvedValue([{ step: "alert", status: "updated", evidence: "PUT -> 200" }]);
    vi.mocked(agent.agentVerify).mockResolvedValueOnce({ ok: false, failedStep: "x", canaryFound: false, incidentRef: "" });
    const onChange = vi.fn();
    render(<SetupAssistant workspace={ws} onWorkspaceChange={onChange} />);
    click("Run verification");
    await screen.findByText("Verification failed.");
    expect(onChange).not.toHaveBeenCalled();
    // The alert rule stays as it was until every check has passed.
    expect(glitchtip.provisionInventory).not.toHaveBeenCalled();

    vi.mocked(agent.agentVerify).mockResolvedValueOnce({ ok: true, failedStep: null, canaryFound: false, incidentRef: "" });
    click("Run verification");
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0].onboarding.completedAt).not.toBeNull();
    expect(vi.mocked(glitchtip.provisionInventory).mock.calls[0][3]).toMatchObject({ project: "web", switchExisting: true });
    expect(vi.mocked(remote.relayControl).mock.calls.map(([, command]) => command.kind)).toContain("send-setup-complete");
  });

  it("says why Telegram did not take the test message", async () => {
    const ws: WorkspaceState = {
      ...fresh(),
      onboarding: { completedAt: null, currentStage: 6 },
      applications: [{
        id: "web", name: "Web", projectSlug: "web", environments: ["production"], topicId: 5, topicColor: 1,
        alertPreset: "balanced", enabledStates: ["error"], repositoryPath: "/repo",
        agent: { providers: ["codex"], skillVersion: "1", helperVersion: "1", verifiedAt: null }, verifiedAt: null,
      }],
    };
    vi.mocked(remote.relayControl).mockResolvedValue({ eventId: "test-1:test" });
    vi.mocked(remote.relayAuditTail).mockResolvedValue([
      {
        eventId: "test-1:test", applicationId: "web", state: "test", status: "retrying", at: "2026-10-29T10:00:00.000Z",
        retryCount: 1, failureCode: "telegram-403", nextRetryAt: "2026-10-29T10:01:00.000Z",
      },
    ]);
    render(<SetupAssistant workspace={ws} onWorkspaceChange={vi.fn()} />);
    click("Run verification");
    expect(await screen.findByText("Telegram refused the group or topic")).toBeTruthy();
    const status = (label: string) => screen.getByText(label).closest(".ui-row")?.textContent ?? "";
    expect(status("Message arrives in the topic")).toContain("Failed");
    expect(glitchtip.provisionInventory).not.toHaveBeenCalled();
  });

  it("marks the check that threw as failed and the earlier ones as passed", async () => {
    const ws: WorkspaceState = {
      ...fresh(),
      onboarding: { completedAt: null, currentStage: 6 },
      applications: [{
        id: "web", name: "Web", projectSlug: "web", environments: ["production"], topicId: 5, topicColor: 1,
        alertPreset: "balanced", enabledStates: ["error"], repositoryPath: "/repo",
        agent: { providers: ["codex"], skillVersion: "1", helperVersion: "1", verifiedAt: null }, verifiedAt: null,
      }],
    };
    vi.mocked(remote.relayControl).mockResolvedValue({ eventId: "test-1:test" });
    vi.mocked(remote.relayAuditTail).mockRejectedValue(new Error("ssh-failed"));
    render(<SetupAssistant workspace={ws} onWorkspaceChange={vi.fn()} />);
    click("Run verification");
    await screen.findByText("Verification failed.");
    const status = (label: string) => screen.getByText(label).closest(".ui-row")?.textContent ?? "";
    expect(status("Test event reaches the relay")).toContain("Passed");
    expect(status("Message arrives in the topic")).toContain("Failed");
    expect(status("Agent reads the incident")).toContain("Not run");
    expect(agent.agentVerify).not.toHaveBeenCalled();
  });

  it("offers a new pairing code once the last one expired", async () => {
    const ws: WorkspaceState = {
      ...fresh(),
      relay: {
        host: "h", user: "u", port: 22, identityFile: "", dockerNetwork: "n",
        deploymentDir: "$HOME/.local/share/glitchtip-companion", revision: "r1", previousRevision: null,
        status: "healthy", verifiedAt: "2026-01-01T00:00:00.000Z",
      },
      onboarding: { completedAt: null, currentStage: 3 },
    };
    await secrets.set("ws1", "telegram-bot-token", "123456:AA-bb");
    vi.mocked(pairing.createPairingCode).mockResolvedValue({ code: "ABCD-EFGH", expiresAt: "2026-01-01T00:10:00.000Z" });
    vi.mocked(pairing.waitForPairing).mockRejectedValue(new Error("pairing-expired"));
    render(<SetupAssistant workspace={ws} onWorkspaceChange={vi.fn()} />);
    click("Create pairing code");
    await screen.findByText("ABCD-EFGH");
    click("Wait for pairing");
    expect(await screen.findByText("The pairing code expired. Create a new one.")).toBeTruthy();
    expect(screen.queryByText("ABCD-EFGH")).toBeNull();
    expect(screen.getByRole("button", { name: "Create pairing code" })).toBeTruthy();
  });

  it("reuses the topic it created when a retry, even after a restart, follows a failed alert rule", async () => {
    const ws: WorkspaceState = {
      ...fresh(),
      relay: {
        host: "h", user: "u", port: 22, identityFile: "", dockerNetwork: "n",
        deploymentDir: "$HOME/.local/share/glitchtip-companion", revision: "r1", previousRevision: null,
        status: "healthy", verifiedAt: "2026-01-01T00:00:00.000Z",
      },
      telegram: { botId: 123456, botUsername: "acme_bot", chatId: -1001234567890, chatTitle: "Ops", allowedMemberIds: [42], pairedAt: "2026-01-01T00:00:00.000Z" },
      onboarding: { completedAt: null, currentStage: 4 },
    };
    await secrets.set("ws1", "telegram-bot-token", "123456:AA-bb");
    vi.mocked(remote.relayControl).mockResolvedValue({ topicId: 7 });
    vi.mocked(remote.deployRelay).mockResolvedValue({ ok: true, revision: "r1", previousRevision: "r1", failedStep: null });
    vi.mocked(glitchtip.provisionInventory)
      .mockResolvedValueOnce([{ step: "alert", status: "failed" }] as never)
      .mockResolvedValueOnce([] as never);
    const onChange = vi.fn();
    render(<SetupAssistant workspace={ws} onWorkspaceChange={onChange} />);
    type("GlitchTip project slug", "web");
    click("Create topic and alert");
    expect(await screen.findByText("The GlitchTip alert rule could not be configured.")).toBeTruthy();
    cleanup();
    render(<SetupAssistant workspace={ws} onWorkspaceChange={onChange} />);
    type("GlitchTip project slug", "web");
    click("Create topic and alert");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(vi.mocked(remote.relayControl).mock.calls.filter(([, command]) => command.kind === "topic-create")).toHaveLength(1);
    expect(onChange.mock.calls[0][0].applications.at(-1).topicId).toBe(7);
    // Saved with the application, so a later application gets its own topic.
    expect(topics.size).toBe(0);
  });

  it("keeps the created topic and stays on the stage when the application cannot be saved", async () => {
    const ws: WorkspaceState = {
      ...fresh(),
      relay: {
        host: "h", user: "u", port: 22, identityFile: "", dockerNetwork: "n",
        deploymentDir: "$HOME/.local/share/glitchtip-companion", revision: "r1", previousRevision: null,
        status: "healthy", verifiedAt: "2026-01-01T00:00:00.000Z",
      },
      telegram: { botId: 123456, botUsername: "acme_bot", chatId: -1001234567890, chatTitle: "Ops", allowedMemberIds: [42], pairedAt: "2026-01-01T00:00:00.000Z" },
      onboarding: { completedAt: null, currentStage: 4 },
    };
    await secrets.set("ws1", "telegram-bot-token", "123456:AA-bb");
    vi.mocked(remote.relayControl).mockResolvedValue({ topicId: 7 });
    vi.mocked(remote.deployRelay).mockResolvedValue({ ok: true, revision: "r1", previousRevision: "r1", failedStep: null });
    vi.mocked(glitchtip.provisionInventory).mockResolvedValue([]);
    const onChange = vi.fn().mockRejectedValueOnce(new Error("store-failed")).mockResolvedValue(undefined);
    render(<SetupAssistant workspace={ws} onWorkspaceChange={onChange} />);
    type("GlitchTip project slug", "web");
    click("Create topic and alert");
    expect(await screen.findByText("The setup could not be saved on this Mac. Try again.")).toBeTruthy();
    expect(topics.size).toBe(1);
    expect(screen.getByRole("button", { name: "Create topic and alert" })).toBeTruthy();
    click("Create topic and alert");
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(vi.mocked(remote.relayControl).mock.calls.filter(([, command]) => command.kind === "topic-create")).toHaveLength(1);
    await waitFor(() => expect(topics.size).toBe(0));
  });

  it("asks to move the app to Applications when it runs from a quarantined copy", async () => {
    const ws: WorkspaceState = {
      ...fresh(),
      onboarding: { completedAt: null, currentStage: 5 },
      applications: [{
        id: "web", name: "Web", projectSlug: "web", environments: ["production"], topicId: 5, topicColor: 1,
        alertPreset: "balanced", enabledStates: ["error"], repositoryPath: null, agent: null, verifiedAt: null,
      }],
    };
    vi.mocked(agent.agentInstallPreview).mockResolvedValue({ files: [], helperPath: "/h", requiresConfirmation: false });
    vi.mocked(agent.agentInstall).mockRejectedValue(new Error("app-translocated"));
    render(<SetupAssistant workspace={ws} onWorkspaceChange={vi.fn()} />);
    type("Repository path", "/repo");
    click("Preview generated files");
    await screen.findByRole("button", { name: "Install agent files" });
    click("Install agent files");
    expect(await screen.findByText("Move GlitchTip Companion to the Applications folder, open it from there, and try again.")).toBeTruthy();
    expect(vi.mocked(agent.agentInstallPreview).mock.calls[0][0]).toMatchObject({ projectSlug: "web", glitchtipBaseUrl: "https://gt.example.com" });
  });

  it("offers the suggested project for the application", async () => {
    const ws: WorkspaceState = { ...fresh(), onboarding: { completedAt: null, currentStage: 4 } };
    render(<SetupAssistant workspace={ws} onWorkspaceChange={vi.fn()} suggestedProject="web" />);
    expect((screen.getByLabelText("GlitchTip project slug") as HTMLInputElement).value).toBe("web");
  });

  it("says how to let GlitchTip send to the relay when it refuses the alert rule's webhook", async () => {
    const ws: WorkspaceState = {
      ...fresh(),
      relay: {
        host: "h", user: "u", port: 22, identityFile: "", dockerNetwork: "n",
        deploymentDir: "$HOME/.local/share/glitchtip-companion", revision: "r1", previousRevision: null,
        status: "healthy", verifiedAt: "2026-01-01T00:00:00.000Z",
      },
      telegram: { botId: 123456, botUsername: "acme_bot", chatId: -1001234567890, chatTitle: "Ops", allowedMemberIds: [42], pairedAt: "2026-01-01T00:00:00.000Z" },
      onboarding: { completedAt: null, currentStage: 4 },
    };
    await secrets.set("ws1", "telegram-bot-token", "123456:AA-bb");
    vi.mocked(remote.relayControl).mockResolvedValue({ topicId: 7 });
    vi.mocked(remote.deployRelay).mockResolvedValue({ ok: true, revision: "r1", previousRevision: "r1", failedStep: null });
    vi.mocked(glitchtip.provisionInventory).mockResolvedValueOnce([
      { step: "alert", status: "failed", reason: "private-webhooks", evidence: "POST -> HTTP 422" },
    ]);
    render(<SetupAssistant workspace={ws} onWorkspaceChange={vi.fn()} />);
    type("GlitchTip project slug", "web");
    click("Create topic and alert");
    expect(await screen.findByText(/GLITCHTIP_ALLOW_PRIVATE_IPS=true on GlitchTip's web and worker containers/)).toBeTruthy();
  });

  it("needs at least one environment before it adds an application", () => {
    const ws: WorkspaceState = { ...fresh(), onboarding: { completedAt: null, currentStage: 4 } };
    render(<SetupAssistant workspace={ws} onWorkspaceChange={vi.fn()} />);
    type("GlitchTip project slug", "web");
    type("Environments (comma separated)", " , ");
    expect(screen.getByRole("button", { name: "Create topic and alert" })).toHaveProperty("disabled", true);
  });

  it("starts at the application stage in add-application mode", () => {
    const done = { ...fresh(), onboarding: { completedAt: "2026-01-02T00:00:00.000Z", currentStage: 6 as const } };
    render(<SetupAssistant workspace={done} onWorkspaceChange={vi.fn()} mode="add-application" />);
    expect(screen.getByLabelText("GlitchTip project slug")).toBeTruthy();
    expect(pairing.createPairingCode).not.toHaveBeenCalled();
  });
});
