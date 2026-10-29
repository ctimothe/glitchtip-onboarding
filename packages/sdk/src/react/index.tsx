import React, { createContext, useContext } from "react";

import type { Reporter } from "../shared/types.js";

export type { ReportContext, Reporter } from "../shared/types.js";

const ReporterContext = createContext<Reporter | null>(null);

export interface ObservabilityProviderProps {
  reporter: Reporter;
  children: React.ReactNode;
}

export function ObservabilityProvider({
  reporter,
  children,
}: ObservabilityProviderProps): React.ReactNode {
  return <ReporterContext.Provider value={reporter}>{children}</ReporterContext.Provider>;
}

export function useReporter(): Reporter {
  const reporter = useContext(ReporterContext);
  if (!reporter) {
    throw new Error("useReporter must be used inside ObservabilityProvider");
  }
  return reporter;
}

export interface ErrorBoundaryFallbackProps {
  error: Error;
  reset(): void;
}

export interface ObservabilityErrorBoundaryProps {
  children: React.ReactNode;
  fallback:
    | React.ReactNode
    | ((props: ErrorBoundaryFallbackProps) => React.ReactNode);
}

interface ObservabilityErrorBoundaryState {
  error: Error | null;
}

export class ObservabilityErrorBoundary extends React.Component<
  ObservabilityErrorBoundaryProps,
  ObservabilityErrorBoundaryState
> {
  static contextType = ReporterContext;

  declare context: React.ContextType<typeof ReporterContext>;

  state: ObservabilityErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ObservabilityErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.context?.reportError(error, {
      extra: { react_component_stack: info.componentStack ?? "" },
      tags: { framework: "react" },
    });
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    if (typeof this.props.fallback === "function") {
      return this.props.fallback({ error: this.state.error, reset: this.reset });
    }
    return this.props.fallback;
  }
}
