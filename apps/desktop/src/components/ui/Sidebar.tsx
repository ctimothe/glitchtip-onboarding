import type { LucideIcon } from "lucide-react";
import type { KeyboardEvent, ReactNode, Ref } from "react";

import { ServiceMark, type Product } from "./ServiceMark";

/** A titled group of sidebar items, like Favorites and Locations in Finder. */
export function SidebarSection({ heading, children }: { heading?: string; children: ReactNode }) {
  return (
    <div>
      {heading ? <p className="ui-sidebar__heading">{heading}</p> : null}
      <ul className="ui-sidebar__list">{children}</ul>
    </div>
  );
}

export function SidebarItem({
  label,
  icon,
  product,
  current = false,
  muted = false,
  onClick,
  onKeyDown,
  ref,
}: {
  label: string;
  icon?: LucideIcon;
  product?: Product;
  current?: boolean;
  /** Secondary actions (such as "Add application") read quieter than destinations. */
  muted?: boolean;
  onClick: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <li>
      <button
        type="button"
        ref={ref}
        aria-current={current ? "page" : undefined}
        onClick={onClick}
        onKeyDown={onKeyDown}
        className={muted ? "ui-sidebar-item ui-sidebar-item--muted" : "ui-sidebar-item"}
      >
        <span className="ui-sidebar-item__icon">
          <ServiceMark product={product} icon={icon} label={label} size={16} decorative />
        </span>
        {label}
      </button>
    </li>
  );
}
