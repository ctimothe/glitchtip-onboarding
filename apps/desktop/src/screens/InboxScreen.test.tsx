import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../lib/keychain", async (original) => ({
  ...(await original<typeof import("../lib/keychain")>()),
  secretGet: vi.fn(async () => "tok"),
}));
vi.mock("../lib/glitchtip", async (original) => ({
  ...(await original<typeof import("../lib/glitchtip")>()),
  latestEvent: vi.fn(),
  setIssueStatus: vi.fn(),
}));

import type { InboxState } from "../app/inbox-state";
import { createWorkspace } from "../app/workspace";
import * as glitchtip from "../lib/glitchtip";
import type { Issue } from "../lib/glitchtip";
import InboxScreen from "./InboxScreen";

function issue(id: string, patch: Partial<Issue> = {}): Issue {
  return {
    id,
    shortId: `WEB-${id}`,
    title: `Error ${id}`,
    culprit: "app/routes/case.ts in load",
    level: "error",
    status: "unresolved",
    count: 4,
    userCount: 2,
    firstSeen: "2026-10-29T08:00:00Z",
    lastSeen: "2026-10-29T10:00:00Z",
    project: { id: "1", slug: "web", name: "Acme web" },
    ...patch,
  };
}

const workspace = {
  ...createWorkspace({
    id: "ws-1",
    name: "Main",
    glitchtip: { baseUrl: "https://errors.example.com", organizationSlug: "acme", verifiedAt: "2026-10-29T00:00:00Z" },
  }),
  locale: "en" as const,
  onboarding: { completedAt: "2026-10-29T00:00:00Z", currentStage: 6 as const },
};

function inbox(issues: Issue[], patch: Partial<InboxState> = {}, polledAt = Date.now()): InboxState {
  return {
    sources: { primary: { status: "ok", issues, polledAt } },
    unread: 0,
    lastAlert: null,
    refresh: vi.fn(async () => {}),
    ...patch,
  };
}

