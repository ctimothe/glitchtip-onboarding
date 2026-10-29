"use client";

import { Component, type ReactNode } from "react";
import { StaticHero } from "./StaticHero";

export class SceneErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (this.state.failed) return <StaticHero />;
    return this.props.children;
  }
}
