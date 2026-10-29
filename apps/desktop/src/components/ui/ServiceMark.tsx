import type { LucideIcon } from "lucide-react";

import anthropic from "../../assets/brands/anthropic.svg";
import glitchtip from "../../assets/brands/glitchtip.svg";
import openai from "../../assets/brands/openai.svg";
import telegram from "../../assets/brands/telegram.svg";

export type Product = "glitchtip" | "telegram" | "openai" | "anthropic";

// Bundled local assets only; see assets/brands/README.md for provenance.
export const PRODUCT_MARKS: Record<Product, string> = { glitchtip, telegram, openai, anthropic };

// Marks the vendor ships in black only.
const MONOCHROME: ReadonlySet<Product> = new Set(["openai"]);

// Share of the file's width the mark itself fills, where the official file
// carries its own clear space (the Blossom spans 366 of 716 units). The image
// is drawn larger so the mark, not the file, has the requested size.
const MARK_SHARE: Partial<Record<Product, number>> = { openai: 366 / 716 };

export function ServiceMark({
  product,
  icon: Icon,
  label,
  size = 20,
  decorative = false,
}: {
  product?: Product;
  icon?: LucideIcon;
  label: string;
  size?: number;
  /** True when visible text beside the mark already names it; the mark is then hidden from assistive tech. */
  decorative?: boolean;
}) {
  if (product) {
    const drawn = Math.round(size / (MARK_SHARE[product] ?? 1));
    return (
      <img
        className={MONOCHROME.has(product) ? "ui-mark ui-mark--mono" : "ui-mark"}
        src={PRODUCT_MARKS[product]}
        alt={decorative ? "" : label}
        aria-hidden={decorative || undefined}
        width={drawn}
        height={drawn}
        style={drawn === size ? undefined : { margin: (size - drawn) / 2 }}
      />
    );
  }
  if (Icon) {
    return decorative ? <Icon aria-hidden size={size} /> : <Icon role="img" aria-label={label} size={size} />;
  }
  return null;
}
