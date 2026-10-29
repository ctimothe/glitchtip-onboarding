import { describe, expect, it } from "vitest";

import { migrateWorkspace } from "../app/workspace";
import { REDACTED, diagnosticsReport, diagnosticsText } from "./diagnostics";

const workspace = migrateWorkspace({
  schemaVersion: 1,
  id: "ws-1",
  name: "Main",
  locale: "en",
  glitchtip: { baseUrl: "https://errors.private-host.example", organizationSlug: "private-org", verifiedAt: "2026-10-01T00:00:00Z" },
  relay: {
    host: "10.20.30.40",
    user: "deploy-user",
    port: 2222,
    dockerNetwork: "glitchtip_default",
    deploymentDir: "/srv/secret-place",
    revision: "3f9c2a1",
    previousRevision: null,
    status: "healthy",
    verifiedAt: null,
  },
  telegram: {
    botId: 7000000001,
    botUsername: "private_alerts_bot",
    chatId: -1001234567890,
    chatTitle: "Private incident room",
    allowedMemberIds: [11, 22],
    pairedAt: "2026-10-02T00:00:00Z",
  },
  applications: [
    {
      id: "billing-portal",
      name: "Billing portal",
      projectSlug: "billing-portal-web",
      environments: ["production"],
      topicId: 5,
      topicColor: 7322096,
      alertPreset: "balanced",
      enabledStates: ["error"],
      repositoryPath: "/Users/someone/code/web",
      agent: null,
      verifiedAt: null,
    },
  ],
  onboarding: { completedAt: "2026-10-02T00:00:00Z", currentStage: 6 },
});

describe("diagnostics report", () => {
  it("leaves out every host, user, path, organization, project and chat identity", () => {
    const text = diagnosticsText(workspace, "2026-10-28T00:00:00Z");
    for (const value of [
      "errors.private-host.example",
      "10.20.30.40",
      "deploy-user",
      "/srv/secret-place",
      "private_alerts_bot",
      "7000000001",
      "-1001234567890",
      "Private incident room",
      "/Users/someone",
      "private-org",
      "billing-portal",
      "Billing portal",
    ]) {
      expect(text).not.toContain(value);
    }
  });

  it("keeps the shape and health support needs", () => {
    const report = diagnosticsReport(workspace, "2026-10-28T00:00:00Z");
    expect(report.relay).toMatchObject({ host: REDACTED, port: 2222, revision: "3f9c2a1", status: "healthy" });
    expect(report.telegram).toMatchObject({ chatId: REDACTED, allowedMembers: 2 });
    expect(report.applications[0]).toMatchObject({ id: "application-1", projectSlug: REDACTED, repositoryPath: REDACTED, alertPreset: "balanced" });
  });
});
