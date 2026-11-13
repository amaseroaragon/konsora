import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemePicker } from "../src/shell/ThemePicker.tsx";
import {
  initialThemeChoice,
  readThemeChoice,
  THEME_KEY,
  writeThemeChoice,
} from "../src/theme/apply.ts";

const memory = (initial: Record<string, string> = {}) => {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
};

/** Runs public/theme.js as the browser would, before the app, and returns the theme it set. */
function prePaint(search: string, stored: string | null, storageThrows = false): string | null {
  const attributes = new Map<string, string>();
  runInNewContext(readFileSync(new URL("../public/theme.js", import.meta.url), "utf8"), {
    URLSearchParams,
    window: {
      location: { search },
      get localStorage() {
        if (storageThrows) throw new Error("blocked");
        return { getItem: (k: string) => (k === "konsora.theme" ? stored : null) };
      },
    },
    document: { documentElement: { setAttribute: (k: string, v: string) => attributes.set(k, v) } },
  });
  return attributes.get("data-theme") ?? null;
}

describe("theme picker (UI-30)", () => {
  it("offers light, dark and system in the header", () => {
    const html = renderToStaticMarkup(<ThemePicker initial="dark" />);
    expect(html).toContain('aria-label="Tema"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Oscuro</);
    for (const label of ["Claro", "Oscuro", "Sistema"]) expect(html).toContain(`>${label}<`);
  });

  it("remembers the choice; system forgets it", () => {
    const storage = memory();
    writeThemeChoice("dark", storage);
    expect(storage.store.get(THEME_KEY)).toBe("dark");
    expect(readThemeChoice(storage)).toBe("dark");
    expect(initialThemeChoice("", storage)).toBe("dark");
    writeThemeChoice("system", storage);
    expect(storage.store.has(THEME_KEY)).toBe(false);
    expect(readThemeChoice(storage)).toBe("system");
    expect(readThemeChoice(memory({ [THEME_KEY]: "neon" }))).toBe("system");
  });

  it("?theme= in the URL still wins, for screenshots", () => {
    expect(initialThemeChoice("?theme=light", memory({ [THEME_KEY]: "dark" }))).toBe("light");
  });

  it("the pre-paint script applies the remembered theme before the app loads", () => {
    expect(prePaint("", "dark")).toBe("dark");
    expect(prePaint("", "light")).toBe("light");
    expect(prePaint("", null)).toBeNull();
    expect(prePaint("?theme=light", "dark")).toBe("light");
    expect(prePaint("", "neon")).toBeNull();
    expect(prePaint("", "dark", true)).toBeNull();
  });

  it("index.html loads it in <head>, as a same-origin script the CSP allows", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain('<script src="/theme.js"></script>');
  });
});
