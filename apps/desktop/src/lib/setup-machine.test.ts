import { describe, expect, it } from "vitest";

import type { WorkspaceState } from "../app/workspace";
import { ALERT_RULE_CONTRACT, SetupError, runStage, type SetupDeps, type SetupInput } from "./setup-machine";

const NOW = () => "2026-10-15T10:00:00.000Z";

function workspace(stage: WorkspaceState["onboarding"]["currentStage"]): WorkspaceState {
  return {
    schemaVersion: 1,
    id: "ws-1",
    name: "Test",
    locale: "en",
    glitchtip: { baseUrl: "", organizationSlug: "", verifiedAt: "" },
    relay:
      stage >= 3
        ? {
            host: "h",
            user: "u",
            port: 22,
            identityFile: "",
            dockerNetwork: "n",
            deploymentDir: "/d",
            revision: "r0",
            previousRevision: null,
            status: "healthy",
            verifiedAt: NOW(),
          }
        : null,
    telegram: null,
    applications: [],
    onboarding: { completedAt: null, currentStage: stage },
  };
}

function makeDeps(
  calls: string[],
  overrides: Partial<{ deliveryOk: boolean; canary: boolean; deployed: WorkspaceState[]; revisions: string[]; switchFails: string }> = {},
): SetupDeps {
  const revisions = overrides.revisions ?? [];
  return {
    glitchtip: { verify: async () => (calls.push("glitchtip.verify"), { baseUrl: "https://gt.example", organizationSlug: "org" }) },
    server: {
      preflight: async () => (calls.push("server.preflight"), { ok: true, failed: [] }),
      deploy: async (target) => {
        calls.push("relay.deploy");
        overrides.deployed?.push(target);
        return { ok: true, revision: revisions.shift() ?? "r1", previousRevision: null };
      },
    },
    telegram: {
      checkBot: async () => void calls.push("telegram.checkBot"),
      pair: async () => (
        calls.push("telegram.pair"),
        { botId: 1, botUsername: "bot", chatId: -1001234567890, chatTitle: "Ops", allowedMemberIds: [42] }
      ),
      announceComplete: async () => void calls.push("telegram.announceComplete"),
    },
    application: {
      createTopic: async () => (calls.push("application.createTopic"), { topicId: 7 }),
      configureAlert: async () => void calls.push("application.configureAlert"),
      switchAlert: async (app) => {
        calls.push(`application.switchAlert ${app.projectSlug}`);
        if (overrides.switchFails) throw new Error(overrides.switchFails);
      },
    },
    agent: { install: async () => (calls.push("agent.install"), { helperVersion: "h1", skillVersion: "s1" }) },
    verify: {
      syntheticEvent: async () => (calls.push("verify.syntheticEvent"), { ok: true, eventId: "test-1:test" }),
      telegramDelivery: async (eventId) => (
        calls.push(`verify.telegramDelivery ${eventId}`),
        { ok: overrides.deliveryOk ?? true, failure: overrides.deliveryOk === false ? "telegram" : null }
      ),
      agentContext: async () => (calls.push("verify.agentContext"), { ok: true, canaryFound: overrides.canary ?? false }),
    },
  };
}

function application(projectSlug: string, id = projectSlug): WorkspaceState["applications"][number] {
  return {
    id, name: projectSlug, projectSlug, environments: ["production"], topicId: 7, topicColor: 7322096,
    alertPreset: "balanced", enabledStates: ["error"], repositoryPath: null, agent: null, verifiedAt: null,
  };
}

/** Stage 6 with `input.application` saved by stage 4. */
function verifying(...others: Array<WorkspaceState["applications"][number]>): WorkspaceState {
  return { ...workspace(6), applications: [application("web", "app-1"), ...others] };
}

const input: SetupInput = {
  server: { host: "h", user: "u", port: 22, identityFile: "/k", dockerNetwork: "n", deploymentDir: "/d", confirmed: true },
  application: { id: "app-1", projectSlug: "web", projectName: "Web App", environments: ["production"], topicName: "Web", topicColor: 7322096 },
  agent: { repositoryPath: "/repo", providers: ["codex"] },
};

