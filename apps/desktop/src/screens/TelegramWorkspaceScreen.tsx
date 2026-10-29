import { MessageSquareOff } from "lucide-react";
import { useState } from "react";

import type { WorkspaceState } from "../app/workspace";
import { Button, DetailRow, EmptyState, FormSection, InlineAlert, ListRow, Page, StatusBadge } from "../components/ui";
import { t } from "../i18n";
import { formatRelative } from "../lib/format";
import { relayControl, serverRequestFor } from "../lib/remote";
import { topicCss } from "../lib/topic-colors";

type Send = { applicationId: string; state: "sending" | "sent" } | null;

export default function TelegramWorkspaceScreen({ workspace }: { workspace: WorkspaceState }) {
  const l = workspace.locale;
  const tg = workspace.telegram;
  const relay = workspace.relay;
  const [send, setSend] = useState<Send>(null);
  const [error, setError] = useState<string | null>(null);

  if (tg === null) {
    return (
      <Page title={t(l, "telegram.title")}>
        <EmptyState icon={MessageSquareOff} title={t(l, "telegram.notPaired")} />
      </Page>
    );
  }

  async function sendTest(applicationId: string) {
    if (relay === null) return;
    const request = serverRequestFor(relay);
    setError(null);
    setSend({ applicationId, state: "sending" });
    try {
      await relayControl(request, { kind: "send-test", applicationId });
      setSend({ applicationId, state: "sent" });
    } catch (err) {
      setSend(null);
      setError(err instanceof Error ? err.message : "unknown");
    }
  }

  return (
    <Page title={t(l, "telegram.title")}>
      <FormSection title={t(l, "telegram.workspace")}>
        <DetailRow label={t(l, "telegram.botLabel")} mono>
          {tg.botUsername ? `@${tg.botUsername}` : String(tg.botId)}
        </DetailRow>
        <DetailRow label={t(l, "telegram.forumLabel")}>{tg.chatTitle}</DetailRow>
        <DetailRow label={t(l, "telegram.allowlistLabel")}>{String(tg.allowedMemberIds.length)}</DetailRow>
        <DetailRow label={t(l, "telegram.pairedLabel")}>{formatRelative(tg.pairedAt, l)}</DetailRow>
      </FormSection>

      {error ? (
        <InlineAlert tone="error" live>
          {t(l, "telegram.testFailed", { detail: error })}
        </InlineAlert>
      ) : null}

      <FormSection title={t(l, "telegram.topicsLabel")}>
        {workspace.applications.length === 0 ? (
          <ListRow title={t(l, "overview.noApplications")} />
        ) : (
          workspace.applications.map((app) => {
            const mine = send?.applicationId === app.id ? send.state : null;
            return (
              <ListRow
                key={app.id}
                leading={<span className="ui-dot" style={{ background: topicCss(app.topicColor) }} />}
                title={app.name}
                subtitle={t(l, "applications.topic", { id: app.topicId })}
                trailing={
                  <>
                    {mine === "sent" ? <StatusBadge status="ok" label={t(l, "telegram.testSent")} /> : null}
                    <Button
                      variant="secondary"
                      pending={mine === "sending"}
                      disabled={relay === null || (send?.state === "sending" && mine === null)}
                      onClick={() => void sendTest(app.id)}
                    >
                      {t(l, "telegram.testDelivery")}
                    </Button>
                  </>
                }
              />
            );
          })
        )}
      </FormSection>
    </Page>
  );
}
