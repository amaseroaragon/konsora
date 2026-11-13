import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { completionLog } from "../src/history.ts";
import { parseOp } from "../src/op-schema.ts";
import { applyOp, type OpContext } from "../src/ops.ts";
import { type Task, type TasksDocument, validateStructure } from "../src/schema.ts";
import { parseTasksFile, validateDocument } from "../src/semantics.ts";
import { serializeDocument } from "../src/serialize.ts";

const at = "2026-11-02T10:00:00Z";
const agent: OpContext = { actor: "agent:claude", at };
const task = (extra: Partial<Task> = {}): Task => ({
  id: "BE-01",
  title: "Cache",
  state: "doing",
  group: "BE",
  rank: "a",
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});
const base = (t: Task = task()): TasksDocument => ({
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 1 },
  tasks: [t],
});
const finish = (commits: string[], doc = base()) =>
  applyOp(doc, { op: "finish", task: "BE-01", summary: "Hecho", commits }, agent);

describe("commits of a task (CORE-14)", () => {
  it("finish keeps the hashes, lowercased and without repeats", () => {
    const r = finish(["24476D1", "8b8e7df0123456789abcdef0123456789abcdef0", "24476d1"]);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.document.tasks[0]?.commits).toEqual([
      "24476d1",
      "8b8e7df0123456789abcdef0123456789abcdef0",
    ]);
    expect(completionLog(r.document)[0]?.commits).toEqual(r.document.tasks[0]?.commits);
  });

  it("a task reopened and finished again adds its new commits", () => {
    const r = finish(["abcdef1"], base(task({ commits: ["1234567"] })));
    expect(r.ok && r.document.tasks[0]?.commits).toEqual(["1234567", "abcdef1"]);
  });

  it("rejects what is not a hash of 7 to 40 hex characters, and changes nothing", () => {
    for (const bad of ["abc123", "x".repeat(7), "a".repeat(41), "main", "HEAD~1"]) {
      const r = finish([bad]);
      expect(!r.ok && r.error.code, bad).toBe("invalid");
    }
    expect(finish([]).ok).toBe(true);
  });

  it("validates, serializes after the notes and round-trips", () => {
    const r = finish(["abcdef1"]);
    if (!r.ok) throw new Error(r.error.message);
    const text = serializeDocument(r.document);
    const keys = Object.keys(JSON.parse(text).tasks[0]);
    expect(keys.indexOf("commits")).toBe(keys.indexOf("notes") + 1);
    const parsed = parseTasksFile(text);
    expect(parsed.ok && serializeDocument(parsed.document)).toBe(text);
    expect(validateStructure(base(task({ commits: ["ABCDEF1"] }))).ok).toBe(false);
    const twice = validateDocument(base(task({ commits: ["abcdef1", "abcdef1"] })));
    expect(!twice.ok && twice.issues[0]?.code).toBe("duplicate_commit");
    expect(parseOp({ op: "finish", task: "BE-01", summary: "s", commits: ["abcdef1"] }).ok).toBe(
      true,
    );
  });

  it("no Konsora source runs git", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const offenders: string[] = [];
    for (const pkg of readdirSync(root)) {
      const src = join(root, pkg, "src");
      let files: string[] = [];
      try {
        files = readdirSync(src, { recursive: true }) as string[];
      } catch {
        continue;
      }
      for (const file of files.filter((f) => /\.tsx?$/.test(f))) {
        const text = readFileSync(join(src, file), "utf8");
        if (/(spawn|exec|execFile|fork)(Sync)?\(\s*["'`]git["'`\s]/.test(text))
          offenders.push(`${pkg}/src/${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
