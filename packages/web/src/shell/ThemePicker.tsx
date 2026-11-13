import { useState } from "react";
import { type MessageKey, t } from "../i18n/index.ts";
import {
  applyTheme,
  initialThemeChoice,
  THEME_CHOICES,
  type ThemeChoice,
  writeThemeChoice,
} from "../theme/apply.ts";
import { Segmented } from "../ui/index.ts";

const LABEL: Record<ThemeChoice, MessageKey> = {
  light: "theme.light",
  dark: "theme.dark",
  system: "theme.system",
};

/**
 * Light, dark or the system's theme (UI-30): applied at once, without reloading, and remembered in
 * this browser (public/theme.js applies it before the next first paint).
 */
export function ThemePicker({ initial }: { initial?: ThemeChoice }) {
  const [choice, setChoice] = useState<ThemeChoice>(
    () => initial ?? (typeof window === "undefined" ? "system" : initialThemeChoice()),
  );
  return (
    <Segmented
      label={t("theme.label")}
      value={choice}
      options={THEME_CHOICES.map((value) => ({ value, label: t(LABEL[value]) }))}
      onChange={(value) => {
        const next = (THEME_CHOICES as readonly string[]).includes(value)
          ? (value as ThemeChoice)
          : "system";
        setChoice(next);
        applyTheme(next);
        writeThemeChoice(next);
      }}
    />
  );
}
