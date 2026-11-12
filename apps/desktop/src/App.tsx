import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  KeyRound,
  Inbox,
  LayoutDashboard,
  Plus,
  Server,
  Settings,
  SquareStack,
  type LucideIcon,
} from "lucide-react";

import {
  inspectLegacyState,
  legacyPending,
  retireLegacyInstall,
  turnOffLegacyInstall,
  type LegacyPending,
} from "./app/migration";
import { installAppMenu, onMenuCommand } from "./app/menu";
import {
  applyAppearance,
  loadAppearance,
  loadNotifyLevel,
  saveAppearance,
  saveNotifyLevel,
  type Appearance,
  type NotifyLevel,
} from "./app/preferences";
import type { AppRoute } from "./app/routes";
import { useWindowChrome } from "./app/window";
import {
  draftWorkspace,
  loadWorkspace,
  preferredLocale,
  saveWorkspace,
  type WorkspaceState,
} from "./app/workspace";
import { useInbox } from "./app/inbox-state";
import { resumeTelegramSetup } from "./lib/setup-machine";
import TrayManager from "./components/TrayManager";
import { Button, EmptyState, Sheet, SidebarItem, SidebarSection, UiLocale } from "./components/ui";
import { t, type Locale, type TranslationKey } from "./i18n";
import { LEGACY_WORKSPACE_ID } from "./lib/secrets";
import ApplicationsScreen from "./screens/ApplicationsScreen";
import CredentialsScreen from "./screens/CredentialsScreen";
import DeliveryActivityScreen from "./screens/DeliveryActivityScreen";
import MigrationScreen from "./screens/MigrationScreen";
import InboxScreen from "./screens/InboxScreen";
import OverviewScreen from "./screens/OverviewScreen";
import RelayServerScreen from "./screens/RelayServerScreen";
import SettingsScreen from "./screens/SettingsScreen";
import { SetupAssistant } from "./screens/SetupAssistant";
import TelegramWorkspaceScreen from "./screens/TelegramWorkspaceScreen";

export type OperationsKind = Exclude<AppRoute["kind"], "setup">;

type Destination = { kind: OperationsKind; label: TranslationKey; icon?: LucideIcon; product?: "telegram" };

// Sidebar order is also the ⌘1…⌘7 order.
const SECTIONS: Array<{ heading: TranslationKey; items: Destination[] }> = [
  {
    heading: "nav.section.workspace",
    items: [
      { kind: "inbox", label: "nav.inbox", icon: Inbox },
      { kind: "overview", label: "nav.overview", icon: LayoutDashboard },
      { kind: "applications", label: "nav.applications", icon: SquareStack },
    ],
  },
  {
    heading: "nav.section.delivery",
    items: [
      { kind: "telegram", label: "nav.telegram", product: "telegram" },
      { kind: "relay", label: "nav.relay", icon: Server },
      { kind: "delivery", label: "nav.delivery", icon: Activity },
    ],
  },
  {
    heading: "nav.section.mac",
    items: [
      { kind: "credentials", label: "nav.credentials", icon: KeyRound },
      { kind: "settings", label: "nav.settings", icon: Settings },
    ],
  },
];
// Without a relay or a Telegram chat, the delivery screens and adding applications stay hidden.
const SECTIONS_WITHOUT_TELEGRAM = SECTIONS.filter((section) => section.heading !== "nav.section.delivery");
const DESTINATIONS = SECTIONS.flatMap((section) => section.items);
const DESTINATIONS_WITHOUT_TELEGRAM = SECTIONS_WITHOUT_TELEGRAM.flatMap((section) => section.items);

/** Route is derived from onboarding state until the user navigates. */
export function initialRoute(workspace: WorkspaceState): AppRoute {
  if (workspace.onboarding.completedAt === null) {
    const stages = ["glitchtip", "server", "telegram", "application", "agent", "verify"] as const;
    return { kind: "setup", stage: stages[workspace.onboarding.currentStage - 1] };
  }
  return { kind: "inbox" };
}

// What the window shows before a workspace exists.
type Boot =
  | { kind: "loading" }
  | { kind: "migrate" }
  | { kind: "unreadable" }
  | { kind: "ready" };

