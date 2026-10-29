export type AlertSeverity = "error" | "warning" | "info";

const TEMPLATE: Record<AlertSeverity, { icon: string; label: string }> = {
  // Icons and labels mirror TEMPLATE in assets/relay/format.js lines 21-26.
  error: { icon: "🚨", label: "Error" },
  warning: { icon: "⚠️", label: "Warning" },
  info: { icon: "ℹ️", label: "Info" },
};

export function telegramHeader(project: string, env: string, severity: AlertSeverity, count: number | null): string {
  const template = TEMPLATE[severity];
  const impact = count != null ? ` · ${count}×` : "";
  return `${template.icon} <b>[${project}·${env}]</b>${impact} · ${template.label}`;
}
