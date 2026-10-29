export const colors = {
  void: "#05070D",
  abyss: "#0A0F1E",
  error: "#F04452",
  warning: "#F5A524",
  info: "#3B82F6",
  delivered: "#10B981",
  ink: "#F4F6FB",
  muted: "#9AA4B2",
  faint: "#5B6472",
} as const;

export type ColorName = keyof typeof colors;

export const severityColor: Record<"error" | "warning" | "info", string> = {
  error: colors.error,
  warning: colors.warning,
  info: colors.info,
};

export const fonts = {
  display: '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
  body: '"Inter", ui-sans-serif, system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
} as const;

export const radii = { panel: 16, pill: 999, code: 12 } as const;

export const motion = { revealMs: [160, 240] as const, ease: "easeOut" as const } as const;

export const windowChrome = {
  close: "#FF5F57",
  minimize: "#FEBC2E",
  zoom: "#28C840",
} as const;
