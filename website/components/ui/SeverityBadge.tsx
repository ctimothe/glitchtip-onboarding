import { severityColor } from "@/theme/tokens";

export function SeverityBadge({ severity }: { severity: "error" | "warning" | "info" }) {
  const label = severity === "error" ? "Error" : severity === "warning" ? "Warning" : "Info";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 px-2.5 py-0.5 font-mono text-xs"
      style={{ color: severityColor[severity] }}
    >
      <span aria-hidden style={{ background: severityColor[severity] }} className="inline-block size-1.5 rounded-full" />
      {label}
    </span>
  );
}
