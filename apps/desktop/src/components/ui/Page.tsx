import type { LucideIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

// One window pane: a unified toolbar (draggable, like a macOS title bar) over a
// scrolling, width-capped column. The toolbar hairline appears only once the
// content scrolls under it.
export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  const titleId = useId();
  const [scrolled, setScrolled] = useState(false);
  return (
    <section className="ui-page" aria-labelledby={titleId} data-scrolled={scrolled || undefined}>
      <header className="ui-toolbar" data-tauri-drag-region>
        <h1 id={titleId} className="ui-toolbar__title" data-tauri-drag-region>
          {title}
        </h1>
        {actions ? <div className="ui-toolbar__actions">{actions}</div> : null}
      </header>
      <div className="ui-page__scroll" onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}>
        <div className="ui-page__content">{children}</div>
      </div>
    </section>
  );
}

/** Content-unavailable view: an icon, a title, one line and at most one action. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="ui-empty" role="status">
      <Icon aria-hidden="true" size={40} strokeWidth={1.4} className="ui-empty__icon" />
      <p className="ui-empty__title">{title}</p>
      {description ? <p className="ui-empty__text">{description}</p> : null}
      {action ? <div className="ui-empty__action">{action}</div> : null}
    </div>
  );
}