const EVENT = {
  eventId: "e1",
  dateCreated: "2026-10-29T10:00:00Z",
  message: "",
  release: "1.4.0",
  tags: [],
  exceptions: [
    {
      type: "TypeError",
      value: "x is undefined",
      frames: [{ filename: "app/routes/case.ts", function: "load", lineNo: 42, colNo: 7, inApp: true }],
    },
  ],
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("inbox", () => {
  it("narrows the list to one project, and offers the filter only when there are several", async () => {
    vi.mocked(glitchtip.latestEvent).mockResolvedValue(EVENT);
    const api = issue("2", { project: { id: "2", slug: "api", name: "Acme API" }, lastSeen: "2026-10-29T11:00:00Z" });
    const { rerender } = render(<InboxScreen workspace={workspace} inbox={inbox([issue("1")])} />);
    expect(screen.queryByRole("combobox", { name: "Project" })).toBeNull();
    rerender(<InboxScreen workspace={workspace} inbox={inbox([issue("1"), api])} />);
    const titles = () =>
      within(screen.getByRole("listbox", { name: "Open errors" }))
        .getAllByRole("option")
        .map((option) => option.querySelector(".ui-option__title")?.textContent);
    expect(titles()).toEqual(["Error 2", "Error 1"]);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Project" }), "Acme web");
    expect(titles()).toEqual(["Error 1"]);
    // When the chosen project has nothing open any more, the whole inbox shows again.
    rerender(<InboxScreen workspace={workspace} inbox={inbox([api])} />);
    expect(titles()).toEqual(["Error 2"]);
  });

  it("lists open errors newest first and shows the first one's latest event", async () => {
    vi.mocked(glitchtip.latestEvent).mockResolvedValue(EVENT);
    render(
      <InboxScreen
        workspace={workspace}
        inbox={inbox([issue("1", { lastSeen: "2026-10-29T09:00:00Z" }), issue("2", { lastSeen: "2026-10-29T11:00:00Z" })])}
      />,
    );
    const options = within(screen.getByRole("listbox", { name: "Open errors" })).getAllByRole("option");
    expect(options.map((option) => option.querySelector(".ui-option__title")?.textContent)).toEqual(["Error 2", "Error 1"]);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("TypeError: x is undefined")).toBeTruthy();
    expect(glitchtip.latestEvent).toHaveBeenCalledWith("https://errors.example.com", "tok", "2");
    expect(screen.getByText("1.4.0")).toBeTruthy();
  });

  it("moves the selection with the arrow keys", async () => {
    vi.mocked(glitchtip.latestEvent).mockResolvedValue(EVENT);
    render(<InboxScreen workspace={workspace} inbox={inbox([issue("1"), issue("2", { lastSeen: "2026-10-29T09:00:00Z" })])} />);
    const [first, second] = screen.getAllByRole("option");
    first.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(second);
  });

  it("resolves the selected error, drops it and selects the next one", async () => {
    vi.mocked(glitchtip.latestEvent).mockResolvedValue(EVENT);
    vi.mocked(glitchtip.setIssueStatus).mockResolvedValue();
    render(<InboxScreen workspace={workspace} inbox={inbox([issue("1"), issue("2", { lastSeen: "2026-10-29T09:00:00Z" })])} />);
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(glitchtip.setIssueStatus).toHaveBeenCalledWith("https://errors.example.com", "tok", "acme", "1", "resolved");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(screen.getByRole("option").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Error 2" })).toBeTruthy();
  });

  it("keeps the error and says why when GlitchTip refuses the change", async () => {
    vi.mocked(glitchtip.latestEvent).mockResolvedValue(EVENT);
    vi.mocked(glitchtip.setIssueStatus).mockRejectedValue(new Error("PUT /api/0/organizations/acme/issues/1/ -> HTTP 403"));
    render(<InboxScreen workspace={workspace} inbox={inbox([issue("1")])} />);
    await userEvent.click(screen.getByRole("button", { name: "Ignore" }));
    expect(
      await screen.findByText("Couldn't change the error: PUT /api/0/organizations/acme/issues/1/ -> HTTP 403"),
    ).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("says when there is nothing open, and names a server it cannot reach", () => {
    render(
      <InboxScreen
        workspace={workspace}
        inbox={inbox([], {
          sources: { primary: { status: "error", error: "token-missing", issues: [], polledAt: Date.now() } },
        })}
      />,
    );
    expect(screen.getByText("No API token for errors.example.com")).toBeTruthy();
    expect(screen.getAllByText("No open errors").length).toBeGreaterThan(0);
  });

  it("offers the agent reference only for a project that is an application", async () => {
    vi.mocked(glitchtip.latestEvent).mockResolvedValue(EVENT);
    const withApp = {
      ...workspace,
      applications: [
        {
          id: "web-app",
          name: "Acme web",
          projectSlug: "web",
          environments: ["production"],
          topicId: 1,
          topicColor: 1,
          alertPreset: "balanced" as const,
          enabledStates: ["error" as const],
          repositoryPath: null,
          agent: null,
          verifiedAt: null,
        },
      ],
    };
    const { rerender } = render(<InboxScreen workspace={workspace} inbox={inbox([issue("1")])} />);
    expect(screen.queryByRole("button", { name: "Copy reference for the agent" })).toBeNull();
    rerender(<InboxScreen workspace={withApp} inbox={inbox([issue("1")])} />);
    expect(screen.getByRole("button", { name: "Copy reference for the agent" })).toBeTruthy();
  });

  it("shows an error resolved here again once a later poll finds it open after leaving the list", async () => {
    vi.mocked(glitchtip.latestEvent).mockResolvedValue(EVENT);
    vi.mocked(glitchtip.setIssueStatus).mockResolvedValue();
    const { rerender } = render(<InboxScreen workspace={workspace} inbox={inbox([issue("1"), issue("2")])} />);
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    // The poll that confirms it is gone, then one where it is back.
    rerender(<InboxScreen workspace={workspace} inbox={inbox([issue("2")])} />);
    rerender(<InboxScreen workspace={workspace} inbox={inbox([issue("1"), issue("2")])} />);
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("shows an error resolved here again when it is seen after that, even if no poll saw it gone", async () => {
    vi.mocked(glitchtip.latestEvent).mockResolvedValue(EVENT);
    vi.mocked(glitchtip.setIssueStatus).mockResolvedValue();
    const before = Date.now() - 1;
    const { rerender } = render(<InboxScreen workspace={workspace} inbox={inbox([issue("1"), issue("2")])} />);
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    // A poll that began before the resolve lists it as it was, even with an event newer than the
    // one on screen: it stays hidden.
    const newer = issue("1", { lastSeen: "2026-10-29T10:05:00Z" });
    rerender(<InboxScreen workspace={workspace} inbox={inbox([newer, issue("2")], {}, before)} />);
    expect(screen.getAllByRole("option")).toHaveLength(1);
    // The next poll still lists it: a new event reopened it in GlitchTip, so it shows.
    rerender(<InboxScreen workspace={workspace} inbox={inbox([newer, issue("2")])} />);
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("selects a notified error once, then leaves the selection to the owner", async () => {
    vi.mocked(glitchtip.latestEvent).mockResolvedValue(EVENT);
    const issues = [issue("1"), issue("2", { lastSeen: "2026-10-29T09:00:00Z" })];
    const { rerender } = render(<InboxScreen workspace={workspace} inbox={inbox(issues)} focusKey="primary:2" />);
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    await userEvent.click(screen.getAllByRole("option")[0]);
    rerender(<InboxScreen workspace={workspace} inbox={inbox([...issues])} focusKey="primary:2" />);
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
  });
});
