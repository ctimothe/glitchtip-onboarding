// Diagnostics report for support: the workspace's shape and health with every
// identifying value replaced. Tokens and DSNs never enter the workspace
// (they live in the Keychain); hostnames, SSH users, the organization, project
// slugs and application ids, chat ids and titles, bot identity and file paths
// are replaced here, so the report is safe to paste. Applications keep their
// order as `application-1`, `application-2`… so support can still refer to one.

import type { WorkspaceState } from "../app/workspace";

export const REDACTED = "[redacted]";

export function diagnosticsReport(workspace: WorkspaceState, generatedAt: string = new Date().toISOString()) {
  const { relay, telegram } = workspace;
  return {
    generatedAt,
    schemaVersion: workspace.schemaVersion,
    locale: workspace.locale,
    onboarding: workspace.onboarding,
    glitchtip: {
      baseUrl: REDACTED,
      organizationSlug: REDACTED,
      verifiedAt: workspace.glitchtip.verifiedAt,
    },
    relay:
      relay === null
        ? null
        : {
            host: REDACTED,
            user: REDACTED,
            port: relay.port,
            deploymentDir: REDACTED,
            revision: relay.revision,
            previousRevision: relay.previousRevision,
            status: relay.status,
            verifiedAt: relay.verifiedAt,
          },
    telegram:
      telegram === null
        ? null
        : {
            bot: REDACTED,
            chatId: REDACTED,
            chatTitle: REDACTED,
            allowedMembers: telegram.allowedMemberIds.length,
            pairedAt: telegram.pairedAt,
          },
    applications: workspace.applications.map((application, index) => ({
      id: `application-${index + 1}`,
      projectSlug: REDACTED,
      environments: application.environments,
      topicId: application.topicId,
      alertPreset: application.alertPreset,
      enabledStates: application.enabledStates,
      repositoryPath: application.repositoryPath === null ? null : REDACTED,
      agent:
        application.agent === null
          ? null
          : {
              providers: application.agent.providers,
              skillVersion: application.agent.skillVersion,
              helperVersion: application.agent.helperVersion,
              verifiedAt: application.agent.verifiedAt,
            },
      verifiedAt: application.verifiedAt,
    })),
  };
}

export function diagnosticsText(workspace: WorkspaceState, generatedAt?: string): string {
  return JSON.stringify(diagnosticsReport(workspace, generatedAt), null, 2);
}
