// Six-stage setup state machine as a pure module. Every side effect lives
// behind SetupDeps so the call order is testable; the screen supplies real
// implementations. A stage runs only when it is the stored currentStage, never
// writes state belonging to a later stage, and onboarding.completedAt is set
// only after every verification result is green.
//
// The relay reads its pairing and applications from its environment, so it is
// redeployed whenever they change: unpaired at stage 2, paired at stage 3, and
// with the new application at stage 4, before GlitchTip is told to send to it.

import type { ApplicationState, WorkspaceState } from "../app/workspace";
import { rollbackTarget } from "./remote";

export type SetupStageNumber = WorkspaceState["onboarding"]["currentStage"];

export type SetupErrorCode =
  | "stage-blocked"
  | "confirmation-required"
  | "glitchtip-failed"
  | "bot-failed"
  | "preflight-failed"
  | "deploy-failed"
  | "pairing-failed"
  | "topic-failed"
  | "alert-failed"
  | "agent-install-failed"
  | "verify-failed"
  | "save-failed";

export class SetupError extends Error {
  /** `detail` names what failed (a field, a check); `reason` says why, when that is known. */
  constructor(
    public readonly code: SetupErrorCode,
    public readonly detail: string | null = null,
    public readonly reason: string | null = null,
  ) {
    super(code);
  }
}

/** Alert rule contract for stage 4 (amendment 2026-09-23). */
export const ALERT_RULE_CONTRACT = {
  webhookRecipient: "http://companion-relay:8090/v1/glitchtip/events",
  tags: ["environment", "release"],
  preset: "balanced",
  threshold: { events: 3, windowMinutes: 15 },
  enabledStates: ["error", "warning", "resolved", "setup_complete", "test"],
} as const;

export type ApplicationInput = {
  id: string;
  projectSlug: string;
  projectName: string;
  environments: string[];
  topicName: string;
  topicColor: number;
};

export type AgentInput = { repositoryPath: string; providers: Array<"codex" | "claude" | "other"> };

export type SetupDeps = {
  glitchtip: { verify(): Promise<{ baseUrl: string; organizationSlug: string }> };
  server: {
    /** `failed` names the checks that did not pass, by their preflight id. */
    preflight(): Promise<{ ok: boolean; failed: string[] }>;
    /** Configure the relay for `workspace` and deploy it. */
    deploy(workspace: WorkspaceState): Promise<{ ok: boolean; revision: string; previousRevision: string | null }>;
  };
  telegram: {
    /** The bot token the relay will run with is one Telegram accepts. */
    checkBot(): Promise<void>;
    pair(): Promise<{ botId: number; botUsername: string; chatId: number; chatTitle: string; allowedMemberIds: number[] }>;
    /** Posts the setup-complete message to the application's topic. */
    announceComplete(): Promise<void>;
  };
  application: {
    createTopic(app: ApplicationInput): Promise<{ topicId: number }>;
    /** Creates the alert rule; a rule that already sends elsewhere is left as it is. */
    configureAlert(app: ApplicationInput, topicId: number): Promise<void>;
    /** Points the application's alert rule at the relay, keeping its other recipients. */
    switchAlert(app: ApplicationState): Promise<void>;
  };
  agent: { install(app: ApplicationInput, input: AgentInput): Promise<{ helperVersion: string; skillVersion: string }> };
  verify: {
    /** The relay queued a test event; `eventId` is what its delivery is audited under. */
    syntheticEvent(): Promise<{ ok: boolean; eventId: string | null }>;
    /** Telegram took that event, as the relay's audit says; `failure` says why not, when known. */
    telegramDelivery(eventId: string): Promise<{ ok: boolean; failure: string | null }>;
    agentContext(): Promise<{ ok: boolean; canaryFound: boolean }>;
  };
};

export type SetupInput = {
  server?: {
    host: string;
    user: string;
    port: number;
    identityFile: string;
    dockerNetwork: string;
    deploymentDir: string;
    confirmed: boolean;
  };
  application?: ApplicationInput;
  agent?: AgentInput;
};

function require_(workspace: WorkspaceState, stage: SetupStageNumber): void {
  if (workspace.onboarding.completedAt !== null || workspace.onboarding.currentStage !== stage) {
    throw new SetupError("stage-blocked");
  }
}

async function guard<T>(code: SetupErrorCode, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof SetupError) throw err;
    throw new SetupError(code, err instanceof Error ? err.message : null);
  }
}

function advance(workspace: WorkspaceState, to: SetupStageNumber): WorkspaceState {
  return { ...workspace, onboarding: { ...workspace.onboarding, currentStage: to } };
}

/** Redeploy the relay configured for `next` and record the release. */
async function redeploy(next: WorkspaceState, deps: SetupDeps, now: () => string): Promise<WorkspaceState> {
  const relay = next.relay;
  if (!relay) throw new SetupError("stage-blocked");
  const dep = await guard("deploy-failed", () => deps.server.deploy(next));
  if (!dep.ok) throw new SetupError("deploy-failed");
  const previousRevision = rollbackTarget(relay, dep);
  return { ...next, relay: { ...relay, revision: dep.revision, previousRevision, status: "healthy", verifiedAt: now() } };
}

/**
 * Run the proof for `stage` and return the next WorkspaceState. Throws
 * SetupError (workspace unchanged) when the stage is not current or its proof
 * fails. `now` is injected for deterministic timestamps.
 */
