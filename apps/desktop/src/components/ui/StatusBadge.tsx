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

export type TagTone = "error" | "warning" | "neutral";

/** A one-word classification in a tinted capsule, with an optional plain-text explanation beside it. */
export function Tag({ tone, label, detail }: { tone: TagTone; label: string; detail?: string }) {
  return (
    <p className="ui-tag-line">
      <span className="ui-tag" data-tone={tone}>
        {label}
      </span>
      {detail ? <span className="ui-tag-line__detail">{detail}</span> : null}
    </p>
  );
}
