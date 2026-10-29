import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWindowChrome } from "./window";

function Chrome() {
  useWindowChrome();
  return null;
}

const root = document.documentElement;

afterEach(() => {
  vi.restoreAllMocks();
  root.removeAttribute("data-window-inactive");
});

describe("window chrome", () => {
  it("draws the window inactive when it opens behind another app", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    render(<Chrome />);
    expect(root.hasAttribute("data-window-inactive")).toBe(true);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(root.hasAttribute("data-window-inactive")).toBe(false);
  });

  it("draws the window active when it opens in front, until it loses focus", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(<Chrome />);
    expect(root.hasAttribute("data-window-inactive")).toBe(false);
    act(() => void window.dispatchEvent(new Event("blur")));
    expect(root.hasAttribute("data-window-inactive")).toBe(true);
  });
});
