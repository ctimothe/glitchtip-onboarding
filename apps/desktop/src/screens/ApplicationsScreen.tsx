import { Plus, SquareStack } from "lucide-react";

import type { ApplicationState, WorkspaceState } from "../app/workspace";
import { Button, DetailRow, EmptyState, FormSection, Page, ServiceMark } from "../components/ui";
import { t, type TranslationKey } from "../i18n";
import { formatRelative } from "../lib/format";
import { topicCss } from "../lib/topic-colors";

const PRESETS: Record<ApplicationState["alertPreset"], { label: TranslationKey; threshold: TranslationKey; quantity: number; minutes: number }> = {
  chatty: { label: "alertPreset.chatty.label", threshold: "alertPreset.chatty.threshold", quantity: 1, minutes: 10 },
  balanced: { label: "alertPreset.balanced.label", threshold: "alertPreset.balanced.threshold", quantity: 3, minutes: 15 },
  quiet: { label: "alertPreset.quiet.label", threshold: "alertPreset.quiet.threshold", quantity: 10, minutes: 60 },
};

const STATE_KEYS: Record<ApplicationState["enabledStates"][number], TranslationKey> = {
  error: "state.error",
  warning: "state.warning",
  resolved: "state.resolved",
  info: "state.info",
  setup_complete: "state.setupComplete",
  test: "state.test",
};

// Each agent with its vendor's mark, where the vendor publishes one.
const PROVIDERS: Record<"codex" | "claude" | "other", { label: TranslationKey; product?: "openai" | "anthropic" }> = {
  codex: { label: "agent.codex", product: "openai" },
  claude: { label: "agent.claude", product: "anthropic" },
  other: { label: "agent.other" },
};

export default function ApplicationsScreen({ workspace, onAdd }: { workspace: WorkspaceState; onAdd?: () => void }) {
  const l = workspace.locale;
  const add = onAdd ? (
    <Button variant="toolbar" icon={Plus} aria-label={t(l, "nav.addApplication")} title={t(l, "nav.addApplication")} onClick={onAdd} />
  ) : null;
  return (
    <Page title={t(l, "applications.title")} actions={add}>
      {workspace.applications.length === 0 ? (
        <EmptyState icon={SquareStack} title={t(l, "overview.noApplications")} />
      ) : null}
      {workspace.applications.map((app) => {
        const preset = PRESETS[app.alertPreset];
        return (
          <FormSection
            key={app.id}
            title={app.name}
            actions={<span className="ui-dot" style={{ background: topicCss(app.topicColor) }} aria-hidden="true" />}
          >
            <DetailRow label={t(l, "applications.project")} mono>
              {app.projectSlug}
            </DetailRow>
            <DetailRow label={t(l, "applications.environments")}>
              {app.environments.map((environment) => (
                <span key={environment} className="ui-chip">
                  {environment}
                </span>
              ))}
            </DetailRow>
            <DetailRow label={t(l, "applications.topicLabel")}>
              <span className="ui-dot" style={{ background: topicCss(app.topicColor) }} aria-hidden="true" />
              {t(l, "applications.topic", { id: app.topicId })}
            </DetailRow>
            <DetailRow label={t(l, "applications.policy")}>
              {`${t(l, preset.label)} · ${t(l, preset.threshold, { quantity: preset.quantity, minutes: preset.minutes })}`}
            </DetailRow>
            <DetailRow label={t(l, "applications.notifications")}>
              {app.enabledStates.map((state) => (
                <span key={state} className="ui-chip">
                  {t(l, STATE_KEYS[state])}
                </span>
              ))}
            </DetailRow>
            <DetailRow label={t(l, "applications.repository")} mono={app.repositoryPath !== null}>
              {app.repositoryPath ?? t(l, "applications.noRepository")}
            </DetailRow>
            <DetailRow label={t(l, "applications.agent")}>
              {app.agent === null ? (
                t(l, "applications.noSkill")
              ) : (
                <>
                  {app.agent.providers.map((provider) => {
                    const { label, product } = PROVIDERS[provider];
                    return product ? <ServiceMark key={provider} product={product} label={t(l, label)} size={14} decorative /> : null;
                  })}
                  <span>
                    {`${app.agent.providers.map((provider) => t(l, PROVIDERS[provider].label)).join(", ")} · ${t(l, "applications.skillVersion", { version: app.agent.skillVersion })}`}
                  </span>
                </>
              )}
            </DetailRow>
            <DetailRow label={t(l, "applications.lastVerified")}>
              {app.verifiedAt === null ? t(l, "applications.neverVerified") : formatRelative(app.verifiedAt, l)}
            </DetailRow>
          </FormSection>
        );
      })}
    </Page>
  );
}
