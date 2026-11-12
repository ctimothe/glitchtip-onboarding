// The inbox: every connected GlitchTip server's open errors in one list beside the selected
// error's latest event. It opens on the errors that need attention (outages and bugs in
// production, the most serious first); All shows every open error, most recently seen first, each
// with how it was read (src/lib/triage.ts). Resolve and Ignore change the error in GlitchTip and
// drop it from the list at once; the next poll confirms. Reads come from the inbox state
// (src/app/inbox-state.ts); only the selected error's latest event is fetched here.

import { CircleCheck, Inbox, Plus, RotateCw } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState } from "react";

import type { InboxFocus, InboxState } from "../app/inbox-state";
import { acceptsToken, inboxSources, type WorkspaceState } from "../app/workspace";
import {
  Button,
  CopyButton,
  DetailRow,
  EmptyState,
  FormSection,
  InlineAlert,
  OptionList,
  OptionRow,
  PopupButton,
  ScopeBar,
  Tag,
  type OptionTone,
  type TagTone,
} from "../components/ui";
import { t } from "../i18n";
import { formatDateTime, formatRelative } from "../lib/format";
import { issueUrl, latestEvent, setIssueStatus, type IssueEvent } from "../lib/glitchtip";
import { inboxIssues, inboxProjects, issueKey } from "../lib/inbox";
import * as secrets from "../lib/secrets";
import { byAttention } from "../lib/tray-feed";
import { needsAttention, type Priority } from "../lib/triage";
import ConnectProjectSheet from "./ConnectProjectSheet";

type EventState = { key: string } & ({ kind: "loading" } | { kind: "ready"; event: IssueEvent } | { kind: "failed"; detail: string });

const PRIORITY_TONE: Record<Priority, OptionTone> = { critical: "error", important: "warning", quiet: "neutral" };

const TAG_TONE: Record<Priority, TagTone> = { critical: "error", important: "warning", quiet: "neutral" };

type Scope = "attention" | "all";

