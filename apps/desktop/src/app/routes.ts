// App route model. Setup stages (1..6, see WorkspaceState["onboarding"] in
// ./workspace) map 1:1 to SetupStage in declaration order; the operations
// screens (overview through settings) are reached only once onboarding
// completes.

export type SetupStage =
  | "glitchtip"
  | "server"
  | "telegram"
  | "application"
  | "agent"
  | "verify";

export type AppRoute =
  | { kind: "setup"; stage: SetupStage }
  | { kind: "overview" }
  | { kind: "applications"; applicationId?: string }
  | { kind: "telegram" }
  | { kind: "relay" }
  | { kind: "delivery" }
  | { kind: "credentials" }
  | { kind: "settings" };
