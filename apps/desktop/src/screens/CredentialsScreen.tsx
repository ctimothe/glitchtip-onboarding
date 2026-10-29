import { useEffect, useState } from "react";

import type { WorkspaceState } from "../app/workspace";
import { Button, FormSection, InlineAlert, ListRow, Page, ServiceMark, Sheet, StatusBadge, TextField } from "../components/ui";
import { t, type TranslationKey } from "../i18n";
import { secretPresence, secretRemove, secretSet } from "../lib/keychain";

// The Keychain items the setup assistant writes (SetupAssistant.tsx), with the
// v1 vault name a migrated workspace may still hold. SSH keys are referenced
// in place, never copied, so they are not listed. Presence only: values are
// never read, so they can never be rendered.
const CREDENTIALS: Array<{ key: string; legacy: string; name: TranslationKey; product: "glitchtip" | "telegram" }> = [
  { key: "glitchtip-token", legacy: "glitchtip.token", name: "credentials.glitchtipToken", product: "glitchtip" },
  { key: "telegram-bot-token", legacy: "telegram.botToken", name: "credentials.telegramBotToken", product: "telegram" },
];

export default function CredentialsScreen({ workspace }: { workspace: WorkspaceState }) {
  const l = workspace.locale;
  const [present, setPresent] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rotating, setRotating] = useState<(typeof CREDENTIALS)[number] | null>(null);
  const [removing, setRemoving] = useState<(typeof CREDENTIALS)[number] | null>(null);
  const [pending, setPending] = useState(false);
  const [value, setValue] = useState("");

  async function refresh() {
    try {
      setPresent(await secretPresence(workspace.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown");
    }
  }
  useEffect(() => {
    void refresh();
  }, [workspace.id]);

  async function act(action: () => Promise<void>) {
    setError(null);
    setPending(true);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown");
    }
    setPending(false);
    setRotating(null);
    setRemoving(null);
    setValue("");
  }

  return (
    <Page title={t(l, "credentials.title")}>
      {error ? (
        <InlineAlert tone="error" live>
          {t(l, "credentials.failed", { code: error })}
        </InlineAlert>
      ) : null}
      <FormSection title={t(l, "credentials.keychain")}>
        {CREDENTIALS.map((credential) => {
          const stored = present.includes(credential.key) || present.includes(credential.legacy);
          return (
            <ListRow
              key={credential.key}
              leading={<ServiceMark product={credential.product} label={t(l, credential.name)} decorative />}
              title={t(l, credential.name)}
              trailing={
                <>
                  <StatusBadge
                    status={stored ? "ok" : "warning"}
                    label={t(l, stored ? "credentials.present" : "credentials.missing")}
                  />
                  <Button variant="secondary" onClick={() => setRotating(credential)}>
                    {t(l, "credentials.rotate")}
                  </Button>
                  <Button variant="destructive" disabled={!stored} onClick={() => setRemoving(credential)}>
                    {t(l, "credentials.remove")}
                  </Button>
                </>
              }
            />
          );
        })}
      </FormSection>
      <Sheet
        open={rotating !== null}
        title={rotating ? t(l, "credentials.rotateTitle", { name: t(l, rotating.name) }) : ""}
        onClose={() => {
          setRotating(null);
          setValue("");
        }}
        confirm={{
          label: t(l, "action.save"),
          pending,
          disabled: value.length === 0,
          onConfirm: () => void act(() => secretSet(workspace.id, rotating?.key ?? "", value)),
        }}
      >
        <TextField
          label={t(l, "credentials.newValue")}
          type="password"
          autoComplete="off"
          value={value}
          onChange={setValue}
        />
      </Sheet>
      <Sheet
        open={removing !== null}
        title={t(l, "credentials.remove")}
        onClose={() => setRemoving(null)}
        confirm={{
          label: t(l, "credentials.remove"),
          destructive: true,
          pending,
          onConfirm: () =>
            void act(async () => {
              // A migrated Mac may still hold the item under its v1 name.
              for (const key of [removing?.key, removing?.legacy]) {
                if (key && present.includes(key)) await secretRemove(workspace.id, key);
              }
            }),
        }}
      >
        <p>{t(l, "credentials.confirmRemove", { key: removing ? t(l, removing.name) : "" })}</p>
      </Sheet>
    </Page>
  );
}
