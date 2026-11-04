import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useEffect, useState } from "react";

import type { Appearance } from "../app/preferences";
import { sourceTokenKey, type GlitchTipSource, type WorkspaceState } from "../app/workspace";
import {
  Button,
  CodeBlock,
  FormSection,
  InlineAlert,
  ListRow,
  Page,
  SegmentedControl,
  SelectField,
  Sheet,
  TextField,
} from "../components/ui";
import { t } from "../i18n";
import { diagnosticsText } from "../lib/diagnostics";
import { hostOf } from "../lib/format";
import { checkInstance, listIssues } from "../lib/glitchtip";
import * as secrets from "../lib/secrets";

// Language names are written in their own language, as in macOS.
export const LANGUAGES = [
  { value: "uz", label: "O'zbekcha" },
  { value: "ru", label: "Русский" },
  { value: "en", label: "English" },
];

/** A Keychain-safe id for a new server, from its host, unique in the workspace. */
export function newSourceId(baseUrl: string, taken: string[]): string {
  const stem = hostOf(baseUrl).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "server";
  let id = stem === "primary" ? "primary-1" : stem;
  for (let n = 2; taken.includes(id); n += 1) id = `${stem}-${n}`;
  return id;
}

export default function SettingsScreen({
  workspace,
  onWorkspaceChange,
  appearance = "system",
  onAppearanceChange,
  onSetUpTelegram,
}: {
  workspace: WorkspaceState;
  onWorkspaceChange: (next: WorkspaceState) => void;
  appearance?: Appearance;
  onAppearanceChange?: (next: Appearance) => void;
  /** Shown while no relay or Telegram chat exists: re-enters setup at the relay stage. */
  onSetUpTelegram?: () => void;
}) {
  const l = workspace.locale;
  const [report, setReport] = useState<string | null>(null);
  const [atLogin, setAtLogin] = useState<boolean | null>(null);
  useEffect(() => {
    isEnabled().then(setAtLogin, () => setAtLogin(null));
  }, []);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ baseUrl: "", org: "", token: "" });
  const [checking, setChecking] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  function closeAdd() {
    setAdding(false);
    setDraft({ baseUrl: "", org: "", token: "" });
    setAddError(null);
  }

  async function addServer() {
    const baseUrl = draft.baseUrl.trim().replace(/\/+$/, "");
    const org = draft.org.trim();
    const known = [workspace.glitchtip, ...workspace.sources].some(
      (s) => s.baseUrl.replace(/\/+$/, "").toLowerCase() === baseUrl.toLowerCase() && s.organizationSlug === org,
    );
    if (known) {
      setAddError(t(l, "settings.serverExists"));
      return;
    }
    if (!baseUrl.startsWith("https://")) {
      setAddError(t(l, "settings.httpsOnly"));
      return;
    }
    setChecking(true);
    setAddError(null);
    try {
      try {
        await checkInstance(baseUrl);
      } catch {
        setAddError(t(l, "setup.glitchtip.notGlitchtip"));
        return;
      }
      // Reading the issue list proves the token and the organization together.
      await listIssues(baseUrl, draft.token, org);
      const id = newSourceId(baseUrl, workspace.sources.map((s) => s.id));
      await secrets.set(workspace.id, sourceTokenKey(id), draft.token);
      const source: GlitchTipSource = {
        id,
        name: hostOf(baseUrl),
        baseUrl,
        organizationSlug: org,
        verifiedAt: new Date().toISOString(),
      };
      onWorkspaceChange({ ...workspace, sources: [...workspace.sources, source] });
      closeAdd();
    } catch (err) {
      setAddError(t(l, "settings.serverFailed", { detail: err instanceof Error ? err.message : String(err) }));
    } finally {
      setChecking(false);
    }
  }

  function removeServer(source: GlitchTipSource) {
    onWorkspaceChange({ ...workspace, sources: workspace.sources.filter((s) => s.id !== source.id) });
    void secrets.remove(workspace.id, sourceTokenKey(source.id)).catch(() => undefined);
  }

  async function changeAtLogin(on: boolean) {
    try {
      await (on ? enable() : disable());
      setAtLogin(await isEnabled());
    } catch {
      setAtLogin(null);
    }
  }

  const telegramOff = workspace.telegram === null && workspace.applications.length === 0;
  return (
    <Page title={t(l, "settings.title")}>
      <FormSection title={t(l, "settings.general")}>
        <SelectField
          label={t(l, "settings.locale")}
          value={workspace.locale}
          onChange={(value) => onWorkspaceChange({ ...workspace, locale: value as WorkspaceState["locale"] })}
          options={LANGUAGES}
          description={workspace.relay !== null ? t(l, "settings.localeRelay") : undefined}
        />
        <SegmentedControl<Appearance>
          label={t(l, "settings.appearance")}
          value={appearance}
          onChange={(value) => onAppearanceChange?.(value)}
          options={[
            { value: "light", label: t(l, "settings.appearanceLight") },
            { value: "dark", label: t(l, "settings.appearanceDark") },
            { value: "system", label: t(l, "settings.appearanceSystem") },
          ]}
        />
        {atLogin !== null ? (
          <SegmentedControl<"on" | "off">
            label={t(l, "settings.openAtLogin")}
            value={atLogin ? "on" : "off"}
            onChange={(value) => void changeAtLogin(value === "on")}
            options={[
              { value: "on", label: t(l, "settings.on") },
              { value: "off", label: t(l, "settings.off") },
            ]}
          />
        ) : null}
      </FormSection>

      <FormSection
        title={t(l, "settings.servers")}
        actions={
          <Button variant="quiet" onClick={() => setAdding(true)}>
            {t(l, "settings.addServer")}
          </Button>
        }
      >
        <ListRow title={hostOf(workspace.glitchtip.baseUrl)} subtitle={workspace.glitchtip.organizationSlug} />
        {workspace.sources.map((source) => (
          <ListRow
            key={source.id}
            title={source.name}
            subtitle={source.organizationSlug}
            trailing={
              <Button variant="quiet" onClick={() => removeServer(source)}>
                {t(l, "settings.removeServer")}
              </Button>
            }
          />
        ))}
      </FormSection>

      {telegramOff && onSetUpTelegram ? (
        <FormSection>
          <ListRow
            title={t(l, "settings.telegram")}
            trailing={
              <Button variant="secondary" onClick={onSetUpTelegram}>
                {t(l, "settings.setUpTelegram")}
              </Button>
            }
          />
        </FormSection>
      ) : null}

      <Sheet
        open={adding}
        title={t(l, "settings.addServerTitle")}
        onClose={closeAdd}
        confirm={{
          label: t(l, "settings.addServerConfirm"),
          pending: checking,
          disabled: !draft.baseUrl.trim() || !draft.org.trim() || !draft.token,
          onConfirm: () => void addServer(),
        }}
      >
        {addError ? (
          <InlineAlert tone="error" live>
            {addError}
          </InlineAlert>
        ) : null}
        <TextField
          label={t(l, "setup.glitchtip.baseUrl")}
          type="url"
          value={draft.baseUrl}
          onChange={(baseUrl) => setDraft((d) => ({ ...d, baseUrl }))}
          placeholder="https://"
          mono
        />
        <TextField
          label={t(l, "setup.glitchtip.org")}
          value={draft.org}
          onChange={(org) => setDraft((d) => ({ ...d, org }))}
          mono
        />
        <TextField
          label={t(l, "setup.glitchtip.token")}
          type="password"
          autoComplete="off"
          value={draft.token}
          onChange={(token) => setDraft((d) => ({ ...d, token }))}
          description={t(l, "setup.glitchtip.tokenHelp")}
        />
      </Sheet>

      <FormSection title={t(l, "settings.diagnostics")} footer={t(l, "settings.redactionNote")}>
        <ListRow
          title={t(l, "settings.report")}
          trailing={
            <Button variant="secondary" onClick={() => setReport(diagnosticsText(workspace))}>
              {t(l, "settings.exportDiagnostics")}
            </Button>
          }
        />
      </FormSection>

      <Sheet
        open={report !== null}
        title={t(l, "settings.redactionPreview")}
        onClose={() => setReport(null)}
        wide
        confirm={{
          label: t(l, "settings.copyReport"),
          onConfirm: () => {
            const text = report ?? "";
            setReport(null);
            void navigator.clipboard?.writeText(text).catch(() => undefined);
          },
        }}
      >
        {report !== null ? <CodeBlock lines={report.split("\n")} label={t(l, "settings.report")} /> : null}
      </Sheet>
    </Page>
  );
}
