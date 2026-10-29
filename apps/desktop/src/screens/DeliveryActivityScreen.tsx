import { Activity, RotateCw, ServerOff } from "lucide-react";
import { useState } from "react";

import type { OperationsKind } from "../App";
import type { WorkspaceState } from "../app/workspace";
import { Button, EmptyState, FormSection, InlineAlert, ListRow, Page, StatusBadge, type Status } from "../components/ui";
import { t } from "../i18n";
import {
  STATUS_LABEL,
  deliveryDetail,
  deliveryTitle,
  readDeliveries,
  type Delivery,
  type DeliveryFailure,
  type DeliveryStatus,
} from "../lib/deliveries";
import { relayAuditTail, serverRequestFor } from "../lib/remote";

// Where a failed send is fixed; a passing outage has nowhere to go, the relay retries it.
const FIX_ROUTE: Record<DeliveryFailure, { kind: OperationsKind; label: "nav.relay" | "nav.telegram" | "nav.credentials" } | null> = {
  "bot-token": { kind: "credentials", label: "nav.credentials" },
  telegram: { kind: "telegram", label: "nav.telegram" },
  temporary: null,
  relay: { kind: "relay", label: "nav.relay" },
};

const BADGE: Record<DeliveryStatus, Status> = { delivered: "ok", retrying: "warning", "prompt-sent": "ok" };

// Only these fields are ever rendered; the relay never stores an alert's payload.
export function DeliveryEvents({
  workspace,
  deliveries,
  onNavigate,
}: {
  workspace: WorkspaceState;
  deliveries: Delivery[];
  onNavigate?: (kind: OperationsKind) => void;
}) {
  const l = workspace.locale;
  return (
    <FormSection title={t(l, "delivery.recent")} footer={t(l, "delivery.noRaw")}>
      {deliveries.map((delivery, index) => {
        const fix = delivery.failure === null ? null : FIX_ROUTE[delivery.failure];
        return (
          <ListRow
            key={index}
            title={deliveryTitle(delivery, workspace)}
            subtitle={deliveryDetail(delivery, l)}
            trailing={
              fix && onNavigate ? (
                <Button variant="quiet" onClick={() => onNavigate(fix.kind)}>
                  {t(l, "delivery.fixIn", { route: t(l, fix.label) })}
                </Button>
              ) : (
                <StatusBadge status={BADGE[delivery.status]} label={t(l, STATUS_LABEL[delivery.status])} />
              )
            }
          />
        );
      })}
    </FormSection>
  );
}

export default function DeliveryActivityScreen({
  workspace,
  onNavigate,
}: {
  workspace: WorkspaceState;
  onNavigate?: (kind: OperationsKind) => void;
}) {
  const l = workspace.locale;
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const relay = workspace.relay;

  async function load() {
    if (relay === null) return;
    setError(null);
    setLoading(true);
    try {
      setDeliveries(readDeliveries(await relayAuditTail({ ...serverRequestFor(relay), lines: 100 })));
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown");
    } finally {
      setLoading(false);
    }
  }

  const refresh =
    relay !== null && deliveries !== null ? (
      <Button
        variant="toolbar"
        icon={RotateCw}
        pending={loading}
        aria-label={t(l, "delivery.refresh")}
        title={t(l, "delivery.refresh")}
        onClick={() => void load()}
      />
    ) : null;

  return (
    <Page title={t(l, "delivery.title")} actions={refresh}>
      {error ? (
        <InlineAlert tone="error" live>
          {t(l, "delivery.failed", { detail: error })}
        </InlineAlert>
      ) : null}
      {relay === null ? (
        <EmptyState icon={ServerOff} title={t(l, "relay.notDeployed")} />
      ) : deliveries === null ? (
        <EmptyState
          icon={Activity}
          title={t(l, "delivery.recent")}
          action={
            <Button variant="secondary" pending={loading} onClick={() => void load()}>
              {t(l, "delivery.load")}
            </Button>
          }
        />
      ) : deliveries.length === 0 ? (
        <EmptyState icon={Activity} title={t(l, "delivery.empty")} />
      ) : (
        <DeliveryEvents workspace={workspace} deliveries={deliveries} onNavigate={onNavigate} />
      )}
    </Page>
  );
}
