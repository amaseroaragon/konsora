/**
 * Design tokens for the "Plano" direction (UI-04).
 *
 * Single source of truth: `scripts/gen-tokens.ts` turns these objects into
 * `tokens.css` (CSS custom properties prefixed `--k-`), and
 * `test/tokens.test.ts` checks WCAG contrast for every pair in `contrastPairs`.
 */

export const colorNames = [
  "bg",
  "surface",
  "surface-sunken",
  "grid",
  "line",
  "line-strong",
  "ink",
  "ink-muted",
  "accent",
  "accent-hover",
  "accent-ink",
  "accent-soft",
  "accent-soft-ink",
  "focus",
  "proposed",
  "proposed-soft",
  "proposed-ink",
  "done",
  "done-soft",
  "done-ink",
  "warn-soft",
  "warn-ink",
  "danger",
  "danger-soft",
  "danger-ink",
  "neutral-soft",
  "neutral-ink",
  "diff-add-bg",
  "diff-add-ink",
  "diff-del-bg",
  "diff-del-ink",
] as const;

export type ColorName = (typeof colorNames)[number];
export type Palette = Record<ColorName, string>;

/** Light: white paper, ink hairlines, ink-blue accent. */
export const light: Palette = {
  bg: "#F4F5F7",
  surface: "#FFFFFF",
  "surface-sunken": "#F4F5F7",
  grid: "#E3E6EB",
  line: "#D5D9E0",
  "line-strong": "#121722",
  ink: "#121722",
  "ink-muted": "#525B6B",
  accent: "#1F3BD6",
  "accent-hover": "#172FB0",
  "accent-ink": "#FFFFFF",
  "accent-soft": "#E6EBFF",
  "accent-soft-ink": "#1A33B8",
  focus: "#1F3BD6",
  proposed: "#7A4FD6",
  "proposed-soft": "#F1EBFF",
  "proposed-ink": "#5B33B8",
  done: "#0B7A4B",
  "done-soft": "#E2F4EA",
  "done-ink": "#0A6640",
  "warn-soft": "#FFF1D6",
  "warn-ink": "#7A4E00",
  danger: "#B42318",
  "danger-soft": "#FBE4E4",
  "danger-ink": "#8A1C1C",
  "neutral-soft": "#ECEEF2",
  "neutral-ink": "#3D4554",
  "diff-add-bg": "#E2F4EA",
  "diff-add-ink": "#0A4F31",
  "diff-del-bg": "#FBE4E4",
  "diff-del-ink": "#8A1C1C",
};

/** Dark: the same drawing on ink-blue paper; hairlines become light. */
export const dark: Palette = {
  bg: "#0B1019",
  surface: "#111826",
  "surface-sunken": "#0B1019",
  grid: "#172033",
  line: "#253046",
  "line-strong": "#7D8BA6",
  ink: "#E7ECF5",
  "ink-muted": "#A3AEC2",
  accent: "#8095FF",
  "accent-hover": "#9DADFF",
  "accent-ink": "#0B1019",
  "accent-soft": "#1C2752",
  "accent-soft-ink": "#B7C3FF",
  focus: "#9DADFF",
  proposed: "#A98BF0",
  "proposed-soft": "#271D47",
  "proposed-ink": "#CDBBFF",
  done: "#4CC98D",
  "done-soft": "#0F2E20",
  "done-ink": "#7FE0AF",
  "warn-soft": "#33260F",
  "warn-ink": "#F2C46B",
  danger: "#FF7A70",
  "danger-soft": "#3A1717",
  "danger-ink": "#FFA9A3",
  "neutral-soft": "#1B2333",
  "neutral-ink": "#C3CBDA",
  "diff-add-bg": "#0F2E20",
  "diff-add-ink": "#9BE8C1",
  "diff-del-bg": "#3A1717",
  "diff-del-ink": "#FFB8B3",
};

