import { useState } from "react";

import type { Appearance } from "../app/preferences";
import type { WorkspaceState } from "../app/workspace";
import { Button, CodeBlock, FormSection, ListRow, Page, SegmentedControl, SelectField, Sheet } from "../components/ui";
import { t } from "../i18n";
import { diagnosticsText } from "../lib/diagnostics";

// Language names are written in their own language, as in macOS.
export const LANGUAGES = [
  { value: "uz", label: "O'zbekcha" },
  { value: "ru", label: "Русский" },
  { value: "en", label: "English" },
];

export default function SettingsScreen({
  workspace,
  onWorkspaceChange,
  appearance = "system",
  onAppearanceChange,
}: {
  workspace: WorkspaceState;
  onWorkspaceChange: (next: WorkspaceState) => void;
  appearance?: Appearance;
  onAppearanceChange?: (next: Appearance) => void;
}) {
  const l = workspace.locale;
  const [report, setReport] = useState<string | null>(null);
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
      </FormSection>

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
