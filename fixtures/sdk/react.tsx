import {
  ObservabilityErrorBoundary,
  ObservabilityProvider,
  useReporter,
  type Reporter,
} from "@glitchtip-onboarding/sdk/react";

declare const reporter: Reporter;

function Consumer() {
  useReporter().reportInfo("fixture rendered");
  return <p>ready</p>;
}

export function FixtureApp() {
  return (
    <ObservabilityProvider reporter={reporter}>
      <ObservabilityErrorBoundary fallback={<p>failed</p>}>
        <Consumer />
      </ObservabilityErrorBoundary>
    </ObservabilityProvider>
  );
}
