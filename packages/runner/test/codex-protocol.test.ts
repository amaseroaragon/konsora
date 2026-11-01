import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addExtensions, closure, protocolSubset } from "../scripts/codex-protocol.ts";

const generated = (files: Record<string, string>) => new Map(Object.entries(files));

const sample = generated({
  "ClientRequest.ts":
    'import type { A } from "./A";\nimport type { B } from "./v2/B";\nexport type ClientRequest = A | B;',
  "A.ts":
    'import type { JsonValue } from "./serde_json/JsonValue";\nexport type A = { v: JsonValue };\n',
  "Unused.ts": "export type Unused = string;\n",
  "index.ts":
    'export type { A } from "./A";\nexport type { Unused } from "./Unused";\nexport * as v2 from "./v2";\n',
  "serde_json/JsonValue.ts": "export type JsonValue = number | string;\n",
  "v2/B.ts": 'import type { A } from "../A";\nexport type B = { a: A };\n',
  "v2/index.ts": 'export type { B } from "./B";\n',
});

describe("codex protocol subset", () => {
  it("keeps only what the roots reach", () => {
    expect(closure(sample, ["ClientRequest"])).toEqual([
      "A.ts",
      "ClientRequest.ts",
      "serde_json/JsonValue.ts",
      "v2/B.ts",
    ]);
  });

  it("fails on a missing root or import", () => {
    expect(() => closure(sample, ["Nope"])).toThrow(/Nope\.ts/);
    expect(() => closure(generated({ "X.ts": 'import type { Y } from "./Y";\n' }), ["X"])).toThrow(
      /Y\.ts/,
    );
  });

  it("adds .ts to relative imports only", () => {
    expect(
      addExtensions(
        'import type { A } from "../A";\nimport type { B } from "./B.ts";\nimport x from "zod";',
      ),
    ).toBe(
      'import type { A } from "../A.ts";\nimport type { B } from "./B.ts";\nimport x from "zod";',
    );
  });

  it("writes the kept types, their own indexes and the version, deterministically", () => {
    const out = protocolSubset(sample, "0.166.0", ["ClientRequest"]);
    expect([...out.keys()]).toEqual([
      "A.ts",
      "ClientRequest.ts",
      "index.ts",
      "serde_json/JsonValue.ts",
      "serde_json/index.ts",
      "v2/B.ts",
      "v2/index.ts",
      "version.ts",
    ]);
    expect(out.get("v2/B.ts")).toBe(
      'import type { A } from "../A.ts";\nexport type B = { a: A };\n',
    );
    expect(out.get("ClientRequest.ts")?.endsWith("A | B;\n")).toBe(true);
    const root = out.get("index.ts") as string;
    expect(root).toContain('export type { A } from "./A.ts";');
    expect(root).not.toContain("Unused");
    expect(root).toContain('export type * as v2 from "./v2/index.ts";');
    expect(root).toContain('export type * as serde_json from "./serde_json/index.ts";');
    expect(out.get("version.ts")).toContain('CODEX_PROTOCOL_VERSION = "0.166.0"');
    expect(protocolSubset(sample, "0.166.0", ["ClientRequest"])).toEqual(out);
    expect(() => protocolSubset(sample, "latest", ["ClientRequest"])).toThrow(/version/);
  });

  it("the committed folder is self-contained: every relative import resolves to a kept file", () => {
    const dir = fileURLToPath(new URL("../src/codex/protocol/", import.meta.url));
    const files = new Map<string, string>();
    const walk = (folder: string) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) walk(path);
        else files.set(relative(dir, path), readFileSync(path, "utf8"));
      }
    };
    walk(dir);
    for (const [path, text] of files) {
      for (const [, specifier] of text.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
        expect(specifier, `${path}: ${specifier}`).toMatch(/\.ts$/);
        const target = join(path, "..", specifier as string);
        expect(files.has(target), `${path} → ${target}`).toBe(true);
      }
    }
    expect(files.get("version.ts")).toMatch(/CODEX_PROTOCOL_VERSION = "\d+\.\d+\.\d+"/);
  });
});