export default function InboxScreen({
  workspace,
  inbox,
  focus,
}: {
  workspace: WorkspaceState;
  inbox: InboxState;
  /** An issue to select when it arrives: the latest notification's, or one the user picked outside the window. */
  focus?: InboxFocus | null;
}) {
  const l = workspace.locale;
  const sources = inboxSources(workspace);
  // Errors resolved or ignored here, by key, with their server and when (Date.now()) the change succeeded.
  const [hidden, setHidden] = useState<ReadonlyMap<string, { sourceId: string; at: number }>>(new Map());
  const hiddenKeys = useMemo(() => new Set(hidden.keys()), [hidden]);
  const allIssues = useMemo(() => inboxIssues(inbox.sources, hiddenKeys), [inbox.sources, hiddenKeys]);
  const projects = useMemo(() => inboxProjects(allIssues), [allIssues]);
  // A project that has no open errors left falls back to all of them.
  const [projectChoice, setProjectChoice] = useState("");
  const project = projects.some((p) => p.key === projectChoice) ? projectChoice : "";
  const [scope, setScope] = useState<Scope>("attention");
  const inProject = useMemo(
    () => (project === "" ? allIssues : allIssues.filter((issue) => issueKey(issue.sourceId, issue.project.id) === project)),
    [allIssues, project],
  );
  const issues = useMemo(
    () => (scope === "all" ? inProject : inProject.filter((issue) => needsAttention(issue.triage)).sort(byAttention)),
    [inProject, scope],
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [event, setEvent] = useState<EventState | null>(null);
  const [acting, setActing] = useState<"resolved" | "ignored" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  // A focused issue is selected once, when it is in the inbox, whatever the list is narrowed to;
  // later polls leave the selection alone.
  const appliedFocus = useRef<InboxFocus | null>(null);
  useEffect(() => {
    if (!focus || focus === appliedFocus.current) return;
    const target = allIssues.find((issue) => issue.key === focus.key);
    if (!target) return;
    appliedFocus.current = focus;
    if (!inProject.includes(target)) setProjectChoice("");
    if (!needsAttention(target.triage)) setScope("all");
    setSelectedKey(focus.key);
    // A change asked for in a notification that did not happen is said here, beside the error.
    setActionError(focus.error ?? null);
  }, [focus, allIssues, inProject]);

  // An issue resolved or ignored here stays hidden until a successful poll that began after the
  // change: that poll no longer lists it, or lists it because GlitchTip reopened it on a new
  // event, and then it shows again. A poll that began before the change still lists it as it was.
  useEffect(() => {
    setHidden((keys) => {
      if (keys.size === 0) return keys;
      const still = [...keys].filter(([, { sourceId, at }]) => {
        const state = inbox.sources[sourceId];
        return !(state?.status === "ok" && state.polledAt >= at);
      });
      return still.length === keys.size ? keys : new Map(still);
    });
  }, [inbox.sources]);

  const selected = issues.find((issue) => issue.key === selectedKey) ?? issues[0] ?? null;
  const source = selected ? sources.find((s) => s.id === selected.sourceId) ?? null : null;

  // The selected error's latest event, fetched once per selection.
  useEffect(() => {
    if (selected === null || source === null) return;
    const key = selected.key;
    let current = true;
    setEvent({ key, kind: "loading" });
    void (async () => {
      try {
        const token = await secrets.get(workspace.id, source.tokenKey);
        if (!token) throw new Error("token-missing");
        const loaded = await latestEvent(source.baseUrl, token, selected.id);
        if (current) setEvent({ key, kind: "ready", event: loaded });
      } catch (err) {
        if (current) setEvent({ key, kind: "failed", detail: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      current = false;
    };
    // Only a different issue reloads; a poll that refreshes counts does not.
  }, [selected?.key]);

  async function change(status: "resolved" | "ignored") {
    if (selected === null || source === null) return;
    setActing(status);
    setActionError(null);
    try {
      const token = await secrets.get(workspace.id, source.tokenKey);
      if (!token) throw new Error("token-missing");
      await setIssueStatus(source.baseUrl, token, source.organizationSlug, selected.id, status);
      const index = issues.indexOf(selected);
      const next = issues[index + 1] ?? issues[index - 1] ?? null;
      const entry = { sourceId: selected.sourceId, at: Date.now() };
      setHidden((keys) => new Map(keys).set(selected.key, entry));
      setSelectedKey(next?.key ?? null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(null);
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await inbox.refresh();
    } finally {
      setRefreshing(false);
    }
  }

  function move(step: -1 | 1) {
    const index = selected ? issues.indexOf(selected) : -1;
    const next = issues[index + step];
    if (!next) return;
    setSelectedKey(next.key);
    rowRefs.current.get(next.key)?.focus();
  }

  const failures = sources.flatMap((s) => {
    const state = inbox.sources[s.id];
    if (state?.status !== "error") return [];
    return [
      state.error === "token-missing"
        ? t(l, "inbox.tokenMissing", { source: s.name })
        : t(l, "inbox.sourceFailed", { source: s.name, detail: state.error }),
    ];
  });
  const application =
    selected && selected.sourceId === "primary"
      ? workspace.applications.find((app) => app.projectSlug === selected.project.slug) ?? null
      : null;
  const polled = sources.some((s) => inbox.sources[s.id] !== undefined);
  const title = t(l, "nav.inbox");
  // Open errors exist, none of them needs attention.
  const calm = issues.length === 0 && inProject.length > 0;
  const signals = selected?.signals ?? null;
  // Events that name no environment (the `""` entry) are not listed.
  const environments = Object.entries(signals?.environments ?? {})
    .filter(([name]) => name !== "")
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  const people = selected ? Math.max(selected.userCount, signals?.users ?? 0) : 0;

  return (
    <section className="ui-page" aria-label={title}>
      <header className="ui-toolbar" data-tauri-drag-region>
        <h1 className="ui-toolbar__title" data-tauri-drag-region>
          {title}
        </h1>
        <div className="ui-toolbar__actions">
          <ScopeBar
            label={t(l, "inbox.scope")}
            value={scope}
            onChange={setScope}
            options={[
              { value: "attention", label: t(l, "inbox.scope.attention") },
              { value: "all", label: t(l, "inbox.scope.all") },
            ]}
          />
          {projects.length > 1 ? (
            <PopupButton
              label={t(l, "inbox.project")}
              value={project}
              onChange={setProjectChoice}
              options={[
                { value: "", label: t(l, "inbox.allProjects") },
                ...projects.map((p) => ({ value: p.key, label: p.name })),
              ]}
            />
          ) : null}
          <Button
            variant="toolbar"
            icon={Plus}
            aria-label={t(l, "connect.open")}
            title={t(l, "connect.open")}
            onClick={() => setConnecting(true)}
          />
          <Button
            variant="toolbar"
            icon={RotateCw}
            pending={refreshing}
            aria-label={t(l, "inbox.refresh")}
            title={t(l, "inbox.refresh")}
            onClick={() => void refresh()}
          />
        </div>
      </header>
      <div className="ui-split">
        <div className="ui-split__list">
          {failures.map((failure) => (
            <InlineAlert key={failure} tone="error" live>
              {failure}
            </InlineAlert>
          ))}
          {calm ? (
            <EmptyState
              icon={CircleCheck}
              title={t(l, "inbox.calm")}
              action={
                <Button variant="secondary" onClick={() => setScope("all")}>
                  {t(l, "inbox.showAll", { count: inProject.length })}
                </Button>
              }
            />
          ) : issues.length === 0 ? (
            polled ? <EmptyState icon={CircleCheck} title={t(l, "inbox.empty")} /> : null
          ) : (
            <OptionList label={t(l, "inbox.list")} onMove={move}>
              {issues.map((issue) => (
                <OptionRow
                  key={issue.key}
                  tone={PRIORITY_TONE[issue.triage.priority]}
                  title={issue.title}
                  meta={`${t(l, `triage.kind.${issue.triage.kind}`)} · ${issue.project.name || issue.project.slug} · ${formatRelative(issue.lastSeen, l)}`}
                  selected={issue.key === selected?.key}
                  onSelect={() => setSelectedKey(issue.key)}
                  buttonRef={(node) => {
                    if (node) rowRefs.current.set(issue.key, node);
                    else rowRefs.current.delete(issue.key);
                  }}
                />
              ))}
            </OptionList>
          )}
        </div>
        <div className="ui-split__detail">
          {selected === null ? (
            calm ? null : <EmptyState icon={Inbox} title={t(l, issues.length === 0 ? "inbox.empty" : "inbox.noSelection")} />
          ) : (
            <div className="ui-page__content">
              <div className="ui-issue-head">
                <h2 className="ui-issue-head__title">{selected.title}</h2>
                {selected.culprit ? <p className="ui-issue-head__culprit">{selected.culprit}</p> : null}
                <Tag
                  tone={TAG_TONE[selected.triage.priority]}
                  label={t(l, `triage.kind.${selected.triage.kind}`)}
                  detail={selected.triage.reasons.map((reason) => t(l, `triage.reason.${reason}`)).join(" · ")}
                />
                <div className="ui-issue-head__actions">
                  <Button pending={acting === "resolved"} disabled={acting !== null} onClick={() => void change("resolved")}>
                    {t(l, "inbox.resolve")}
                  </Button>
                  <Button
                    variant="secondary"
                    pending={acting === "ignored"}
                    disabled={acting !== null}
                    onClick={() => void change("ignored")}
                  >
                    {t(l, "inbox.ignore")}
                  </Button>
                  {source && acceptsToken(source.baseUrl) ? (
                    <Button
                      variant="quiet"
                      onClick={() => void openUrl(issueUrl(source.baseUrl, source.organizationSlug, selected))}
                    >
                      {t(l, "inbox.open")}
                    </Button>
                  ) : null}
                  {application ? (
                    <CopyButton text={`gt:${application.id}:${selected.id}`} label={t(l, "inbox.copyRef")} />
                  ) : null}
                </div>
              </div>
              {actionError ? (
                <InlineAlert tone="error" live>
                  {t(l, "inbox.actionFailed", { detail: actionError })}
                </InlineAlert>
              ) : null}
              <FormSection>
                <DetailRow label={t(l, "inbox.detail.project")}>{selected.project.name || selected.project.slug}</DetailRow>
                {environments.length > 0 ? (
                  <DetailRow label={t(l, "inbox.detail.environment")}>{environments.join(", ")}</DetailRow>
                ) : null}
                <DetailRow label={t(l, "inbox.detail.events")}>{selected.count}</DetailRow>
                <DetailRow label={t(l, "inbox.detail.users")}>{people}</DetailRow>
                <DetailRow label={t(l, "inbox.detail.firstSeen")}>{formatDateTime(selected.firstSeen, l)}</DetailRow>
                <DetailRow label={t(l, "inbox.detail.lastSeen")}>{formatDateTime(selected.lastSeen, l)}</DetailRow>
                {event?.key === selected.key && event.kind === "ready" && event.event.release ? (
                  <DetailRow label={t(l, "inbox.detail.release")} mono>
                    {event.event.release}
                  </DetailRow>
                ) : null}
              </FormSection>
              {event?.key !== selected.key || event.kind === "loading" ? (
                <p className="ui-issue-note" role="status">
                  {t(l, "inbox.detail.loading")}
                </p>
              ) : event.kind === "failed" ? (
                <InlineAlert tone="error">{t(l, "inbox.eventFailed", { detail: event.detail })}</InlineAlert>
              ) : (
                event.event.exceptions.map((exception, index) => (
                  <FormSection key={index} title={index === 0 ? t(l, "inbox.detail.stack") : undefined}>
                    <div className="ui-stack">
                      <p className="ui-stack__exception">
                        {exception.type}
                        {exception.value ? `: ${exception.value}` : ""}
                      </p>
                      <ol className="ui-stack__frames">
                        {exception.frames.map((frame, frameIndex) => (
                          <li key={frameIndex} className="ui-stack__frame" data-in-app={frame.inApp || undefined}>
                            <span className="ui-stack__function">{frame.function || "?"}</span>{" "}
                            <span className="ui-stack__file">
                              {frame.filename}
                              {frame.lineNo !== null ? `:${frame.lineNo}` : ""}
                              {frame.colNo !== null ? `:${frame.colNo}` : ""}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  </FormSection>
                ))
              )}
            </div>
          )}
        </div>
      </div>
      <ConnectProjectSheet workspace={workspace} open={connecting} onClose={() => setConnecting(false)} />
    </section>
  );
}