export const themes = { light, dark } as const;
export type ThemeName = keyof typeof themes;

export const font = {
  sans: "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
} as const;

/** Type scale in px; `label` is the mono uppercase caption used across Plano. */
export const text = {
  label: "11px",
  xs: "12px",
  sm: "13px",
  md: "14px",
  lg: "16px",
  xl: "21px",
  "2xl": "28px",
} as const;

export const weight = { regular: "400", medium: "500", semibold: "600" } as const;

export const space = {
  "0": "0",
  "1": "2px",
  "2": "4px",
  "3": "6px",
  "4": "8px",
  "5": "10px",
  "6": "12px",
  "7": "16px",
  "8": "20px",
  "9": "24px",
  "10": "32px",
  "11": "48px",
} as const;

/** Plano is square on purpose; `xs` only softens inputs' inner focus. */
export const radius = { none: "0", xs: "2px" } as const;

export const size = {
  control: "36px",
  "control-sm": "28px",
  target: "44px",
  grid: "24px",
} as const;

export const motion = {
  fast: "120ms",
  base: "180ms",
  ease: "cubic-bezier(0.2, 0, 0, 1)",
} as const;

export type ContrastPair = {
  fg: ColorName;
  bg: ColorName;
  /** 4.5 for text, 3 for large text and non-text UI (borders, focus, icons). */
  min: 4.5 | 3;
  use: string;
};

/** Every foreground/background combination the components actually use. */
export const contrastPairs: readonly ContrastPair[] = [
  { fg: "ink", bg: "surface", min: 4.5, use: "body text on cards and panels" },
  { fg: "ink", bg: "bg", min: 4.5, use: "body text on the page" },
  { fg: "ink-muted", bg: "surface", min: 4.5, use: "secondary text and mono labels" },
  { fg: "ink-muted", bg: "bg", min: 4.5, use: "secondary text on the page" },
  { fg: "accent", bg: "surface", min: 4.5, use: "links and accent text" },
  { fg: "accent-ink", bg: "accent", min: 4.5, use: "primary button label" },
  { fg: "accent-ink", bg: "accent-hover", min: 4.5, use: "primary button label on hover" },
  { fg: "accent-soft-ink", bg: "accent-soft", min: 4.5, use: "review / ready badges" },
  { fg: "proposed-ink", bg: "proposed-soft", min: 4.5, use: "proposal badges" },
  { fg: "done-ink", bg: "done-soft", min: 4.5, use: "done / passing badges" },
  { fg: "warn-ink", bg: "warn-soft", min: 4.5, use: "waiting / warning badges" },
  { fg: "danger-ink", bg: "danger-soft", min: 4.5, use: "error badges and field errors" },
  { fg: "danger", bg: "surface", min: 4.5, use: "error text under fields" },
  { fg: "neutral-ink", bg: "neutral-soft", min: 4.5, use: "blocked / todo badges" },
  { fg: "ink-muted", bg: "neutral-soft", min: 4.5, use: "disabled controls" },
  { fg: "ink", bg: "accent-soft", min: 4.5, use: "card in review" },
  { fg: "ink-muted", bg: "accent-soft", min: 4.5, use: "meta text on a card in review" },
  { fg: "surface", bg: "ink", min: 4.5, use: "pressed segmented control" },
  { fg: "diff-add-ink", bg: "diff-add-bg", min: 4.5, use: "added diff lines" },
  { fg: "diff-del-ink", bg: "diff-del-bg", min: 4.5, use: "removed diff lines" },
  { fg: "line-strong", bg: "surface", min: 3, use: "card and control borders" },
  { fg: "focus", bg: "surface", min: 3, use: "focus ring" },
  { fg: "focus", bg: "bg", min: 3, use: "focus ring on the page" },
  { fg: "proposed", bg: "surface", min: 3, use: "proposal dashed border" },
  { fg: "done", bg: "surface", min: 3, use: "done state mark" },
];
