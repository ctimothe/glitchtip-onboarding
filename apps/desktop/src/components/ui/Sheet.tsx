import { useEffect, useId, useRef, type ReactNode } from "react";

import { Button } from "./Button";
import { useUi } from "./locale";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Return presses the default button from inside the sheet, as on macOS; on
// buttons, links, pop-ups and multi-line fields it keeps its own meaning. A
// destructive action is never the default button, so Return never fires it.
function returnConfirms(panel: HTMLElement | null, target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement) || !panel?.contains(target)) return false;
  return !["BUTTON", "TEXTAREA", "SELECT", "A"].includes(target.tagName);
}

export function Sheet({
  open,
  title,
  onClose,
  children,
  confirm,
  wide = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  confirm?: { label: string; destructive?: boolean; pending?: boolean; disabled?: boolean; onConfirm: () => void };
  wide?: boolean;
}) {
  const ui = useUi();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = panel.current;
    const items = () => Array.from(node?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    (items()[0] ?? node)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        // The action already started; closing would hide its outcome.
        if (!confirmRef.current?.pending) onCloseRef.current();
        return;
      }
      if (event.key === "Enter" && !event.isComposing) {
        const action = confirmRef.current;
        if (action && !action.destructive && !action.pending && !action.disabled && returnConfirms(node, event.target)) {
          event.preventDefault();
          action.onConfirm();
        }
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = items();
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !node?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !node?.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="ui-sheet-backdrop">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={wide ? "ui-sheet ui-sheet--wide" : "ui-sheet"}
      >
        <h2 id={titleId} className="ui-sheet__title">
          {title}
        </h2>
        <div className="ui-sheet__body">{children}</div>
        <div className="ui-sheet__actions">
          <Button variant="secondary" disabled={confirm?.pending} onClick={onClose}>
            {ui(confirm ? "action.cancel" : "ui.sheet.close")}
          </Button>
          {confirm ? (
            <Button
              variant={confirm.destructive ? "destructive" : "primary"}
              pending={confirm.pending}
              disabled={confirm.disabled}
              onClick={confirm.onConfirm}
            >
              {confirm.label}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