describe("setup assistant state machine", () => {
  it("runs the six proofs in the pinned order and completes last", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls);
    let ws = workspace(1);
    for (const stage of [1, 2, 3, 4, 5, 6] as const) {
      expect(ws.onboarding.completedAt).toBeNull();
      ws = await runStage(stage, ws, input, deps, NOW);
    }
    expect(calls).toEqual([
      "glitchtip.verify",
      "telegram.checkBot",
      "server.preflight",
      "relay.deploy",
      "telegram.pair",
      "relay.deploy",
      "application.createTopic",
      "relay.deploy",
      "application.configureAlert",
      "agent.install",
      "verify.syntheticEvent",
      "verify.telegramDelivery test-1:test",
      "verify.agentContext",
      "application.switchAlert web",
      "telegram.announceComplete",
    ]);
    expect(ws.onboarding.completedAt).toBe(NOW());
    expect(ws.applications[0].enabledStates).toEqual(["error", "warning", "resolved", "setup_complete", "test"]);
    expect(ws.applications[0].alertPreset).toBe("balanced");
  });

  it("blocks a stage that is not the stored current stage", async () => {
    const calls: string[] = [];
    await expect(runStage(3, workspace(1), input, makeDeps(calls), NOW)).rejects.toMatchObject({ code: "stage-blocked" });
    expect(calls).toEqual([]);
  });

  it("resumes from the stored stage without redoing earlier proofs", async () => {
    const calls: string[] = [];
    const next = await runStage(3, workspace(3), input, makeDeps(calls), NOW);
    expect(calls).toEqual(["telegram.pair", "relay.deploy"]);
    expect(next.onboarding.currentStage).toBe(4);
    expect(next.applications).toEqual([]);
  });

  it("does not deploy without explicit confirmation", async () => {
    const calls: string[] = [];
    const unconfirmed = { ...input, server: { ...input.server!, confirmed: false } };
    await expect(runStage(2, workspace(2), unconfirmed, makeDeps(calls), NOW)).rejects.toBeInstanceOf(SetupError);
    expect(calls).toEqual([]);
  });

  it("refuses a pairing that is not a forum supergroup", async () => {
    const deps = makeDeps([]);
    deps.telegram.pair = async () => ({ botId: 1, botUsername: "b", chatId: -4567, chatTitle: "x", allowedMemberIds: [] });
    await expect(runStage(3, workspace(3), input, deps, NOW)).rejects.toMatchObject({ code: "pairing-failed" });
  });

  it("writes no completedAt, and leaves the alert rule alone, when delivery verification fails", async () => {
    const calls: string[] = [];
    await expect(runStage(6, verifying(), input, makeDeps(calls, { deliveryOk: false }), NOW)).rejects.toMatchObject({
      code: "verify-failed",
      detail: "telegramDelivery",
      reason: "telegram",
    });
    expect(calls).not.toContain("verify.agentContext");
    expect(calls.some((call) => call.startsWith("application.switchAlert"))).toBe(false);
  });

  it("completes only once the tested application's alert rule sends to the relay", async () => {
    const calls: string[] = [];
    const ws = verifying();
    await expect(runStage(6, ws, input, makeDeps(calls, { switchFails: "private-webhooks" }), NOW)).rejects.toMatchObject({
      code: "verify-failed",
      detail: "alertRule",
      reason: "private-webhooks",
    });
    expect(calls).not.toContain("telegram.announceComplete");
    const done = await runStage(6, ws, input, makeDeps((calls.length = 0, calls)), NOW);
    expect(calls.filter((call) => call.startsWith("application.switchAlert"))).toEqual(["application.switchAlert web"]);
    expect(done.onboarding.completedAt).toBe(NOW());
  });

  it("switches and verifies only the application whose test event was delivered", async () => {
    const calls: string[] = [];
    const earlier = { ...application("shop"), verifiedAt: "2026-10-01T00:00:00Z" };
    const done = await runStage(6, verifying(application("api"), earlier), input, makeDeps(calls), NOW);
    expect(calls.filter((call) => call.startsWith("application.switchAlert"))).toEqual(["application.switchAlert web"]);
    expect(done.applications.map((a) => [a.id, a.verifiedAt])).toEqual([
      ["app-1", NOW()],
      ["api", null],
      ["shop", "2026-10-01T00:00:00Z"],
    ]);
  });

  it("verifies nothing without the application to test", async () => {
    const calls: string[] = [];
    await expect(runStage(6, verifying(), { ...input, application: undefined }, makeDeps(calls), NOW)).rejects.toMatchObject({
      code: "verify-failed",
      detail: "missing-application",
    });
    expect(calls).toEqual([]);
  });

  it("completes even when the setup-complete message cannot be posted", async () => {
    const deps = makeDeps([]);
    deps.telegram.announceComplete = async () => {
      throw new Error("relay-unreachable");
    };
    const done = await runStage(6, verifying(), input, deps, NOW);
    expect(done.onboarding.completedAt).toBe(NOW());
  });

  it("fails when the secret canary leaks into agent context", async () => {
    await expect(runStage(6, verifying(), input, makeDeps([], { canary: true }), NOW)).rejects.toMatchObject({
      code: "verify-failed",
    });
  });

  it("configures the relay unpaired, then paired, then with the new application", async () => {
    const deployed: WorkspaceState[] = [];
    const deps = makeDeps([], { deployed });
    let ws = workspace(1);
    for (const stage of [1, 2, 3, 4] as const) ws = await runStage(stage, ws, input, deps, NOW);
    expect(deployed.map((d) => [d.telegram?.chatId ?? null, d.applications.map((a) => [a.id, a.topicId])])).toEqual([
      [null, []],
      [-1001234567890, []],
      [-1001234567890, [["app-1", 7]]],
    ]);
  });

  it("records the identity file and keeps the previous revision across a same-revision redeploy", async () => {
    const deps = makeDeps([], { revisions: ["r1", "r1", "r2"] });
    let ws = workspace(1);
    for (const stage of [1, 2] as const) ws = await runStage(stage, ws, input, deps, NOW);
    expect(ws.relay).toMatchObject({ identityFile: "/k", revision: "r1", previousRevision: null });
    ws = await runStage(3, ws, input, deps, NOW);
    expect(ws.relay).toMatchObject({ revision: "r1", previousRevision: null });
    ws = await runStage(4, ws, input, deps, NOW);
    expect(ws.relay).toMatchObject({ revision: "r2", previousRevision: "r1" });
  });

  it("keeps the last known release as the rollback target when a retry finds the new one running", async () => {
    const deps = makeDeps([]);
    deps.server.deploy = async () => ({ ok: true, revision: "r2", previousRevision: "r2" });
    const next = await runStage(4, workspace(4), input, deps, NOW);
    expect(next.relay).toMatchObject({ revision: "r2", previousRevision: "r0" });
  });

  it("offers no rollback when setup redeploys the release already running", async () => {
    const deps = makeDeps([]);
    deps.server.deploy = async () => ({ ok: true, revision: "r1", previousRevision: "r1" });
    const next = await runStage(2, workspace(2), input, deps, NOW);
    expect(next.relay).toMatchObject({ revision: "r1", previousRevision: null });
  });

  it("refuses a rejected bot before it touches the server", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls);
    deps.telegram.checkBot = async () => {
      throw new SetupError("bot-failed", "botToken");
    };
    await expect(runStage(2, workspace(2), input, deps, NOW)).rejects.toMatchObject({ code: "bot-failed", detail: "botToken" });
    expect(calls).toEqual([]);
  });

  it("names the pre-flight checks the server failed and deploys nothing", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls);
    deps.server.preflight = async () => ({ ok: false, failed: ["network", "disk"] });
    await expect(runStage(2, workspace(2), input, deps, NOW)).rejects.toMatchObject({ code: "preflight-failed", detail: "network,disk" });
    expect(calls).toEqual(["telegram.checkBot"]);
  });

  it("stays unpaired when the relay cannot be reconfigured after pairing", async () => {
    const deps = makeDeps([]);
    deps.server.deploy = async () => ({ ok: false, revision: "r1", previousRevision: "r0" });
    await expect(runStage(3, workspace(3), input, deps, NOW)).rejects.toMatchObject({ code: "deploy-failed" });
  });

  it("does not point GlitchTip at the relay before the relay knows the application", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls);
    deps.server.deploy = async () => {
      throw new Error("relay-env-invalid");
    };
    await expect(runStage(4, workspace(4), input, deps, NOW)).rejects.toMatchObject({ code: "deploy-failed" });
    expect(calls).toEqual(["application.createTopic"]);
  });

  it("refuses to pair a workspace that has no relay", async () => {
    await expect(runStage(3, { ...workspace(3), relay: null }, input, makeDeps([]), NOW)).rejects.toMatchObject({ code: "stage-blocked" });
  });

  it("pins the alert rule contract", () => {
    expect(ALERT_RULE_CONTRACT.webhookRecipient).toBe("http://companion-relay:8090/v1/glitchtip/events");
    expect(ALERT_RULE_CONTRACT.tags).toEqual(["environment", "release"]);
    expect(ALERT_RULE_CONTRACT.threshold).toEqual({ events: 3, windowMinutes: 15 });
    expect(ALERT_RULE_CONTRACT.enabledStates).not.toContain("info");
  });
});
