import { ServerOff } from "lucide-react";
import { useEffect, useState } from "react";

import type { WorkspaceState } from "../app/workspace";
import {
  Button,
  CodeBlock,
  CopyButton,
  DetailRow,
  EmptyState,
  FormSection,
  InlineAlert,
  ListRow,
  Page,
  Sheet,
  StatusBadge,
  type Status,
} from "../components/ui";
import { t } from "../i18n";
import { STATUS_LABEL, deliveryDetail, deliveryTitle, readDeliveries } from "../lib/deliveries";
import { formatRelative } from "../lib/format";
import { deployWorkspaceRelay, relayEnvState } from "../lib/relay-config";
import {
  deploymentPreview,
  relayAuditTail,
  relayStatus,
  rollbackRelay,
  rollbackTarget,
  serverRequestFor,
  type DeployRequest,
  type DeploymentPreview,
} from "../lib/remote";

type Busy = "health" | "preview" | "deploy" | "logs" | "rollback" | null;

export default function RelayServerScreen({
  workspace,
  onWorkspaceUpdate,
}: {
  workspace: WorkspaceState;
  /** Applied to the workspace as it is when a check, deploy or rollback finishes. */
  onWorkspaceUpdate?: (update: (current: WorkspaceState) => WorkspaceState) => void;
}) {
  const l = workspace.locale;
  const relay = workspace.relay;
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [preview, setPreview] = useState<DeploymentPreview | null>(null);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether the relay runs with the current language, applications and tokens.
  const [settings, setSettings] = useState<"current" | "outdated" | "unknown">("unknown");
  useEffect(() => {
    let live = true;
    relayEnvState(workspace)
      .then((state) => live && setSettings(state))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspace]);

  if (relay === null) {
    return (
      <Page title={t(l, "relay.title")}>
        <EmptyState icon={ServerOff} title={t(l, "relay.notDeployed")} />
      </Page>
    );
  }
  const current = relay;
  const request = serverRequestFor(current);
  const deployRequest: DeployRequest = {
    ...request,
    workspaceId: workspace.id,
    applicationIds: workspace.applications.map((application) => application.id),
  };

  function updateRelay(patch: Partial<NonNullable<WorkspaceState["relay"]>>) {
    onWorkspaceUpdate?.((latest) => (latest.relay === null ? latest : { ...latest, relay: { ...latest.relay, ...patch } }));
  }

  async function run(kind: Exclude<Busy, null>, action: () => Promise<void>) {
    setError(null);
    setBusy(kind);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown");
    } finally {
      setBusy(null);
    }
  }

  const health: Status =
    reachable === false ? "error" : current.status === "healthy" ? "ok" : current.status === "degraded" ? "warning" : "unknown";
  const healthText = t(
    l,
    reachable === false
      ? "status.unreachable"
      : current.status === "healthy"
        ? "status.ok"
        : current.status === "degraded"
          ? "status.warning"
          : "status.unknown",
  );

  return (
    <Page
      title={t(l, "relay.title")}
      actions={
        <Button
          variant="secondary"
          pending={busy === "health"}
          disabled={busy !== null && busy !== "health"}
          onClick={() =>
            void run("health", async () => {
              const status = await relayStatus(request);
              setReachable(status.reachable);
              updateRelay(
                status.reachable && status.healthy
                  ? { status: "healthy", verifiedAt: new Date().toISOString() }
                  : { status: "degraded" },
              );
            })
          }
        >
          {t(l, "relay.checkHealth")}
        </Button>
      }
    >
      {error ? (
        <InlineAlert tone="error" live>
          {t(l, "relay.failed", { detail: error })}
        </InlineAlert>
      ) : null}

      <FormSection title={t(l, "relay.deployment")}>
        <DetailRow label={t(l, "relay.healthLabel")}>
          <StatusBadge status={health} label={healthText} />
        </DetailRow>
        <DetailRow label={t(l, "relay.targetLabel")} mono>{`${current.user}@${current.host}:${current.port}`}</DetailRow>
        <DetailRow label={t(l, "relay.directoryLabel")} mono>
          {current.deploymentDir}
        </DetailRow>
        <DetailRow label={t(l, "relay.networkLabel")} mono>
          {current.dockerNetwork}
        </DetailRow>
        <DetailRow label={t(l, "relay.revisionLabel")} mono>
          {current.revision}
          <CopyButton text={current.revision} label={t(l, "relay.copyRevision")} />
        </DetailRow>
        {settings === "unknown" ? null : (
          <DetailRow label={t(l, "relay.settingsLabel")}>
            <StatusBadge
              status={settings === "current" ? "ok" : "warning"}
              label={t(l, settings === "current" ? "relay.settingsCurrent" : "relay.settingsOutdated")}
            />
          </DetailRow>
        )}
        <DetailRow label={t(l, "relay.lastVerified")}>
          {current.verifiedAt === null ? t(l, "applications.neverVerified") : formatRelative(current.verifiedAt, l)}
        </DetailRow>
      </FormSection>

      <FormSection title={t(l, "relay.maintenance")}>
        <ListRow
          title={t(l, "relay.logsTitle")}
          trailing={
            <Button
              variant="secondary"
              pending={busy === "logs"}
              disabled={busy !== null && busy !== "logs"}
              onClick={() =>
                void run("logs", async () => {
                  const rows = await relayAuditTail({ ...request, lines: 50 });
                  setLogs(
                    readDeliveries(rows).map(
                      (delivery) => `${deliveryDetail(delivery, l)}  ${deliveryTitle(delivery, workspace)} · ${t(l, STATUS_LABEL[delivery.status])}`,
                    ),
                  );
                })
              }
            >
              {t(l, "relay.logs")}
            </Button>
          }
        />
        <ListRow
          title={t(l, "relay.updateTitle")}
          trailing={
            <Button
              variant={settings === "outdated" ? "primary" : "secondary"}
              pending={busy === "preview"}
              disabled={busy !== null && busy !== "preview"}
              onClick={() => void run("preview", async () => setPreview(await deploymentPreview(deployRequest)))}
            >
              {t(l, "relay.preview")}
            </Button>
          }
        />
        <ListRow
          title={t(l, "relay.rollbackTitle")}
          subtitle={
            current.previousRevision === null
              ? t(l, "relay.noPrevious")
              : t(l, "relay.previousRevision", { revision: current.previousRevision })
          }
          trailing={
            <Button
              variant="destructive"
              disabled={current.previousRevision === null || busy !== null}
              onClick={() => setConfirmRollback(true)}
            >
              {t(l, "relay.rollback")}
            </Button>
          }
        />
      </FormSection>

      <Sheet open={logs !== null} title={t(l, "relay.logsTitle")} onClose={() => setLogs(null)} wide>
        {logs !== null && logs.length > 0 ? (
          <CodeBlock lines={logs} label={t(l, "relay.logsTitle")} />
        ) : (
          <p>{t(l, "relay.logsEmpty")}</p>
        )}
      </Sheet>

      <Sheet
        open={preview !== null}
        title={t(l, "relay.previewTitle")}
        onClose={() => setPreview(null)}
        wide
        confirm={{
          label: t(l, "relay.deployUpdate"),
          pending: busy === "deploy",
          onConfirm: () =>
            void run("deploy", async () => {
              // The sheet closes either way, so a failure shows in the page alert.
              try {
                // The environment is rebuilt too, so the relay picks up the current locale and applications.
                const result = await deployWorkspaceRelay(workspace, request);
                if (!result.ok) throw new Error(result.failedStep ?? "deploy-failed");
                updateRelay({
                  revision: result.revision,
                  previousRevision: rollbackTarget(current, result),
                  status: "healthy",
                  verifiedAt: new Date().toISOString(),
                });
              } finally {
                setPreview(null);
              }
            }),
        }}
      >
        {preview ? (
          <div className="flex flex-col gap-[var(--space-3)]">
            <p>{t(l, "setup.server.revision", { revision: preview.revision })}</p>
            <CodeBlock
              label={t(l, "setup.server.files")}
              lines={preview.files.map((file) => `${file.mode}  ${file.path}`)}
            />
            <CodeBlock label={t(l, "setup.server.commands")} lines={preview.commands} />
          </div>
        ) : null}
      </Sheet>

      <Sheet
        open={confirmRollback}
        title={t(l, "relay.rollbackConfirmTitle")}
        onClose={() => setConfirmRollback(false)}
        confirm={{
          label: t(l, "relay.rollback"),
          destructive: true,
          pending: busy === "rollback",
          onConfirm: () =>
            void run("rollback", async () => {
              try {
                const result = await rollbackRelay({ ...request, toRevision: current.previousRevision ?? "" });
                if (!result.ok) throw new Error(result.failedStep ?? "rollback-failed");
                updateRelay({ revision: result.revision, previousRevision: result.previousRevision });
              } finally {
                setConfirmRollback(false);
              }
            }),
        }}
      >
        <p>
          {t(l, "relay.rollbackConfirmBody", {
            host: current.host,
            revision: current.previousRevision ?? "",
          })}
        </p>
      </Sheet>
    </Page>
  );
}
