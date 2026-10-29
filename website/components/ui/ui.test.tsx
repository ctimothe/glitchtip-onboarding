// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InstallPill } from "./InstallPill";
import { BeatSplit } from "./BeatSplit";
import { SeverityBadge } from "./SeverityBadge";
import { Tabs } from "./Tabs";
import { Terminal } from "./Terminal";

describe("ui primitives", () => {
  it("InstallPill shows the command and confirms copy", () => {
    render(<InstallPill command="npm install x" />);
    expect(screen.getByDisplayValue("npm install x")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(screen.getByRole("button", { name: /copied/i })).toBeInTheDocument();
  });

  it("Tabs switches panels on click with tablist semantics", () => {
    render(<Tabs tabs={[
      { id: "a", label: "Node", content: <p>node panel</p> },
      { id: "b", label: "React", content: <p>react panel</p> },
    ]} />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByText("node panel")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "React" }));
    expect(screen.getByText("react panel")).toBeVisible();
    expect(screen.queryByText("node panel")).not.toBeInTheDocument();
  });

  it("Terminal renders pass/fail markers in a log region", () => {
    render(<Terminal lines={[{ text: "[PASS] config", pass: true }, { text: "[FAIL] oops", pass: false }]} />);
    expect(screen.getByRole("log")).toBeInTheDocument();
    expect(screen.getByText("[PASS] config")).toBeInTheDocument();
  });

  it("SeverityBadge labels the error severity", () => {
    render(<SeverityBadge severity="error" />);
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("BeatSplit renders kicker, title, body, and panel", () => {
    render(
      <BeatSplit side="left" glow="error" kicker="01 · Capture" title="Capture" panel={<p>panel content</p>}>
        <p>body copy</p>
      </BeatSplit>,
    );
    expect(screen.getByText("01 · Capture")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Capture" })).toBeInTheDocument();
    expect(screen.getByText("body copy")).toBeInTheDocument();
    expect(screen.getByText("panel content")).toBeInTheDocument();
  });
});