async function legacyNeedsMigration(): Promise<boolean> {
  try {
    return (await inspectLegacyState()).kind === "legacy";
  } catch {
    return false;
  }
}

export default function App({ initialWorkspace }: { initialWorkspace?: WorkspaceState | null }) {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(initialWorkspace ?? null);
  const [boot, setBoot] = useState<Boot>(initialWorkspace ? { kind: "ready" } : { kind: "loading" });
  const [route, setRoute] = useState<AppRoute | null>(initialWorkspace ? initialRoute(initialWorkspace) : null);
  const [appearance, setAppearance] = useState<Appearance>("system");
  const [notify, setNotify] = useState<NotifyLevel>("important");
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  // The newest workspace, for updates that finish after an await (see updateWorkspace).
  const latest = useRef<WorkspaceState | null>(initialWorkspace ?? null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useWindowChrome();

  function open(next: WorkspaceState) {
    latest.current = next;
    setWorkspace(next);
    setRoute(initialRoute(next));
    setBoot({ kind: "ready" });
    void refreshLegacy();
  }

  // v1 while the relay on this Mac still runs after the move: setup offers its project as the
  // first application, and Overview says v1 is still on.
  const [legacy, setLegacy] = useState<LegacyPending | null>(null);
  function refreshLegacy() {
    return legacyPending().then(setLegacy, () => setLegacy(null));
  }
  const legacyProject = legacy?.project ?? null;

  // A v1 install carried into setup is turned off once an application for its project has passed
  // verification (stage 6 switches its alert rule first) and is on disk: after such a save, or at
  // launch. A failure leaves v1 running, which is harmless, and the next save or launch tries
  // again. One attempt runs at a time.
  const retiring = useRef<Promise<void>>(Promise.resolve());
  function retireLegacyWhenCovered(saved: WorkspaceState) {
    if (saved.onboarding.completedAt === null) return;
    const projects = saved.applications.filter((app) => app.verifiedAt !== null).map((app) => app.projectSlug);
    retiring.current = retiring.current
      .then(() => retireLegacyInstall(projects))
      .catch((err: unknown) => console.warn("retiring the v1 relay failed:", err))
      .then(refreshLegacy);
  }

  // A v1 whose project is unknown is turned off only when the user says so.
  function turnOffLegacy(): Promise<void> {
    const run = retiring.current.then(() => turnOffLegacyInstall()).finally(refreshLegacy);
    retiring.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(() => undefined);
  }

  function startFresh() {
    open(draftWorkspace(LEGACY_WORKSPACE_ID, preferredLocale()));
  }

  useEffect(() => {
    void loadAppearance().then((stored) => {
      setAppearance(stored);
      applyAppearance(stored);
    });
    void loadNotifyLevel().then(setNotify);
  }, []);

  useEffect(() => {
    if (initialWorkspace) return;
    let cancelled = false;
    void (async () => {
      let loaded: WorkspaceState | null;
      try {
        loaded = initialWorkspace === null ? null : await loadWorkspace();
      } catch {
        if (!cancelled) setBoot({ kind: "unreadable" });
        return;
      }
      if (cancelled) return;
      if (loaded) {
        open(loaded);
        retireLegacyWhenCovered(loaded);
        return;
      }
      // No workspace yet: a v1 install moves over; anything else starts the assistant.
      if (await legacyNeedsMigration()) {
        if (!cancelled) setBoot({ kind: "migrate" });
        return;
      }
      if (!cancelled) startFresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [initialWorkspace]);

  const locale: Locale = workspace?.locale ?? preferredLocale();
  const inbox = useInbox(workspace, locale, notify);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const onboarding = workspace !== null && workspace.onboarding.completedAt === null;
  const telegramOn = workspace !== null && workspace.telegram !== null;
  const sections = telegramOn ? SECTIONS : SECTIONS_WITHOUT_TELEGRAM;
  const destinations = telegramOn ? DESTINATIONS : DESTINATIONS_WITHOUT_TELEGRAM;

  // ⌘1…⌘7 open the sidebar destinations, ⌘, opens Settings, ⌘N adds an application.
  useEffect(() => {
    if (boot.kind !== "ready" || onboarding) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
      if (document.querySelector('[role="dialog"]')) return;
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < destinations.length) {
        event.preventDefault();
        setRoute({ kind: destinations[index].kind } as AppRoute);
      } else if (event.key === ",") {
        event.preventDefault();
        setRoute({ kind: "settings" });
      } else if (event.key.toLowerCase() === "n" && telegramOn) {
        event.preventDefault();
        setRoute({ kind: "setup", stage: "application" });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [boot.kind, onboarding, destinations, telegramOn]);

  // The menu bar, in the workspace's language. Settings sits in the app menu, so View lists the rest.
  const navigation = boot.kind === "ready" && !onboarding;

  // An error picked in a notification or the menu bar opens in the inbox, wherever the window was.
  useEffect(() => {
    if (navigation && inbox.focus?.by === "user") setRoute({ kind: "inbox" });
  }, [navigation, inbox.focus]);
  useEffect(() => {
    const items = destinations
      .filter((item) => item.kind !== "settings")
      .map((item) => ({ id: item.kind, text: t(locale, item.label) }));
    void installAppMenu(locale, items, navigation).catch(() => undefined);
  }, [locale, navigation, destinations]);

  useEffect(() => {
    if (!navigation) return;
    return onMenuCommand((command) => {
      if (document.querySelector('[role="dialog"]')) return;
      if (command === "add-application") {
        if (telegramOn) setRoute({ kind: "setup", stage: "application" });
      } else if (destinations.some((item) => item.kind === command)) setRoute({ kind: command } as AppRoute);
    });
  }, [navigation, destinations, telegramOn]);

  // Resolves once the workspace is on disk.
  function commitWorkspace(next: WorkspaceState): Promise<void> {
    latest.current = next;
    setWorkspace(next);
    return saveWorkspace(next).then(() => retireLegacyWhenCovered(next));
  }

  // For screens that do not wait for the save: a failed one is saved over by the next change.
  function changeWorkspace(next: WorkspaceState) {
    void commitWorkspace(next).catch(() => undefined);
  }

  // For screens whose change lands after a long await (a relay deploy): applied
  // to the workspace as it is then, so edits made meanwhile are kept.
  function updateWorkspace(update: (current: WorkspaceState) => WorkspaceState) {
    if (latest.current !== null) changeWorkspace(update(latest.current));
  }

  // Primitives (Button, Sheet, InlineAlert, CopyButton) take their labels' language from here.
  const provide = (node: React.ReactNode) => <UiLocale.Provider value={locale}>{node}</UiLocale.Provider>;

  function changeAppearance(next: Appearance) {
    setAppearance(next);
    applyAppearance(next);
    void saveAppearance(next);
  }

  if (boot.kind === "migrate") {
    return provide(
      <>
        <TrayManager inbox={inbox} locale={locale} />
        <MigrationScreen
          locale={locale}
          workspaceId={LEGACY_WORKSPACE_ID}
          onImported={(draft) => {
            // Saved at once, so a restart resumes this setup instead of offering the move again.
            open(draft);
            void saveWorkspace(draft).catch(() => undefined);
          }}
          onStartFresh={startFresh}
        />
      </>
    );
  }

  if (boot.kind === "unreadable") {
    return provide(
      <main className="ui-main" data-tauri-drag-region>
        <EmptyState
          icon={AlertTriangle}
          title={t(locale, "app.loadFailed")}
          action={
            <Button variant="secondary" onClick={() => setConfirmStartOver(true)}>
              {t(locale, "app.startOver")}
            </Button>
          }
        />
        <Sheet
          open={confirmStartOver}
          title={t(locale, "app.startOverTitle")}
          onClose={() => setConfirmStartOver(false)}
          confirm={{
            label: t(locale, "app.startOver"),
            destructive: true,
            onConfirm: () => {
              setConfirmStartOver(false);
              startFresh();
            },
          }}
        >
          <p>{t(locale, "app.startOverBody")}</p>
        </Sheet>
      </main>
    );
  }

  if (boot.kind === "loading" || workspace === null || route === null) {
    return provide(
      <main className="ui-main ui-launch" data-tauri-drag-region aria-busy="true">
        <span aria-hidden="true" className="ui-spinner" />
        <span className="sr-only">{t(locale, "app.loading")}</span>
      </main>
    );
  }

  const l = workspace.locale;
  const adding = route.kind === "setup" && !onboarding;

  function onNavKeyDown(event: React.KeyboardEvent, index: number) {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const count = destinations.length;
    itemRefs.current[(index + step + count) % count]?.focus();
  }

  if (route.kind === "setup" && onboarding) {
    return provide(
      <>
        <TrayManager inbox={inbox} locale={locale} />
        <SetupAssistant
          workspace={workspace}
          mode="onboarding"
          suggestedProject={legacyProject}
          onWorkspaceChange={async (next) => {
            await commitWorkspace(next);
            if (next.onboarding.completedAt !== null) setRoute({ kind: "inbox" });
          }}
        />
      </>
    );
  }

  return provide(
    <div className="ui-window">
      <TrayManager inbox={inbox} locale={locale} />
      <nav aria-label={t(l, "nav.label")} className="ui-sidebar">
        <div className="ui-titlebar-spacer" data-tauri-drag-region />
        {sections.map((section) => (
          <SidebarSection key={section.heading} heading={t(l, section.heading)}>
            {section.items.map((item) => {
              const index = destinations.indexOf(item);
              return (
                <SidebarItem
                  key={item.kind}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  label={t(l, item.label)}
                  icon={item.icon}
                  product={item.product}
                  current={route.kind === item.kind}
                  onClick={() => setRoute({ kind: item.kind } as AppRoute)}
                  onKeyDown={(event) => onNavKeyDown(event, index)}
                />
              );
            })}
          </SidebarSection>
        ))}
        {telegramOn ? (
          <div className="ui-sidebar__footer">
            <SidebarSection>
              <SidebarItem
                label={t(l, "nav.addApplication")}
                icon={Plus}
                muted={!adding}
                current={adding}
                onClick={() => setRoute({ kind: "setup", stage: "application" })}
              />
            </SidebarSection>
          </div>
        ) : null}
      </nav>
      <main className="ui-main">
        {route.kind === "setup" && (
          <SetupAssistant
            workspace={workspace}
            mode="add-application"
            suggestedProject={
              legacyProject !== null && !workspace.applications.some((app) => app.projectSlug === legacyProject)
                ? legacyProject
                : null
            }
            onWorkspaceChange={commitWorkspace}
            onFinish={() => setRoute({ kind: "applications" })}
          />
        )}
        {route.kind === "inbox" && (
          <InboxScreen workspace={workspace} inbox={inbox} focus={inbox.focus} />
        )}
        {route.kind === "overview" && (
          <OverviewScreen
            workspace={workspace}
            legacy={legacy}
            onNavigate={(kind) => setRoute({ kind } as AppRoute)}
            onAddApplication={telegramOn ? () => setRoute({ kind: "setup", stage: "application" }) : undefined}
            onTurnOffLegacy={turnOffLegacy}
          />
        )}
        {route.kind === "applications" && (
          <ApplicationsScreen
            workspace={workspace}
            onAdd={telegramOn ? () => setRoute({ kind: "setup", stage: "application" }) : undefined}
          />
        )}
        {route.kind === "telegram" && <TelegramWorkspaceScreen workspace={workspace} />}
        {route.kind === "relay" && <RelayServerScreen workspace={workspace} onWorkspaceUpdate={updateWorkspace} />}
        {route.kind === "delivery" && (
          <DeliveryActivityScreen workspace={workspace} onNavigate={(kind) => setRoute({ kind } as AppRoute)} />
        )}
        {route.kind === "credentials" && <CredentialsScreen workspace={workspace} />}
        {route.kind === "settings" && (
          <SettingsScreen
            workspace={workspace}
            onWorkspaceChange={changeWorkspace}
            appearance={appearance}
            onAppearanceChange={changeAppearance}
            notify={notify}
            onNotifyChange={(next) => {
              setNotify(next);
              void saveNotifyLevel(next);
            }}
            onSetUpTelegram={() => {
              void commitWorkspace(resumeTelegramSetup(workspace)).then(
                () => setRoute({ kind: "setup", stage: "server" }),
                () => undefined,
              );
            }}
          />
        )}
      </main>
    </div>
  );
}
