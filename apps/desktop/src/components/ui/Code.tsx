import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "./Button";
import { useUi } from "./locale";

/** Monospaced, selectable block for commands, file lists and log lines. */
export function CodeBlock({ lines, label }: { lines: string[]; label: string }) {
  return (
    <pre className="ui-code" aria-label={label} tabIndex={0}>
      {lines.join("\n")}
    </pre>
  );
}

/** Copies `text` to the clipboard and says so in place for a moment. */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const ui = useUi();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <Button
        variant="quiet"
        icon={copied ? Check : Copy}
        aria-label={label}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(
            () => setCopied(true),
            () => undefined,
          );
        }}
      >
        {ui(copied ? "ui.copied" : "ui.copy")}
      </Button>
      {/* A labelled button keeps its label, so the copy is announced here. */}
      <span role="status" className="sr-only">
        {copied ? ui("ui.copied") : ""}
      </span>
    </>
  );
}
