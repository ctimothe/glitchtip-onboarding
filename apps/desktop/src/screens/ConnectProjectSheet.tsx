// Connects an application straight to the inbox, without Telegram: the GlitchTip project is
// created (or reused) on the primary server with a key and no alert rule, and its DSN is shown
// for the application to report to. The DSN is shown, never stored.

import { useState } from "react";

import type { WorkspaceState } from "../app/workspace";
import { CodeBlock, CopyButton, InlineAlert, Sheet, TextField } from "../components/ui";
import { t } from "../i18n";
import { projectDsn, provisionInventory } from "../lib/glitchtip";
import * as secrets from "../lib/secrets";

/** A GlitchTip project slug from a display name: lowercase words joined by hyphens. */
export function projectSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export default function ConnectProjectSheet({
  workspace,
  open,
  onClose,
}: {
  workspace: WorkspaceState;
  open: boolean;
  onClose: () => void;
}) {
  const l = workspace.locale;
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dsn, setDsn] = useState<string | null>(null);
  const slug = projectSlug(name);

  function close() {
    setName("");
    setError(null);
    setDsn(null);
    onClose();
  }

  async function connect() {
    setPending(true);
    setError(null);
    try {
      const { baseUrl, organizationSlug: org } = workspace.glitchtip;
      const token = await secrets.get(workspace.id, "glitchtip-token");
      if (!token) throw new Error("token-missing");
      const steps = await provisionInventory(baseUrl, token, org, {
        team: org,
        project: slug,
        projectName: name.trim(),
      });
      const failed = steps.find((step) => step.status === "failed");
      if (failed) throw new Error(failed.evidence);
      setDsn(await projectDsn(baseUrl, token, org, slug));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  const line = dsn === null ? "" : `GLITCHTIP_DSN=${dsn}`;
  return (
    <Sheet
      open={open}
      title={t(l, "connect.title")}
      onClose={close}
      wide={dsn !== null}
      confirm={
        dsn === null
          ? { label: t(l, "connect.confirm"), pending, disabled: slug === "", onConfirm: () => void connect() }
          : { label: t(l, "connect.done"), onConfirm: close }
      }
    >
      {error ? (
        <InlineAlert tone="error" live>
          {t(l, "connect.failed", { detail: error })}
        </InlineAlert>
      ) : null}
      {dsn === null ? (
        <TextField
          label={t(l, "connect.name")}
          value={name}
          onChange={setName}
          description={slug ? t(l, "connect.slug", { slug }) : undefined}
        />
      ) : (
        <>
          <CodeBlock lines={[line]} label={t(l, "connect.dsn")} />
          <CopyButton text={line} label={t(l, "connect.copyDsn")} />
        </>
      )}
    </Sheet>
  );
}
