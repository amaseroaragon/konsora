import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTasksFile, serializeDocument, type Task, type TasksDocument } from "@konsora/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseBefore } from "../src/archive.ts";
import { EXIT, main } from "../src/main.ts";

const done = (id: string, when: string, deps?: string[]): Task => ({
  id,
  title: `Title ${id}`,
  state: "done",
  group: "BE",
  ...(deps ? { deps } : {}),
  rank: id.slice(-2),
  created: { at: "2026-10-01T09:00:00Z", by: "human" },
  updated_at: when,
  notes: [{ id: "n1", at: when, by: "agent:claude", kind: "summary", text: `Did ${id}` }],
});

function plan(): TasksDocument {
  return {
    schema: "konsora/5",
    project: { name: "P" },
    groups: [{ id: "BE", name: "Backend" }],
    seq: { BE: 4 },
    tasks: [
      done("BE-01", "2026-10-05T09:00:00Z"),
      done("BE-02", "2026-11-05T09:00:00Z", ["BE-01"]),
      {
        id: "BE-03",
        title: "Next",
        state: "todo",
        group: "BE",
        deps: ["BE-01"],
        rank: "03",
        created: { at: "2026-10-01T09:00:00Z", by: "human" },
        updated_at: "2026-10-01T09:00:00Z",
      },
    ],
  };
}

let dir: string;
const file = () => join(dir, ".konsora", "tasks.json");
const archiveFile = () => join(dir, ".konsora", "archive.json");
const doc = () => {
  const r = parseTasksFile(readFileSync(file(), "utf8"));
  if (!r.ok) throw new Error("invalid plan on disk");
  return r.document;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "konsora-archive-cli-"));
  mkdirSync(join(dir, ".konsora"));
  writeFileSync(file(), serializeDocument(plan()));
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
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

describe("konsora archive (CORE-18)", () => {
  it("without --write only shows what would move", async () => {
    const before = readFileSync(file(), "utf8");
    const r = await run(["archive", "--before", "2026-11-01"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain(
      "Archive preview: 1 done task(s) finished before 2026-11-01T00:00:00Z",
    );
    expect(r.stdout).toContain("BE-01");
    expect(r.stdout).toContain("Nothing was written.");
    expect(readFileSync(file(), "utf8")).toBe(before);
    expect(existsSync(archiveFile())).toBe(false);
  });

  it("--write moves them to .konsora/archive.json and the plan still passes check", async () => {
    const r = await run(["archive", "--before", "2026-11-01", "--write", "--json"]);
    expect(r.json()).toMatchObject({ ok: true, archived: true, moved: [{ id: "BE-01" }] });
    expect(doc().archived).toEqual(["BE-01"]);
    expect(doc().tasks.map((t) => t.id)).toEqual(["BE-02", "BE-03"]);
    expect((await run(["check"])).code).toBe(EXIT.ok);
    // The dependency on the archived task counts as done.
    expect((await run(["ready", "--json"])).json().map((t: Task) => t.id)).toEqual(["BE-03"]);
    // show still finds it, marked as archived; deps on it say so too.
    const shown = await run(["show", "BE-01"]);
    expect(shown.stdout).toContain("state: done (archived)");
    expect(shown.stdout).toContain("Did BE-01");
    expect((await run(["show", "be-01", "--json"])).json()).toMatchObject({
      id: "BE-01",
      archived: true,
    });
    expect((await run(["show", "BE-02"])).stdout).toContain("deps: BE-01 (done, archived)");
    // Its id is not reused.
    const created = await run(["propose", "New", "--group", "BE", "--as", "claude", "--json"]);
    expect(created.json().created).toEqual(["BE-05"]);
  });

  it("says so when nothing is old enough, and refuses a bad date", async () => {
    expect((await run(["archive", "--before", "2026-01-01", "--write"])).stdout).toBe(
      "No done tasks finished before 2026-01-01T00:00:00Z; nothing to archive.\n",
    );
    expect(existsSync(archiveFile())).toBe(false);
    const bad = await run(["archive", "--before", "yesterday"]);
    expect(bad.code).toBe(EXIT.usage);
    expect(bad.stderr).toContain('Invalid date "yesterday"');
  });

  it("an invalid archive file is reported, and nothing is written", async () => {
    writeFileSync(archiveFile(), "{}");
    const before = readFileSync(file(), "utf8");
    const r = await run(["archive", "--before", "2026-11-01", "--write"]);
    expect(r.code).toBe(EXIT.failure);
    expect(r.stderr).toContain("archive.json is invalid");
    expect(readFileSync(file(), "utf8")).toBe(before);
  });

  it("parses a day or a UTC timestamp", () => {
    expect(parseBefore("2026-11-01")).toBe("2026-11-01T00:00:00Z");
    expect(parseBefore("2026-11-01T12:30:00Z")).toBe("2026-11-01T12:30:00Z");
    expect(() => parseBefore("01/11/2026")).toThrow();
  });
});
