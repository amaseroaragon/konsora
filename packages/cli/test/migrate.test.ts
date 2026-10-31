import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTasksFile } from "@konsora/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, main } from "../src/main.ts";

const legacy = readFileSync(
  new URL("../../core/test/fixtures/v1-legacy-tasks.json", import.meta.url),
  "utf8",
);
let dir: string;
const k = (...p: string[]) => join(dir, ".konsora", ...p);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "konsora-migrate-"));
  execFileSync("git", ["init", "-q", "-b", "trunk"], { cwd: dir });
  mkdirSync(k());
  writeFileSync(k("tasks.json"), legacy);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
    cwd: dir,
    env: {},
    now: () => new Date("2026-11-03T09:00:00Z"),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

describe("konsora migrate", () => {
  it("previews by default and never writes", async () => {
    const r = await run(["migrate"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("Migration preview for .konsora/tasks.json: 29 tasks, groups K");
    expect(r.stdout).toContain("pending     → todo     25");
    expect(r.stdout).toContain("Nothing was written.");
    expect(readFileSync(k("tasks.json"), "utf8")).toBe(legacy);
    expect(readdirSync(k())).toEqual(["tasks.json"]);
    expect((await run(["migrate", "--json"])).json()).toMatchObject({
      ok: true,
      migrated: false,
      report: { tasks: 29 },
    });
  });

  it("--write backs up the original, saves history and writes a valid v2 plan", async () => {
    const r = await run(["migrate", "--write"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("Migrated .konsora/tasks.json");
    expect(readFileSync(k("tasks.v1.json.bak"), "utf8")).toBe(legacy);
    expect(JSON.parse(readFileSync(k("legacy", "v1-history.json"), "utf8"))).toMatchObject({
      attempts: [],
      activity: [],
      reviews: [],
    });
    const v2 = parseTasksFile(readFileSync(k("tasks.json"), "utf8"));
    expect(v2.ok && v2.document.project).toEqual({
      name: dir.split("/").pop(),
      base_branch: "trunk",
    });
    expect((await run(["status", "--json"])).json()).toMatchObject({
      tasks: 29,
      byState: { done: 4, todo: 25 },
    });
    expect((await run(["migrate"])).stdout).toBe("Already konsora/2; nothing to migrate.\n");
  });

  it("refuses to overwrite an existing backup", async () => {
    writeFileSync(k("tasks.v1.json.bak"), "previous");
    const r = await run(["migrate", "--write"]);
    expect(r.code).toBe(EXIT.failure);
    expect(r.stderr).toContain("already exists");
    expect(readFileSync(k("tasks.json"), "utf8")).toBe(legacy);
  });

  it("rejects files that are neither v1 nor v2", async () => {
    writeFileSync(k("tasks.json"), JSON.stringify({ hello: "world" }));
    expect((await run(["migrate"])).stderr).toContain("neither konsora/2 nor v1");
  });
});
