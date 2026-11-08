/**
 * UI-20 ac2: every message in src/i18n/es.ts is used. A key counts as used when its literal
 * ("run.cancel") appears in a source file, or when it starts with the prefix of a key built at
 * run time (`run.file.${kind}`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { es } from "../src/i18n/es.ts";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sources(): string {
  return readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !file.startsWith(join(SRC, "i18n")))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

export function unusedKeys(keys: readonly string[], code: string): string[] {
  const prefixes = [...code.matchAll(/`([a-zA-Z][\w.-]*\.)\$\{/g)].map((m) => m[1] as string);
  return keys.filter(
    (key) => !code.includes(`"${key}"`) && !prefixes.some((prefix) => key.startsWith(prefix)),
  );
}

describe("i18n keys", () => {
  it("the checker sees literal and dynamic uses", () => {
    const code = `const a = t("a.b"); const c = t(\`run.file.$\{kind}\`);`;
    expect(unusedKeys(["a.b", "run.file.diff", "gone"], code)).toEqual(["gone"]);
  });

  it("every message is used somewhere in src/", () => {
    expect(unusedKeys(Object.keys(es), sources()), "remove these from src/i18n/es.ts").toEqual([]);
  });
});
