import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { TranslationKey } from "../../i18n";
import { useUi } from "./locale";

type Tone = "error" | "warning" | "info" | "success";

const TONES: Record<Tone, { icon: LucideIcon; key: TranslationKey }> = {
  error: { icon: XCircle, key: "ui.alert.error" },
  warning: { icon: AlertTriangle, key: "ui.alert.warning" },
  info: { icon: Info, key: "ui.alert.info" },
  success: { icon: CheckCircle2, key: "ui.alert.success" },
};

export function InlineAlert({
  tone,
  title,
  children,
  live = false,
}: {
  tone: Tone;
  title?: string;
  children?: ReactNode;
  live?: boolean;
}) {
  const ui = useUi();
  const { icon: Icon, key } = TONES[tone];
  return (
    <div role={live ? "alert" : "status"} className={`ui-alert ui-alert--${tone}`}>
      <span className="ui-alert__icon">
        <Icon aria-hidden="true" size={16} />
        <span className="sr-only">{ui(key)}</span>
      </span>
      <div className="ui-alert__body">
        {title ? <p className="ui-alert__title">{title}</p> : null}
        {children ? <div className={title ? "ui-alert__text" : undefined}>{children}</div> : null}
      </div>
    </div>
  );
}
