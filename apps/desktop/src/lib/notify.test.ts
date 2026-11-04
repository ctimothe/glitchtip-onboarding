import { describe, expect, it } from "vitest";

import type { Issue } from "./glitchtip";
import { notificationText } from "./notify";

const ISSUE = { title: "TypeError: x is undefined" } as Issue;

describe("notificationText", () => {
  it("names the project and shows the error for a single new one", () => {
    expect(
      notificationText({ sourceId: "primary", projectName: "storefront", kind: "new", count: 1, issue: ISSUE }, "en"),
    ).toEqual({ title: "New error in storefront", body: "TypeError: x is undefined" });
  });

  it("counts several and shows the newest", () => {
    expect(
      notificationText({ sourceId: "primary", projectName: "storefront", kind: "regression", count: 3, issue: ISSUE }, "ru"),
    ).toEqual({ title: "Вернулось ошибок в storefront: 3", body: "TypeError: x is undefined" });
  });

  it("speaks Uzbek by default", () => {
    expect(
      notificationText({ sourceId: "primary", projectName: "storefront", kind: "new", count: 2, issue: ISSUE }, "uz").title,
    ).toBe("storefront: 2 ta yangi xato");
  });
});
