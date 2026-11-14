import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeDocument, type Task, type TasksDocument } from "@konsora/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, main } from "../src/main.ts";

const at = "2026-11-02T10:00:00Z";
const t = (id: string, state: Task["state"], deps: string[] = [], extra: Partial<Task> = {}) =>
  ({
    id,
    title: `Title ${id}`,
    state,
    group: id.split("-")[0] as string,
    ...(deps.length ? { deps } : {}),
    rank: "m",
    created: { at, by: "human" },
    updated_at: at,
    ...extra,
  }) satisfies Task;
const closed = (when: string, by: string, text: string, extra: Partial<Task> = {}) => ({
  notes: [{ id: "n1", at: when, by, kind: "summary" as const, text }],
  updated_at: when,
  ...extra,
});

function plan(): TasksDocument {
  return {
    schema: "konsora/5",
    project: { name: "Weather" },
    groups: [
      { id: "BE", name: "Backend" },
      { id: "FE", name: "Frontend" },
    ],
    seq: { BE: 5, FE: 3 },
    tasks: [
      t("BE-01", "done", [], closed("2026-11-01T09:00:00Z", "agent:claude", "Old work.")),
      t(
        "BE-02",
        "done",
        [],
        closed(
          "2026-11-04T09:00:00Z",
          "agent:codex",
          "Cached responses for 10 min.\n\n- TTL is configurable\n- Tests added",
          { commits: ["abc1234"], acceptance: [{ id: "ac1", text: "Fast" }] },
        ),
      ),
      t("FE-01", "done", [], closed("2026-11-05T12:00:00Z", "human", "Showed the cache age.")),
      t("FE-02", "done", [], { updated_at: "2026-11-06T08:00:00Z" }),
      t("BE-03", "doing", ["BE-02"], {
        events: [{ type: "start", at: "2026-11-06T10:00:00Z", by: "agent:claude" }],
        difficulty: "medium",
        acceptance: [
          { id: "ac1", text: "Retries on 503" },
          { id: "ac2", text: "Gives up after 3 tries" },
        ],
      }),
      t("BE-04", "todo", ["BE-03"]),
      t("FE-03", "todo", ["BE-02"], {
        notes: [{ id: "n1", at, by: "agent:claude", kind: "question", text: "Which unit?" }],
      }),
      t("BE-05", "proposed"),
    ],
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "konsora-export-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(doc: TasksDocument = plan()) {
  mkdirSync(join(dir, ".konsora"), { recursive: true });
  writeFileSync(join(dir, ".konsora", "tasks.json"), serializeDocument(doc));
}

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
  return { code, stdout, stderr };
}

describe("konsora export", () => {
  it("--done --since prints the closed tasks by group with id, title and summary", async () => {
    seed();
    const r = await run(["export", "--done", "--since", "2026-11-03"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toMatchSnapshot();
    expect(r.stdout).not.toContain("BE-01");
  });

  it("--done without --since includes everything, archived tasks too", async () => {
    seed();
    expect((await run(["archive", "--before", "2026-11-02", "--write"])).code).toBe(EXIT.ok);
    const r = await run(["export", "--done"]);
    expect(r.stdout).toMatch(/^# Weather: done\n\n4 tasks finished\./);
    expect(r.stdout).toContain("- **BE-01** Title BE-01 (2026-11-01, claude)\n  Old work.\n");
  });

  it("--pending prints what is left in dependency order", async () => {
    seed();
    const r = await run(["export", "--pending"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toMatchSnapshot();
    const order = [...r.stdout.matchAll(/\*\*(\w+-\d+)\*\*/g)].map((m) => m[1]);
    expect(order.indexOf("BE-03")).toBeLessThan(order.indexOf("BE-04"));
    expect(order).not.toContain("BE-05");
  });

  it("is deterministic and says so when there is nothing", async () => {
    seed();
    const first = await run(["export", "--done"]);
    expect((await run(["export", "--done"])).stdout).toBe(first.stdout);
    expect((await run(["export", "--done", "--since", "2026-12-01"])).stdout).toBe(
      "# Weather: done since 2026-12-01\n\nNo tasks were finished since then.\n",
    );
    seed({ ...plan(), tasks: [t("BE-01", "done")] });
    expect((await run(["export", "--pending"])).stdout).toBe(
      "# Weather: pending\n\nNothing left to do.\n",
    );
  });

  it("writes nothing unless --output, and never replaces a file without --force", async () => {
    seed();
    const before = readFileSync(join(dir, ".konsora", "tasks.json"), "utf8");
    const printed = await run(["export", "--pending"]);
    const r = await run(["export", "--pending", "--output", "pending.md"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toBe("Wrote pending.md.\n");
    expect(readFileSync(join(dir, "pending.md"), "utf8")).toBe(printed.stdout);
    writeFileSync(join(dir, "pending.md"), "mine");
    const refused = await run(["export", "--done", "--output", "pending.md"]);
    expect(refused.code).toBe(EXIT.failure);
    expect(refused.stderr).toContain("already exists; left it unchanged.");
    expect(readFileSync(join(dir, "pending.md"), "utf8")).toBe("mine");
    expect((await run(["export", "--done", "--output", "pending.md", "--force"])).code).toBe(
      EXIT.ok,
    );
    expect(readFileSync(join(dir, "pending.md"), "utf8")).toMatch(/^# Weather: done/);
    expect(readFileSync(join(dir, ".konsora", "tasks.json"), "utf8")).toBe(before);
    expect(existsSync(join(dir, `pending.md.konsora-${process.pid}.tmp`))).toBe(false);
  });

  it("rejects bad combinations of options", async () => {
    seed();
    for (const args of [
      [],
      ["--done", "--pending"],
      ["--pending", "--since", "2026-11-01"],
      ["--done", "--force"],
      ["--done", "--since", "soon"],
    ]) {
      const r = await run(["export", ...args]);
      expect(r.code, args.join(" ")).toBe(EXIT.usage);
    }
  });
});
