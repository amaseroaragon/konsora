/**
 * UI-08: no native dialog is left in src/. `window.confirm`, `alert` and `prompt` block the page
 * and do not follow Plano, so questions use Konsora's own dialog (`askConfirm`) instead.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** `window.confirm`, or a bare `confirm(` / `alert(` / `prompt(` call (not `confirmDelete(`). */
const NATIVE =
  /\b(?:window\s*\.\s*)?(?:confirm|alert|prompt)\s*\(|\bwindow\s*\.\s*(?:confirm|alert|prompt)\b/g;

function nativeDialogUses(code: string): string[] {
  return [...code.matchAll(NATIVE)].map((match) => match[0]);
}

function sources(): { file: string; code: string }[] {
  return readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .map((file) => ({ file: file.slice(SRC.length + 1), code: readFileSync(file, "utf8") }));
}

describe("native dialogs (UI-08)", () => {
  it("the detector sees the native calls and ignores the app's own names", () => {
    expect(nativeDialogUses("if (!window.confirm(q)) return;")).toEqual(["window.confirm("]);
    expect(nativeDialogUses("alert('x'); prompt(q); confirm(q);")).toEqual([
      "alert(",
      "prompt(",
      "confirm(",
    ]);
    expect(
      nativeDialogUses(
        'confirmDelete(ids, deps, askConfirm); t("external.revert.confirm", { id }); confirmUnlink(n, ask)',
      ),
    ).toEqual([]);
  });

  it("no file under packages/web/src calls window.confirm, alert or prompt", () => {
    const found = sources().flatMap(({ file, code }) =>
      nativeDialogUses(code).map((use) => `${file}: ${use}`),
    );
    expect(found, "use askConfirm from src/ui instead").toEqual([]);
  });
});