export async function runStage(
  stage: SetupStageNumber,
  workspace: WorkspaceState,
  input: SetupInput,
  deps: SetupDeps,
  now: () => string = () => new Date().toISOString(),
): Promise<WorkspaceState> {
  require_(workspace, stage);
  switch (stage) {
    case 1: {
      const g = await guard("glitchtip-failed", () => deps.glitchtip.verify());
      return advance(
        { ...workspace, glitchtip: { baseUrl: g.baseUrl, organizationSlug: g.organizationSlug, verifiedAt: now() } },
        2,
      );
    }
    case 2: {
      const server = input.server;
      if (!server?.confirmed) throw new SetupError("confirmation-required");
      await guard("bot-failed", () => deps.telegram.checkBot());
      const pre = await guard("preflight-failed", () => deps.server.preflight());
      if (!pre.ok) throw new SetupError("preflight-failed", pre.failed.join(","));
      const dep = await guard("deploy-failed", () => deps.server.deploy(workspace));
      if (!dep.ok) throw new SetupError("deploy-failed");
      return advance(
        {
          ...workspace,
          relay: {
            host: server.host,
            user: server.user,
            port: server.port,
            identityFile: server.identityFile,
            dockerNetwork: server.dockerNetwork,
            deploymentDir: server.deploymentDir,
            revision: dep.revision,
            // Setup run again on a server already running this release has nothing to roll back to.
            previousRevision: dep.previousRevision === dep.revision ? null : dep.previousRevision,
            status: "healthy",
            verifiedAt: now(),
          },
        },
        3,
      );
    }
    case 3: {
      if (!workspace.relay) throw new SetupError("stage-blocked");
      const p = await guard("pairing-failed", () => deps.telegram.pair());
      if (!/^-100[1-9]\d*$/.test(String(p.chatId))) throw new SetupError("pairing-failed", "not-forum-supergroup");
      return advance(await redeploy({ ...workspace, telegram: { ...p, pairedAt: now() } }, deps, now), 4);
    }
    case 4: {
      const app = input.application;
      if (!app) throw new SetupError("topic-failed", "missing-application");
      if (!workspace.relay) throw new SetupError("stage-blocked");
      const topic = await guard("topic-failed", () => deps.application.createTopic(app));
      const state: ApplicationState = {
        id: app.id,
        name: app.projectName,
        projectSlug: app.projectSlug,
        environments: app.environments,
        topicId: topic.topicId,
        topicColor: app.topicColor,
        alertPreset: ALERT_RULE_CONTRACT.preset,
        enabledStates: [...ALERT_RULE_CONTRACT.enabledStates],
        repositoryPath: null,
        agent: null,
        verifiedAt: null,
      };
      const next = await redeploy(
        { ...workspace, applications: [...workspace.applications.filter((a) => a.id !== app.id), state] },
        deps,
        now,
      );
      await guard("alert-failed", () => deps.application.configureAlert(app, topic.topicId));
      return advance(next, 5);
    }
    case 5: {
      const app = input.application;
      const agent = input.agent;
      if (!app || !agent) throw new SetupError("agent-install-failed", "missing-input");
      const installed = await guard("agent-install-failed", () => deps.agent.install(app, agent));
      return advance(
        {
          ...workspace,
          applications: workspace.applications.map((a) =>
            a.id === app.id
              ? {
                  ...a,
                  repositoryPath: agent.repositoryPath,
                  agent: {
                    providers: agent.providers,
                    skillVersion: installed.skillVersion,
                    helperVersion: installed.helperVersion,
                    verifiedAt: null,
                  },
                }
              : a,
          ),
        },
        6,
      );
    }
    case 6: {
      // The test event goes to this application's topic, so only it is proven here.
      const tested = workspace.applications.find((a) => a.id === input.application?.id);
      if (!tested) throw new SetupError("verify-failed", "missing-application");
      const synthetic = await guard("verify-failed", () => deps.verify.syntheticEvent());
      if (!synthetic.ok || synthetic.eventId === null) throw new SetupError("verify-failed", "syntheticEvent");
      const { eventId } = synthetic;
      const delivery = await guard("verify-failed", () => deps.verify.telegramDelivery(eventId));
      if (!delivery.ok) throw new SetupError("verify-failed", "telegramDelivery", delivery.failure);
      const context = await guard("verify-failed", () => deps.verify.agentContext());
      if (!context.ok || context.canaryFound) throw new SetupError("verify-failed", "agentContext");
      // Only with the whole path proven does GlitchTip send here, so a rule kept from an earlier
      // relay, such as v1's, keeps delivering until then. Another application's rule waits for its
      // own verification.
      try {
        await deps.application.switchAlert(tested);
      } catch (err) {
        throw new SetupError("verify-failed", "alertRule", err instanceof Error ? err.message : null);
      }
      // The message only tells the group; setup is complete whether or not it arrives.
      await deps.telegram.announceComplete().catch(() => undefined);
      const stamp = now();
      return {
        ...workspace,
        applications: workspace.applications.map((a) =>
          a.id === tested.id
            ? { ...a, verifiedAt: stamp, agent: a.agent ? { ...a.agent, verifiedAt: stamp } : a.agent }
            : a,
        ),
        onboarding: { ...workspace.onboarding, completedAt: stamp },
      };
    }
  }
}
