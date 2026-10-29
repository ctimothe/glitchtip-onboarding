import { Check } from "lucide-react";

export type StepState = "done" | "current" | "todo";

/** Installer-style progress list: a check for finished steps, a dot for the current one. */
export function Steps({
  label,
  steps,
  orientation = "vertical",
}: {
  label: string;
  steps: Array<{ key: string; label: string; state: StepState; statusLabel: string }>;
  orientation?: "vertical" | "horizontal";
}) {
  return (
    <ol aria-label={label} className={orientation === "horizontal" ? "ui-steps ui-steps--horizontal" : "ui-steps"}>
      {steps.map((step) => (
        <li
          key={step.key}
          data-state={step.state}
          aria-current={step.state === "current" ? "step" : undefined}
          className="ui-step"
        >
          <span className="ui-step__marker" aria-hidden="true">
            {step.state === "done" ? <Check size={10} strokeWidth={3.5} /> : null}
          </span>
          <span>{step.label}</span>
          <span className="sr-only">{step.statusLabel}</span>
        </li>
      ))}
    </ol>
  );
}
