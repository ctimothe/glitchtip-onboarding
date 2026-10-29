import { ChevronRight } from "lucide-react";
import { useId, type MouseEvent, type ReactNode } from "react";

import { RowLayout } from "./Field";

// System Settings-style grouped section: a bold title, an inset rounded box of
// rows separated by hairlines, and an optional footnote under it.
export function FormSection({
  title,
  footer,
  actions,
  children,
}: {
  title?: string;
  footer?: ReactNode;
  /** Small buttons shown at the trailing end of the title line. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className="ui-group" aria-labelledby={title ? titleId : undefined}>
      {title || actions ? (
        <div className="ui-group__header">
          {title ? (
            <h2 id={titleId} className="ui-group__title">
              {title}
            </h2>
          ) : (
            <span className="ui-group__title" />
          )}
          {actions}
        </div>
      ) : null}
      <div className="ui-group__body">
        <RowLayout.Provider value={true}>{children}</RowLayout.Provider>
      </div>
      {footer ? <p className="ui-group__footer">{footer}</p> : null}
    </section>
  );
}

/** Read-only label and value, as in an About pane. The value stays selectable. */
export function DetailRow({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="ui-row">
      <span className="ui-row__label">{label}</span>
      <span className={mono ? "ui-row__value ui-mono" : "ui-row__value"} data-selectable>
        {children}
      </span>
    </div>
  );
}

/** A list row with an optional leading mark, two lines of text and trailing content. */
// A text cut short shows in full on hover, and only then, as a macOS table cell does.
function showCutText(event: MouseEvent<HTMLElement>) {
  const node = event.currentTarget;
  const cut = node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight;
  node.title = cut ? (node.textContent ?? "") : "";
}

export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  onClick,
}: {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  /** Makes the whole row a navigation button with a disclosure chevron. */
  onClick?: () => void;
}) {
  const content = (
    <>
      {leading ? <span className="ui-row__leading">{leading}</span> : null}
      <span className="ui-row__text">
        <span className="ui-row__title" onMouseEnter={showCutText}>
          {title}
        </span>
        {subtitle ? (
          <span className="ui-row__subtitle" onMouseEnter={showCutText}>
            {subtitle}
          </span>
        ) : null}
      </span>
      {trailing ? <span className="ui-row__trailing">{trailing}</span> : null}
      {onClick ? <ChevronRight aria-hidden="true" size={14} className="ui-row__chevron" /> : null}
    </>
  );
  return onClick ? (
    <button type="button" className="ui-row ui-row--action" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className="ui-row">{content}</div>
  );
}

/** Free-form content inside a FormSection box (code, a code display, a note). */
export function BlockRow({ children }: { children: ReactNode }) {
  return <div className="ui-row ui-row--block">{children}</div>;
}
