import { useState } from "react";
import { Laptop, Server } from "lucide-react";

import type { OperationsKind } from "../App";
import type { LegacyPending } from "../app/migration";
import type { WorkspaceState } from "../app/workspace";
import {
  Button,
  FormSection,
  InlineAlert,
  ListRow,
  Page,
  ServiceMark,
  Sheet,
  StatusBadge,
  type Status,
} from "../components/ui";
import { t, type TranslationKey } from "../i18n";
import { hostOf } from "../lib/format";
import { topicCss } from "../lib/topic-colors";

const PRESET_KEYS = {
  chatty: "alertPreset.chatty.label",
  balanced: "alertPreset.balanced.label",
  quiet: "alertPreset.quiet.label",
} as const satisfies Record<WorkspaceState["applications"][number]["alertPreset"], TranslationKey>;

export default function OverviewScreen({
  workspace,
  legacy = null,
  onNavigate,
  onAddApplication,
  onTurnOffLegacy,
  onPrepareBrief,
}: {
  workspace: WorkspaceState;
  /** v1 while the relay on this Mac still runs after the move. */
  legacy?: LegacyPending | null;
  onNavigate?: (kind: OperationsKind) => void;
  onAddApplication?: () => void;
  /** Retires v1 whatever it still delivers; rejects when it could not. */
  onTurnOffLegacy?: () => Promise<void>;
  onPrepareBrief?: () => void;
}) {
  const l = workspace.locale;
  const [turnOff, setTurnOff] = useState<"closed" | "open" | "pending" | "failed">("closed");
  async function confirmTurnOff() {
    if (!onTurnOffLegacy) return;
    setTurnOff("pending");
    try {
      await onTurnOffLegacy();
      setTurnOff("closed");
    } catch {
      setTurnOff("failed");
    }
  }
  const relay = workspace.relay;
  const telegram = workspace.telegram;
  const relayStatus: Status =
    relay === null ? "unknown" : relay.status === "healthy" ? "ok" : relay.status === "degraded" ? "warning" : "unknown";
  const relayText =
    relay === null
      ? t(l, "status.notConfigured")
      : t(l, relayStatus === "ok" ? "status.ok" : relayStatus === "warning" ? "status.warning" : "status.unknown");
  const go = (kind: OperationsKind) => (onNavigate ? () => onNavigate(kind) : undefined);

  return (
    <Page title={t(l, "overview.title")}>
      <FormSection title={t(l, "overview.services")}>
        <div data-testid="health-glitchtip">
          <ListRow
            leading={<ServiceMark product="glitchtip" label="GlitchTip" decorative />}
            title={t(l, "overview.glitchtip")}
            subtitle={`${hostOf(workspace.glitchtip.baseUrl)} · ${workspace.glitchtip.organizationSlug}`}
            trailing={<StatusBadge status="ok" label={t(l, "status.connected")} />}
          />
        </div>
        <div data-testid="health-relay">
          <ListRow
            leading={<ServiceMark icon={Server} label={t(l, "overview.relay")} decorative />}
            title={t(l, "overview.relay")}
            subtitle={relay ? `${relay.user}@${relay.host}` : undefined}
            trailing={<StatusBadge status={relayStatus} label={relayText} />}
            onClick={go("relay")}
          />
        </div>
        <div data-testid="health-telegram">
          <ListRow
            leading={<ServiceMark product="telegram" label="Telegram" decorative />}
            title={t(l, "overview.telegram")}
            subtitle={telegram?.chatTitle}
            trailing={
              <StatusBadge
                status={telegram === null ? "unknown" : "ok"}
                label={t(l, telegram === null ? "status.notConfigured" : "status.connected")}
              />
            }
            onClick={go("telegram")}
          />
        </div>
        {legacy !== null ? (
          <div data-testid="health-mac-relay">
            <ListRow
              leading={<ServiceMark icon={Laptop} label={t(l, "overview.macRelay")} decorative />}
              title={t(l, "overview.macRelay")}
              subtitle={
                legacy.project === null
                  ? t(l, "overview.macRelayUnknown")
                  : t(l, "overview.macRelayProject", { project: legacy.project })
              }
              trailing={
                legacy.project === null ? (
                  <Button variant="secondary" disabled={!onTurnOffLegacy} onClick={() => setTurnOff("open")}>
                    {t(l, "overview.macRelayTurnOff")}
                  </Button>
                ) : (
                  <Button variant="secondary" disabled={!onAddApplication} onClick={onAddApplication}>
                    {t(l, "nav.addApplication")}
                  </Button>
                )
              }
            />
          </div>
        ) : null}
      </FormSection>

      <FormSection title={t(l, "overview.applications")}>
        {workspace.applications.length === 0 ? (
          <ListRow title={t(l, "overview.noApplications")} />
        ) : (
          workspace.applications.map((app) => (
            <ListRow
              key={app.id}
              leading={<span className="ui-dot" style={{ background: topicCss(app.topicColor) }} />}
              title={app.name}
              subtitle={`${app.environments.join(", ")} · ${t(l, PRESET_KEYS[app.alertPreset])}`}
              trailing={
                app.verifiedAt === null ? (
                  <StatusBadge status="unknown" label={t(l, "applications.neverVerified")} />
                ) : (
                  <StatusBadge status="ok" label={t(l, "status.verified")} />
                )
              }
              onClick={go("applications")}
            />
          ))
        )}
      </FormSection>

      <FormSection title={t(l, "overview.latestIncident")}>
        <ListRow
          title={t(l, "overview.noIncident")}
          trailing={
            <Button variant="secondary" disabled={!onPrepareBrief} onClick={onPrepareBrief}>
              {t(l, "overview.prepareBrief")}
            </Button>
          }
        />
      </FormSection>
      <Sheet
        open={turnOff !== "closed"}
        title={t(l, "overview.macRelayTurnOffTitle")}
        onClose={() => setTurnOff("closed")}
        confirm={{
          label: t(l, "overview.macRelayTurnOff"),
          destructive: true,
          pending: turnOff === "pending",
          onConfirm: () => void confirmTurnOff(),
        }}
      >
        <p>{t(l, "overview.macRelayTurnOffBody")}</p>
        {turnOff === "failed" ? (
          <InlineAlert tone="error" live>
            {t(l, "overview.macRelayTurnOffFailed")}
          </InlineAlert>
        ) : null}
      </Sheet>
    </Page>
  );
}
