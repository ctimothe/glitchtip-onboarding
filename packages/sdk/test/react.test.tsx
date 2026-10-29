// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ObservabilityErrorBoundary,
  ObservabilityProvider,
  useReporter,
} from "../src/react/index.js";
import type { Reporter } from "../src/shared/types.js";

function createReporterSpy(): Reporter {
  return {
    reportError: vi.fn(() => "event-id"),
    reportWarning: vi.fn(),
    reportInfo: vi.fn(),
    flush: vi.fn(async () => true),
  };
}

describe("React observability", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("reports a render error and renders the supplied fallback", () => {
    const reporter = createReporterSpy();
    const Broken = (): React.ReactNode => {
      throw new Error("render failed");
    };

    render(
      <ObservabilityProvider reporter={reporter}>
        <ObservabilityErrorBoundary fallback={<p>Try again</p>}>
          <Broken />
        </ObservabilityErrorBoundary>
      </ObservabilityProvider>,
    );

    expect(screen.getByText("Try again")).toBeTruthy();
    expect(reporter.reportError).toHaveBeenCalledOnce();
    expect(reporter.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "render failed" }),
      {
        extra: { react_component_stack: expect.any(String) },
        tags: { framework: "react" },
      },
    );
  });

  it("provides the reporter through useReporter", () => {
    const reporter = createReporterSpy();
    const Consumer = (): React.ReactNode => {
      expect(useReporter()).toBe(reporter);
      return <p>ready</p>;
    };

    render(
      <ObservabilityProvider reporter={reporter}>
        <Consumer />
      </ObservabilityProvider>,
    );
    expect(screen.getByText("ready")).toBeTruthy();
  });

  it("throws a clear error when useReporter has no provider", () => {
    const Consumer = (): React.ReactNode => {
      useReporter();
      return null;
    };

    expect(() => render(<Consumer />)).toThrow(
      "useReporter must be used inside ObservabilityProvider",
    );
  });

  it("lets a fallback reset the boundary after application state changes", () => {
    const reporter = createReporterSpy();
    const Broken = ({ active }: { active: boolean }): React.ReactNode => {
      if (active) throw new Error("temporary failure");
      return <p>Recovered</p>;
    };
    const App = (): React.ReactNode => {
      const [broken, setBroken] = useState(true);
      return (
        <ObservabilityProvider reporter={reporter}>
          <ObservabilityErrorBoundary
            fallback={({ reset }) => (
              <button
                type="button"
                onClick={() => {
                  setBroken(false);
                  reset();
                }}
              >
                Reset
              </button>
            )}
          >
            <Broken active={broken} />
          </ObservabilityErrorBoundary>
        </ObservabilityProvider>
      );
    };

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByText("Recovered")).toBeTruthy();
  });
});
