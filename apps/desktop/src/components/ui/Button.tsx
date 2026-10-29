import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useUi } from "./locale";

// macOS push buttons: one accent "default" button per view, regular buttons
// for everything else, red text (never a red fill) for destructive actions.
export type ButtonVariant = "primary" | "secondary" | "destructive" | "quiet" | "toolbar";

export function Button({
  variant = "primary",
  size = "regular",
  icon: Icon,
  pending = false,
  disabled = false,
  type = "button",
  onClick,
  children,
  title,
  "aria-label": ariaLabel,
}: {
  variant?: ButtonVariant;
  size?: "regular" | "large";
  icon?: LucideIcon;
  pending?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
  onClick?: () => void;
  children?: ReactNode;
  title?: string;
  "aria-label"?: string;
}) {
  const ui = useUi();
  const inactive = disabled || pending;
  const iconOnly = children === undefined || children === null;
  const className = [
    "ui-button",
    `ui-button--${variant}`,
    size === "large" ? "ui-button--large" : "",
    iconOnly ? "ui-button--icon" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type={type}
      disabled={inactive}
      aria-busy={pending || undefined}
      aria-label={ariaLabel}
      title={title}
      onClick={onClick}
      className={className}
    >
      {pending ? (
        <span aria-hidden="true" className="ui-spinner" />
      ) : Icon ? (
        <Icon aria-hidden="true" size={iconOnly ? 16 : 14} />
      ) : null}
      {pending ? <span className="sr-only">{ui("ui.button.pending")}</span> : null}
      {children}
    </button>
  );
}
