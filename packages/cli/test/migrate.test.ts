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

  it("--write backs up the original, saves history and writes a valid current plan", async () => {
    const r = await run(["migrate", "--write"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("Migrated .konsora/tasks.json");
    expect(readFileSync(k("tasks.v1.json.bak"), "utf8")).toBe(legacy);
    expect(JSON.parse(readFileSync(k("legacy", "v1-history.json"), "utf8"))).toMatchObject({
      attempts: [],
      activity: [],
      reviews: [],
    });
    const v3 = parseTasksFile(readFileSync(k("tasks.json"), "utf8"));
    expect(v3.ok && v3.document.project).toEqual({ name: dir.split("/").pop() });
    expect((await run(["status", "--json"])).json()).toMatchObject({
      tasks: 29,
      byState: { done: 4, todo: 25 },
    });
    expect((await run(["migrate"])).stdout).toBe("Already konsora/5; nothing to migrate.\n");
  });

  it("refuses to overwrite an existing backup", async () => {
    writeFileSync(k("tasks.v1.json.bak"), "previous");
    const r = await run(["migrate", "--write"]);
    expect(r.code).toBe(EXIT.failure);
    expect(r.stderr).toContain("already exists");
    expect(readFileSync(k("tasks.json"), "utf8")).toBe(legacy);
  });

  it("rejects files that are neither v1, v2, v3 nor v4", async () => {
    writeFileSync(k("tasks.json"), JSON.stringify({ hello: "world" }));
    expect((await run(["migrate"])).stderr).toContain(
      "neither konsora/5, konsora/4, konsora/3, konsora/2 nor v1",
    );
  });

  it("migrates a konsora/2 plan: preview lists the dropped fields, --write backs it up", async () => {
    const at = "2026-11-02T10:00:00Z";
    const v2 = `${JSON.stringify({
      schema: "konsora/2",
      project: { name: "P", base_branch: "main", checks: [{ id: "t", run: "npm test" }] },
      groups: [{ id: "BE", name: "Backend" }],
      seq: { BE: 1 },
      tasks: [
        {
          id: "BE-01",
          title: "T",
          state: "todo",
          group: "BE",
          rank: "a",
          difficulty: "low",
          created: { at, by: "human" },
          updated_at: at,
        },
      ],
    })}\n`;
    writeFileSync(k("tasks.json"), v2);
    const preview = await run(["migrate"]);
    expect(preview.code).toBe(EXIT.ok);
    expect(preview.stdout).toContain("konsora/2 → konsora/5, 1 tasks");
    expect(preview.stdout).toMatch(/project\.checks +1/);
    expect(preview.stdout).toMatch(/tasks\[\]\.difficulty +1/);
    expect(readFileSync(k("tasks.json"), "utf8")).toBe(v2);
    const r = await run(["migrate", "--write"]);
    expect(r.code).toBe(EXIT.ok);
    expect(readFileSync(k("tasks.v2.json.bak"), "utf8")).toBe(v2);
    const v3 = parseTasksFile(readFileSync(k("tasks.json"), "utf8"));
    expect(v3.ok && v3.document.project).toEqual({ name: "P" });
    expect(readdirSync(k()).sort()).toEqual(["tasks.json", "tasks.v2.json.bak"]);
  });

  it("migrates a konsora/4 plan with blocks: lists the blocks it removes and their branches", async () => {
    const at = "2026-11-02T10:00:00Z";
    const v4 = `${JSON.stringify({
      schema: "konsora/4",
      project: { name: "P" },
      groups: [{ id: "BE", name: "Backend" }],
      seq: { BE: 1 },
      blocks: [
        {
          id: "cache",
          name: "Cache",
          branch: "konsora/cache",
          base: "main",
          created: { at, by: "human" },
        },
      ],
      tasks: [
        {
          id: "BE-01",
          title: "T",
          state: "todo",
          group: "BE",
          rank: "a",
          block: "cache",
          created: { at, by: "human" },
          updated_at: at,
        },
      ],
    })}\n`;
    writeFileSync(k("tasks.json"), v4);
    const before = await run(["status"]);
    expect(before.code).not.toBe(EXIT.ok);
    expect(before.stderr).toContain("Hint: The plan is in an older format");
    const preview = await run(["migrate"]);
    expect(preview.stdout).toContain("konsora/4 → konsora/5, 1 tasks");
    expect(preview.stdout).toContain("Blocks removed");
    expect(preview.stdout).toMatch(/cache +Cache {2}\[konsora\/cache, not merged\]/);
    expect((await run(["migrate", "--write"])).code).toBe(EXIT.ok);
    expect(readFileSync(k("tasks.v4.json.bak"), "utf8")).toBe(v4);
    const v5 = parseTasksFile(readFileSync(k("tasks.json"), "utf8"));
    expect(v5.ok && v5.document.tasks[0]).not.toHaveProperty("block");
    expect((await run(["status"])).code).toBe(EXIT.ok);
  });
});
