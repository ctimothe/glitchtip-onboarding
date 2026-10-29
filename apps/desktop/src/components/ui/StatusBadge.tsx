import { AlertTriangle, CheckCircle2, Circle, Clock, XCircle, type LucideIcon } from "lucide-react";

export type Status = "ok" | "warning" | "error" | "pending" | "unknown";

// Each status has its own glyph shape as well as a colour and the label text.
const ICONS: Record<Status, LucideIcon> = {
  ok: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
  pending: Clock,
  unknown: Circle,
};

export function StatusBadge({ status, label }: { status: Status; label: string }) {
  const Icon = ICONS[status];
  return (
    <span data-status={status} className="ui-status">
      <span className={`ui-status__icon ui-status__icon--${status}`}>
        <Icon aria-hidden="true" size={14} />
      </span>
      {label}
    </span>
  );
}
