import {
  colorNames,
  dark,
  font,
  light,
  motion,
  type Palette,
  radius,
  size,
  space,
  text,
  weight,
} from "./tokens.ts";

const HEADER = "/* Generated from src/theme/tokens.ts by scripts/gen-tokens.ts — do not edit. */\n";

function vars(prefix: string, values: Record<string, string>, indent: string): string {
  return Object.entries(values)
    .map(([key, value]) => `${indent}--k-${prefix}${key}: ${value};`)
    .join("\n");
}

function palette(p: Palette, indent: string): string {
  return colorNames.map((name) => `${indent}--k-${name}: ${p[name]};`).join("\n");
}

/** Builds the full tokens stylesheet: static scales plus light/dark palettes. */
export function tokensCss(): string {
  const i = "  ";
  const scales = [
    vars("font-", font, i),
    vars("text-", text, i),
    vars("weight-", weight, i),
    vars("space-", space, i),
    vars("radius-", radius, i),
    vars("size-", size, i),
    vars("motion-", motion, i),
  ].join("\n");
  return `${HEADER}
:root {
${scales}
${i}color-scheme: light;
${palette(light, i)}
}

@media (prefers-color-scheme: dark) {
${i}:root:not([data-theme="light"]) {
${i}${i}color-scheme: dark;
${palette(dark, i + i)}
${i}}
}

:root[data-theme="dark"] {
${i}color-scheme: dark;
${palette(dark, i)}
}

@media (prefers-reduced-motion: reduce) {
${i}:root {
${i}${i}--k-motion-fast: 0ms;
${i}${i}--k-motion-base: 0ms;
${i}}
}
`;
}
