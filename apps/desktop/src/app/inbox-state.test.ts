import { describe, expect, it } from "vitest";

import { issueKey } from "../lib/inbox";
import { notificationKey } from "../lib/notify";
import { parseIssueKey } from "./inbox-state";

describe("parseIssueKey", () => {
  it("reads back the server and issue an inbox key was made from", () => {
    expect(parseIssueKey(issueKey("primary", "42"))).toEqual({ sourceId: "primary", issueId: "42", connection: null });
    expect(parseIssueKey(issueKey("errors-example-org", "a:b"))).toEqual({
      sourceId: "errors-example-org",
      issueId: "a:b",
      connection: null,
    });
  });

  it("reads the connection a notification bound its key to", () => {
    expect(parseIssueKey(notificationKey("primary", "42", "2026-10-29T09:00:00Z"))).toEqual({
      sourceId: "primary",
      issueId: "42",
      connection: "2026-10-29T09:00:00Z",
    });
  });

  it("refuses anything that is not a key", () => {
    expect(parseIssueKey("")).toBeNull();
    expect(parseIssueKey("primary")).toBeNull();
    expect(parseIssueKey(":42")).toBeNull();
    expect(parseIssueKey("primary:")).toBeNull();
    expect(parseIssueKey("@2026-10-29T09:00:00Z")).toBeNull();
  });
});
