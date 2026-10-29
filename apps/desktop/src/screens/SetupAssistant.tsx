import { CheckCircle2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import { createdTopic, forgetCreatedTopics, rememberTopic } from "../app/created-topics";
import type { WorkspaceState } from "../app/workspace";
import { t, type TranslationKey } from "../i18n";
import { agentInstall, agentInstallPreview, agentVerify, type AgentInstallPreview, type AgentProvider } from "../lib/agent";
import {
  AppIcon,
  BlockRow,
  Button,
  CodeBlock,
  CopyButton,
  EmptyState,
  FormSection,
  InlineAlert,
  ListRow,
  Page,
  SegmentedControl,
  SelectField,
  Sheet,
  StatusBadge,
  Steps,
  SwatchPicker,
  TextField,
  type Status,
} from "../components/ui";
import { FAILURE_LABEL, waitForDelivery, type DeliveryFailure } from "../lib/deliveries";
import { checkInstance, fetchInventory, provisionInventory } from "../lib/glitchtip";
import { createPairingCode, waitForPairing, type PairingCode } from "../lib/pairing";
import { deployWorkspaceRelay } from "../lib/relay-config";
import {
  deploymentPreview,
  relayAuditTail,
  relayControl,
  serverPreflight,
  type DeploymentPreview,
  type ServerRequest,
} from "../lib/remote";
import * as secrets from "../lib/secrets";
import {
  ALERT_RULE_CONTRACT,
  SetupError,
  runStage,
  type ApplicationInput,
  type SetupDeps,
  type SetupInput,
  type SetupStageNumber,
} from "../lib/setup-machine";
import { validateBotToken } from "../lib/telegram";
import { TOPIC_COLORS, topicCss } from "../lib/topic-colors";
import { LANGUAGES } from "./SettingsScreen";

const STAGE_KEYS: Record<SetupStageNumber, TranslationKey> = {
  1: "setup.stage.glitchtip",
  2: "setup.stage.server",
  3: "setup.stage.telegram",
  4: "setup.stage.application",
  5: "setup.stage.agent",
  6: "setup.stage.verify",
};
const STAGES: SetupStageNumber[] = [1, 2, 3, 4, 5, 6];

const PROVIDERS: Array<{ value: AgentProvider; label: TranslationKey }> = [
  { value: "codex", label: "agent.codex" },
  { value: "claude", label: "agent.claude" },
  { value: "other", label: "agent.other" },
];

const FILE_ACTIONS: Record<AgentInstallPreview["files"][number]["action"], TranslationKey> = {
  create: "setup.agent.action.create",
  update: "setup.agent.action.update",
  unchanged: "setup.agent.action.unchanged",
};

// The stage-6 proofs in the order runStage checks them; a failure names the first one that failed.
const CHECKS: Array<{ key: string; label: TranslationKey }> = [
  { key: "syntheticEvent", label: "setup.verify.synthetic" },
  { key: "telegramDelivery", label: "setup.verify.telegram" },
  { key: "agentContext", label: "setup.verify.agent" },
  { key: "alertRule", label: "setup.verify.alert" },
];

type Failure = { stage: SetupStageNumber; message: string; field: boolean; detail: string | null };
// Failure details that name a form field; anything else is a section error.
const FIELD_DETAILS = new Set(["address", "token", "botToken"]);
type Primary = { label: string; disabled?: boolean; run: () => void };

// The server checks a failed pre-flight names (PREFLIGHT_SCRIPT in
// src-tauri/src/remote.rs); "architecture" only reports and never fails.
const PREFLIGHT_CHECKS: Record<string, TranslationKey> = {
  "host-key": "setup.preflight.hostKey",
  linux: "setup.preflight.linux",
  docker: "setup.preflight.docker",
  compose: "setup.preflight.compose",
  daemon: "setup.preflight.daemon",
  disk: "setup.preflight.disk",
  network: "setup.server.network",
  "glitchtip-network": "setup.preflight.glitchtipNetwork",
  "deployment-dir": "setup.server.dir",
};

// A check that throws (relay unreachable, say) is reported as that check, so
// its row shows the failure rather than every row reading "Not run".
function check<T>(key: string, run: () => Promise<T>): Promise<T> {
  return run().catch(() => {
    throw new SetupError("verify-failed", key);
  });
}

function errorMessage(locale: WorkspaceState["locale"], err: unknown): string {
  // The helper launcher would point at a copy of the app macOS removes once it quits.
  if (err instanceof Error && (err.message === "app-translocated" || (err instanceof SetupError && err.detail === "app-translocated"))) {
    return t(locale, "setup.error.appTranslocated");
  }
  if (err instanceof SetupError && err.code === "pairing-failed" && err.detail === "expired") {
    return t(locale, "setup.telegram.expired");
  }
  // GlitchTip refuses webhooks to the relay's private address: found by the server checks, or
  // when GlitchTip turns the alert rule down.
  if (
    err instanceof SetupError &&
    ((err.code === "preflight-failed" && (err.detail ?? "").split(",").includes("glitchtip-webhooks")) ||
      (err.code === "alert-failed" && err.detail === "private-webhooks") ||
      (err.code === "verify-failed" && err.detail === "alertRule" && err.reason === "private-webhooks"))
  ) {
    return t(locale, "setup.error.privateWebhooks");
  }
  // Why Telegram did not take the test message, as the relay's audit says.
  if (err instanceof SetupError && err.detail === "telegramDelivery" && err.reason !== null && err.reason in FAILURE_LABEL) {
    return t(locale, FAILURE_LABEL[err.reason as DeliveryFailure]);
  }
  if (err instanceof SetupError && err.code === "preflight-failed") {
    const checks = (err.detail ?? "").split(",").flatMap((id) => (PREFLIGHT_CHECKS[id] ? [t(locale, PREFLIGHT_CHECKS[id])] : []));
    if (checks.length > 0) return t(locale, "setup.error.preflight-checks", { checks: checks.join(", ") });
  }
  if (err instanceof SetupError) return t(locale, `setup.error.${err.code}` as TranslationKey);
  return t(locale, "setup.error.generic");
}

export function SetupAssistant(props: {
  workspace: WorkspaceState;
  /** Resolves once the workspace is saved; a stage counts as done only then. */
  onWorkspaceChange: (next: WorkspaceState) => Promise<void> | void;
  mode?: "onboarding" | "add-application";
  /** A project to offer for the application, such as the one a v1 install delivered. */
  suggestedProject?: string | null;
  /** Add-application mode: leave the assistant once the new application is verified. */
  onFinish?: () => void;
}) {
  const adding = props.mode === "add-application";
  const originalOnboarding = useRef(props.workspace.onboarding);
  // The machine refuses a completed workspace; adding an application re-enters
  // it at stage 4 and restores the original onboarding block afterwards.
  const [ws, setWs] = useState<WorkspaceState>(() =>
    adding
      ? { ...props.workspace, onboarding: { completedAt: null, currentStage: 4 } }
      : props.workspace,
  );
  const locale = ws.locale;
  const tr = (key: TranslationKey, values?: Record<string, string | number>) => t(locale, key, values);
  const stage = ws.onboarding.currentStage;

  const [baseUrl, setBaseUrl] = useState(ws.glitchtip.baseUrl);
  const [org, setOrg] = useState(ws.glitchtip.organizationSlug);
  const [token, setToken] = useState("");
  const [server, setServer] = useState({
    host: ws.relay?.host ?? "",
    user: ws.relay?.user ?? "root",
    port: String(ws.relay?.port ?? 22),
    identityFile: ws.relay?.identityFile ?? "",
    dockerNetwork: ws.relay?.dockerNetwork ?? "glitchtip_default",
    // The only place the relay installs: Rust refuses any directory outside it.
    deploymentDir: ws.relay?.deploymentDir ?? "$HOME/.local/share/glitchtip-companion",
  });
  const [preview, setPreview] = useState<DeploymentPreview | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [botDone, setBotDone] = useState(false);
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [app, setApp] = useState({ slug: "", name: "", envs: "production", topic: "", color: String(TOPIC_COLORS[0].value) });
  const { suggestedProject } = props;
  useEffect(() => {
    if (suggestedProject) setApp((current) => (current.slug === "" ? { ...current, slug: suggestedProject } : current));
  }, [suggestedProject]);
  const [repo, setRepo] = useState("");
  const [provider, setProvider] = useState<AgentProvider>("codex");
  const [agentPreview, setAgentPreview] = useState<AgentInstallPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const titleId = useId();

  // Tokens already in the Keychain (a v1 install carried over, or setup resumed after a restart)
  // are used when their field is left empty. Only their presence is kept here.
  const [saved, setSaved] = useState({ glitchtip: false, bot: false });
  useEffect(() => {
    let live = true;
    Promise.all([secrets.get(ws.id, "glitchtip-token"), secrets.get(ws.id, "telegram-bot-token")])
      .then(([glitchtip, bot]) => live && setSaved({ glitchtip: Boolean(glitchtip), bot: Boolean(bot) }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ws.id]);

  const serverRequest = useMemo<ServerRequest>(
    () => ({
      host: server.host.trim(),
      user: server.user.trim(),
      port: Number(server.port),
      identityFile: server.identityFile.trim(),
      dockerNetwork: server.dockerNetwork.trim(),
      deploymentDir: server.deploymentDir.trim(),
    }),
    [server],
  );

  const environments = [...new Set(app.envs.split(",").map((e) => e.trim()).filter(Boolean))];
  const lastApp = ws.applications[ws.applications.length - 1];
  const applicationInput: ApplicationInput | undefined = app.slug.trim()
    ? {
        id: app.slug.trim(),
        projectSlug: app.slug.trim(),
        projectName: app.name.trim() || app.slug.trim(),
        environments,
        topicName: app.topic.trim() || app.name.trim() || app.slug.trim(),
        topicColor: Number(app.color),
      }
    : lastApp
      ? {
          id: lastApp.id,
          projectSlug: lastApp.projectSlug,
          projectName: lastApp.name,
          environments: lastApp.environments,
          topicName: lastApp.name,
          topicColor: lastApp.topicColor,
        }
      : undefined;

  // The application's GlitchTip alert rule, created to send to the relay. An existing rule that
  // sends elsewhere is switched only when `switchExisting`, once delivery is proven.
  async function alertRule(project: string, projectName: string, switchExisting: boolean): Promise<void> {
    const stored = await secrets.get(ws.id, "glitchtip-token");
    if (!stored) throw new Error("missing-token");
    const steps = await provisionInventory(ws.glitchtip.baseUrl, stored, ws.glitchtip.organizationSlug, {
      team: ws.glitchtip.organizationSlug,
      project,
      projectName,
      webhookUrl: ALERT_RULE_CONTRACT.webhookRecipient,
      quantity: ALERT_RULE_CONTRACT.threshold.events,
      timespanMinutes: ALERT_RULE_CONTRACT.threshold.windowMinutes,
      switchExisting,
    });
    const failed = steps.find((s) => s.status === "failed");
    if (failed) throw new Error(failed.reason ?? "alert-step-failed");
  }

  const deps: SetupDeps = {
    glitchtip: {
      // A failure names the field at fault: the address when no GlitchTip
      // schema answers there, the token when the organization lookup is
      // refused. Anything else stays a section error.
      async verify() {
        await checkInstance(baseUrl).catch(() => {
          throw new SetupError("glitchtip-failed", "address");
        });
        const value = token || (await secrets.get(ws.id, "glitchtip-token")) || "";
        await fetchInventory(baseUrl, value, org.trim()).catch((err: unknown) => {
          if (err instanceof Error && /HTTP 40[13]$/.test(err.message)) throw new SetupError("glitchtip-failed", "token");
          throw err;
        });
        if (token) await secrets.set(ws.id, "glitchtip-token", token);
        return { baseUrl: baseUrl.trim(), organizationSlug: org.trim() };
      },
    },
    server: {
      preflight: () =>
        serverPreflight(serverRequest).then((r) => ({ ok: r.ok, failed: r.checks.filter((c) => !c.ok).map((c) => c.id) })),
      deploy: (target) => deployWorkspaceRelay(target, serverRequest),
    },
    telegram: {
      // The relay runs as this bot from its first deploy, so Telegram checks
      // the token before anything reaches the server.
      async checkBot() {
        const value = botToken || (await secrets.get(ws.id, "telegram-bot-token")) || "";
        await validateBotToken(value).catch((err: unknown) => {
          if (err instanceof Error && err.message === "invalid-bot-token") throw new SetupError("bot-failed", "botToken");
          throw err;
        });
        if (botToken) await secrets.set(ws.id, "telegram-bot-token", botToken);
      },
      async pair() {
        const stored = await secrets.get(ws.id, "telegram-bot-token");
        if (!stored) throw new Error("missing-bot-token");
        const botUsername = await validateBotToken(stored);
        const paired = await waitForPairing(serverRequest).catch((err: unknown) => {
          // An expired code cannot be waited on again: offer a new one.
          if (err instanceof Error && (err.message === "pairing-expired" || err.message === "pairing-timeout")) {
            setPairing(null);
            throw new SetupError("pairing-failed", "expired");
          }
          throw err;
        });
        return {
          botId: Number(stored.split(":")[0]),
          botUsername,
          chatId: paired.chatId,
          chatTitle: paired.chatTitle,
          allowedMemberIds: [paired.adminUserId],
        };
      },
      async announceComplete() {
        await relayControl(serverRequest, { kind: "send-setup-complete", applicationId: applicationInput?.id ?? "" });
      },
    },
    application: {
      async createTopic(input) {
        // Per group: a topic id means nothing in another chat.
        const key = JSON.stringify([ws.telegram?.chatId ?? null, input.id, input.topicName, input.topicColor]);
        const created = await createdTopic(key);
        if (created !== null) return { topicId: created };
        const reply = await relayControl(serverRequest, { kind: "topic-create", name: input.topicName, color: input.topicColor });
        const topicId = (reply as { topicId?: unknown } | null)?.topicId;
        if (typeof topicId !== "number") throw new Error("topic-invalid-reply");
        await rememberTopic(key, topicId);
        return { topicId };
      },
      configureAlert: (input) => alertRule(input.projectSlug, input.projectName, false),
      switchAlert: (input) => alertRule(input.projectSlug, input.name, true),
    },
    agent: {
      async install(input, agent) {
        const result = await agentInstall({
          workspaceId: ws.id,
          applicationId: input.id,
          repositoryPath: agent.repositoryPath,
          providers: agent.providers,
          projectSlug: input.projectSlug,
          glitchtipBaseUrl: ws.glitchtip.baseUrl,
        });
        return { helperVersion: result.helperInstalled ? "installed" : "unchanged", skillVersion: `files:${result.installed.length}` };
      },
    },
    verify: {
      syntheticEvent: () =>
        check("syntheticEvent", async () => {
          const reply = await relayControl(serverRequest, { kind: "send-test", applicationId: applicationInput?.id ?? "" });
          const eventId = (reply as { eventId?: unknown } | null)?.eventId;
          return typeof eventId === "string" ? { ok: true, eventId } : { ok: false, eventId: null };
        }),
      telegramDelivery: (eventId) =>
        check("telegramDelivery", async () => {
          const delivery = await waitForDelivery(eventId, () => relayAuditTail({ ...serverRequest, lines: 200 }));
          return { ok: delivery?.status === "delivered", failure: delivery?.failure ?? null };
        }),
      agentContext: () =>
        check("agentContext", async () => {
          const r = await agentVerify({
            workspaceId: ws.id,
            applicationId: applicationInput?.id ?? "",
            repositoryPath: repo.trim() || (lastApp?.repositoryPath ?? ""),
            providers: [provider],
          });
          return { ok: r.ok, canaryFound: r.canaryFound };
        }),
    },
  };

  async function publish(next: WorkspaceState): Promise<void> {
    try {
      await props.onWorkspaceChange(adding ? { ...next, onboarding: originalOnboarding.current } : next);
    } catch {
      throw new SetupError("save-failed");
    }
  }

  async function run(
    target: SetupStageNumber,
    input: SetupInput = {},
    options: { field?: boolean } = {},
  ): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      const next = await runStage(target, ws, input, deps);
      // A stage is done once it is saved; a failed save leaves it to run again.
      await publish(next);
      setWs(next);
      if (target === 1) {
        setToken("");
        setSaved((s) => ({ ...s, glitchtip: true }));
      }
      if (target === 2) {
        setBotToken("");
        setSaved((s) => ({ ...s, bot: true }));
      }
      // Saved with its application now, so the topic need not be remembered for a retry.
      if (target === 4) await forgetCreatedTopics();
      setSheetOpen(false);
    } catch (err) {
      setSheetOpen(false);
      setFailure({
        stage: target,
        message: errorMessage(locale, err),
        field: options.field === true && err instanceof SetupError && err.detail !== null && FIELD_DETAILS.has(err.detail),
        detail: err instanceof SetupError ? err.detail : null,
      });
    } finally {
      setBusy(false);
    }
  }

  async function guarded(target: SetupStageNumber, work: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await work();
    } catch (err) {
      setFailure({ stage: target, message: errorMessage(locale, err), field: false, detail: null });
    } finally {
      setBusy(false);
    }
  }

  function changeLocale(next: WorkspaceState["locale"]) {
    const updated = { ...ws, locale: next };
    setWs(updated);
    // A draft cannot be saved before the first stage; the locale is saved with it then.
    void publish(updated).catch(() => undefined);
  }

  // Editing an input invalidates the preview made from it.
  function editServer(patch: Partial<typeof server>) {
    setServer({ ...server, ...patch });
    setPreview(null);
  }

  const sectionError = failure && failure.stage === stage && !failure.field ? failure.message : null;
  const fieldFault = failure && failure.stage === stage && failure.field ? failure.detail : null;
  const firstStage: SetupStageNumber = adding ? 4 : 1;
  const done = ws.onboarding.completedAt !== null;
  const agentInput = { repositoryPath: repo.trim(), providers: [provider] };

  function checkStatus(index: number): Status {
    if (stage !== 6) return "unknown";
    if (busy) return "pending";
    const failedAt = failure?.stage === 6 ? CHECKS.findIndex((check) => check.key === failure.detail) : -1;
    if (failedAt < 0) return "unknown";
    return index < failedAt ? "ok" : index === failedAt ? "error" : "unknown";
  }

  const CHECK_LABELS: Record<Status, TranslationKey> = {
    ok: "setup.check.passed",
    error: "setup.check.failed",
    pending: "setup.check.running",
    warning: "setup.check.waiting",
    unknown: "setup.check.waiting",
  };

  let primary: Primary | null = null;
  let body: ReactNode = null;

  if (!done && stage === 1) {
    primary = {
      label: tr("setup.glitchtip.verify"),
      disabled: !baseUrl.trim() || !org.trim() || (!token && !saved.glitchtip),
      run: () => void run(1, {}, { field: true }),
    };
    body = (
      <FormSection>
        <TextField
          label={tr("setup.glitchtip.baseUrl")}
          type="url"
          value={baseUrl}
          onChange={setBaseUrl}
          mono
          error={fieldFault === "address" ? tr("setup.glitchtip.notGlitchtip") : undefined}
        />
        <TextField label={tr("setup.glitchtip.org")} value={org} onChange={setOrg} mono />
        <TextField
          label={tr("setup.glitchtip.token")}
          type="password"
          autoComplete="off"
          value={token}
          onChange={setToken}
          placeholder={saved.glitchtip ? tr("setup.savedToken") : undefined}
          description={tr("setup.glitchtip.tokenHelp")}
          error={fieldFault === "token" ? tr("setup.glitchtip.tokenRejected") : undefined}
        />
      </FormSection>
    );
  }

  if (!done && stage === 2) {
    const ready = Boolean(server.host.trim() && (botToken || saved.bot) && botDone);
    primary = preview
      ? { label: tr("setup.server.deploy"), disabled: !ready, run: () => setSheetOpen(true) }
      : {
          label: tr("setup.server.preview"),
          disabled: !ready,
          run: () =>
            void guarded(2, async () => {
              setPreview(
                await deploymentPreview({ ...serverRequest, workspaceId: ws.id, applicationIds: ws.applications.map((a) => a.id) }),
              );
            }),
        };
    body = (
      <>
        <FormSection title={tr("setup.server.connection")}>
          <TextField label={tr("setup.server.host")} value={server.host} onChange={(v) => editServer({ host: v })} mono />
          <TextField label={tr("setup.server.user")} value={server.user} onChange={(v) => editServer({ user: v })} mono />
          <TextField label={tr("setup.server.port")} type="number" value={server.port} onChange={(v) => editServer({ port: v })} />
          <TextField
            label={tr("setup.server.identity")}
            value={server.identityFile}
            onChange={(v) => editServer({ identityFile: v })}
            mono
          />
        </FormSection>
        <FormSection title={tr("setup.server.relayHeading")}>
          <TextField label={tr("setup.server.network")} value={server.dockerNetwork} onChange={(v) => editServer({ dockerNetwork: v })} mono />
          <TextField label={tr("setup.server.dir")} value={server.deploymentDir} onChange={(v) => editServer({ deploymentDir: v })} mono />
        </FormSection>
        <FormSection title={tr("setup.telegram.botfather")}>
          <TextField
            label={tr("setup.telegram.botToken")}
            type="password"
            autoComplete="off"
            value={botToken}
            onChange={setBotToken}
            placeholder={saved.bot ? tr("setup.savedToken") : undefined}
            error={fieldFault === "botToken" ? tr("setup.telegram.botRejected") : undefined}
          />
          <BlockRow>
            <p>{tr("setup.telegram.instructions")}</p>
          </BlockRow>
          <ListRow
            title={tr("setup.telegram.ownerDone")}
            trailing={
              botDone ? (
                <StatusBadge status="ok" label={tr("setup.status.done")} />
              ) : (
                <Button variant="secondary" disabled={!botToken && !saved.bot} onClick={() => setBotDone(true)}>
                  {tr("setup.telegram.confirm")}
                </Button>
              )
            }
          />
        </FormSection>
        {preview ? (
          <FormSection title={tr("setup.server.previewHeading")} footer={tr("setup.server.revision", { revision: preview.revision })}>
            <BlockRow>
              <CodeBlock label={tr("setup.server.files")} lines={preview.files.map((f) => `${f.mode}  ${f.path}`)} />
            </BlockRow>
            <BlockRow>
              <CodeBlock label={tr("setup.server.commands")} lines={preview.commands} />
            </BlockRow>
          </FormSection>
        ) : null}
        <Sheet
          open={sheetOpen}
          title={tr("setup.server.sheetTitle")}
          onClose={() => setSheetOpen(false)}
          confirm={{
            label: tr("setup.server.sheetConfirm"),
            pending: busy,
            onConfirm: () =>
              void run(2, { server: { ...serverRequest, confirmed: true } }, { field: true }),
          }}
        >
          <p>{tr("setup.server.sheetBody", { host: server.host })}</p>
        </Sheet>
      </>
    );
  }

  if (!done && stage === 3) {
    primary = pairing
      ? { label: tr("setup.telegram.wait"), run: () => void run(3) }
      : {
          label: tr("setup.telegram.createCode"),
          run: () => void guarded(3, async () => setPairing(await createPairingCode(serverRequest))),
        };
    body = (
      <>
        {pairing ? (
          <FormSection
            title={tr("setup.telegram.codeLabel")}
            footer={tr("setup.telegram.expires", { time: new Date(pairing.expiresAt).toLocaleTimeString(locale) })}
          >
            <ListRow title={<span className="ui-code-display" data-selectable>{pairing.code}</span>} trailing={<CopyButton text={pairing.code} />} />
          </FormSection>
        ) : null}
      </>
    );
  }

  if (!done && stage === 4) {
    primary = {
      label: tr("setup.app.submit"),
      disabled: !app.slug.trim() || environments.length === 0,
      run: () => void run(4, { application: applicationInput }),
    };
    body = (
      <FormSection footer={tr("setup.app.summary")}>
        <TextField label={tr("setup.app.slug")} value={app.slug} onChange={(v) => setApp({ ...app, slug: v })} mono />
        <TextField label={tr("setup.app.name")} value={app.name} onChange={(v) => setApp({ ...app, name: v })} />
        <TextField label={tr("setup.app.envs")} value={app.envs} onChange={(v) => setApp({ ...app, envs: v })} mono />
        <TextField label={tr("setup.app.topic")} value={app.topic} onChange={(v) => setApp({ ...app, topic: v })} />
        <SwatchPicker
          label={tr("setup.app.color")}
          value={app.color}
          onChange={(v) => setApp({ ...app, color: v })}
          options={TOPIC_COLORS.map((c) => ({ value: String(c.value), label: tr(c.name), color: topicCss(c.value) }))}
        />
      </FormSection>
    );
  }

  if (!done && stage === 5) {
    primary = agentPreview
      ? { label: tr("setup.agent.install"), run: () => void run(5, { application: applicationInput, agent: agentInput }) }
      : {
          label: tr("setup.agent.preview"),
          disabled: !repo.trim() || !applicationInput,
          run: () =>
            void guarded(5, async () => {
              setAgentPreview(
                await agentInstallPreview({
                  workspaceId: ws.id,
                  applicationId: applicationInput?.id ?? "",
                  repositoryPath: agentInput.repositoryPath,
                  providers: agentInput.providers,
                  projectSlug: applicationInput?.projectSlug ?? "",
                  glitchtipBaseUrl: ws.glitchtip.baseUrl,
                }),
              );
            }),
        };
    body = (
      <>
        <FormSection>
          <TextField
            label={tr("setup.agent.repo")}
            value={repo}
            onChange={(v) => {
              setRepo(v);
              setAgentPreview(null);
            }}
            mono
          />
          <SegmentedControl<AgentProvider>
            label={tr("setup.agent.provider")}
            value={provider}
            onChange={(v) => {
              setProvider(v);
              setAgentPreview(null);
            }}
            options={PROVIDERS.map((p) => ({ value: p.value, label: tr(p.label) }))}
          />
        </FormSection>
        {agentPreview ? (
          <FormSection title={tr("setup.agent.files")}>
            {agentPreview.files.map((f) => (
              <ListRow
                key={f.path}
                title={<span className="ui-mono">{f.path}</span>}
                trailing={<span className="ui-chip">{tr(FILE_ACTIONS[f.action])}</span>}
              />
            ))}
          </FormSection>
        ) : null}
      </>
    );
  }

  if (!done && stage === 6) {
    primary = { label: tr("setup.verify.run"), run: () => void run(6, { application: applicationInput }) };
    body = (
      <FormSection>
        {CHECKS.map((check, index) => {
          const status = checkStatus(index);
          return <ListRow key={check.key} title={tr(check.label)} trailing={<StatusBadge status={status} label={tr(CHECK_LABELS[status])} />} />;
        })}
      </FormSection>
    );
  }

  if (done) {
    body = (
      <EmptyState
        icon={CheckCircle2}
        title={tr("setup.complete")}
        action={
          props.onFinish ? (
            <Button onClick={props.onFinish} size="large">
              {tr("action.done")}
            </Button>
          ) : undefined
        }
      />
    );
  }

  const steps = STAGES.filter((s) => s >= firstStage).map((s) => {
    const state = done || s < stage ? ("done" as const) : s === stage ? ("current" as const) : ("todo" as const);
    return {
      key: String(s),
      label: tr(adding && s === 4 ? "setup.stage.applicationAdd" : STAGE_KEYS[s]),
      state,
      statusLabel: tr(state === "done" ? "setup.status.done" : state === "current" ? "setup.status.current" : "setup.status.todo"),
    };
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (primary && !primary.disabled && !busy) primary.run();
  }

  const content = (
    <>
      {/* Adding an application: the page title and the step row already say where you are. */}
      {!done && !adding ? (
        <h2 id={titleId} className="ui-assistant__title">
          {tr(STAGE_KEYS[stage])}
        </h2>
      ) : null}
      {sectionError ? (
        <InlineAlert tone="error" live>
          {sectionError}
        </InlineAlert>
      ) : null}
      {body}
    </>
  );

  const action = primary ? (
    <Button type="submit" size="large" pending={busy} disabled={primary.disabled}>
      {primary.label}
    </Button>
  ) : null;

  if (adding) {
    return (
      <Page title={tr("setup.titleAdd")}>
        <Steps label={tr("setup.titleAdd")} steps={steps} orientation="horizontal" />
        {/* noValidate: each stage reports its own errors; the browser's would block the submit silently. */}
        <form className="flex flex-col gap-[var(--space-5)]" aria-label={tr("setup.titleAdd")} noValidate onSubmit={submit}>
          {content}
          {action ? <div className="flex justify-end">{action}</div> : null}
        </form>
      </Page>
    );
  }

  return (
    <div className="ui-assistant">
      <aside className="ui-assistant__aside">
        <div className="ui-titlebar-spacer" data-tauri-drag-region />
        <div className="ui-assistant__brand">
          <AppIcon />
          <p className="ui-assistant__brand-name">{tr("appName")}</p>
        </div>
        <div>
          <h1 className="ui-sidebar__heading">{tr("setup.title")}</h1>
          <Steps label={tr("setup.title")} steps={steps} />
        </div>
        <div className="ui-assistant__aside-footer">
          <SelectField
            label={tr("settings.locale")}
            value={locale}
            onChange={(value) => changeLocale(value as WorkspaceState["locale"])}
            options={LANGUAGES}
          />
        </div>
      </aside>
      <main className="ui-assistant__main">
        <form
          className="ui-assistant__form"
          aria-labelledby={done ? undefined : titleId}
          aria-label={done ? tr("setup.title") : undefined}
          noValidate
          onSubmit={submit}
        >
          <div className="ui-titlebar-spacer" data-tauri-drag-region />
          <div className="ui-assistant__scroll">
            <div className="ui-assistant__content">{content}</div>
          </div>
          {action ? <div className="ui-assistant__footer">{action}</div> : null}
        </form>
      </main>
    </div>
  );
}
