import { useEffect, useState } from "react";

import { AppIcon, Button, FormSection, InlineAlert, ListRow, StatusBadge } from "../components/ui";
import { t, type Locale, type TranslationKey } from "../i18n";
import {
  importLegacyInstall as realImport,
  inspectLegacyState as realInspect,
  type LegacyInstall,
  type MigrationPreview,
} from "../app/migration";
import type { WorkspaceState } from "../app/workspace";

export type MigrationApi = {
  inspectLegacyState(): Promise<MigrationPreview>;
  importLegacyInstall(workspaceId: string, locale: Locale): Promise<WorkspaceState>;
};

const REAL_API: MigrationApi = {
  inspectLegacyState: realInspect,
  importLegacyInstall: realImport,
};

export default function MigrationScreen({
  locale = "uz",
  workspaceId,
  api = REAL_API,
  onImported,
  onStartFresh,
}: {
  locale?: Locale;
  workspaceId: string;
  api?: MigrationApi;
  /** Opens the setup assistant on the draft that carries the v1 settings. */
  onImported: (draft: WorkspaceState) => void;
  /** Leaves the old installation alone and opens the setup assistant instead. */
  onStartFresh: () => void;
}) {
  const [legacy, setLegacy] = useState<LegacyInstall | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .inspectLegacyState()
      .then((preview) => !cancelled && setLegacy(preview.kind === "legacy" ? preview.legacy : null))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function carryOver() {
    setPending(true);
    setError(null);
    try {
      onImported(await api.importLegacyInstall(workspaceId, locale));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  }

  const value = (text: string | null) =>
    text ? <span className="ui-mono">{text}</span> : <StatusBadge status="warning" label={t(locale, "migration.missing")} />;
  const secret = (present: boolean) => (
    <StatusBadge status={present ? "ok" : "warning"} label={t(locale, present ? "migration.present" : "migration.missing")} />
  );
  const rows: Array<[TranslationKey, React.ReactNode]> = legacy
    ? [
        ["setup.glitchtip.baseUrl", value(legacy.glitchtipUrl)],
        ["setup.glitchtip.org", value(legacy.organizationSlug)],
        ["setup.app.slug", value(legacy.projectSlug)],
        ["setup.glitchtip.token", secret(legacy.hasGlitchtipToken)],
        ["setup.telegram.botToken", secret(legacy.hasBotToken)],
      ]
    : [];

  return (
    <div className="ui-assistant">
      <aside className="ui-assistant__aside">
        <div className="ui-titlebar-spacer" data-tauri-drag-region />
        <div className="ui-assistant__brand">
          <AppIcon />
          <p className="ui-assistant__brand-name">{t(locale, "appName")}</p>
        </div>
      </aside>
      <main className="ui-assistant__main" aria-labelledby="migration-title">
        <div className="ui-titlebar-spacer" data-tauri-drag-region />
        <div className="ui-assistant__scroll">
          <div className="ui-assistant__content">
            <h1 id="migration-title" className="ui-assistant__title">
              {t(locale, "migration.title")}
            </h1>
            <p>{t(locale, "migration.intro")}</p>
            {error ? (
              <InlineAlert tone="error" live>
                {t(locale, "migration.failed", { error })}
              </InlineAlert>
            ) : null}
            {legacy ? (
              <FormSection title={t(locale, "migration.carried")}>
                {rows.map(([label, trailing]) => (
                  <ListRow key={label} title={t(locale, label)} trailing={trailing} />
                ))}
              </FormSection>
            ) : null}
          </div>
        </div>
        <div className="ui-assistant__footer">
          <Button variant="secondary" size="large" disabled={pending} onClick={onStartFresh}>
            {t(locale, "migration.setUpFresh")}
          </Button>
          <Button size="large" pending={pending} disabled={legacy === null} onClick={() => void carryOver()}>
            {t(locale, "migration.continue")}
          </Button>
        </div>
      </main>
    </div>
  );
}
