import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunIdGenerator, type Run, type RunId } from "@konsora/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVENTS_FILE,
  RAW_FILE,
  RAW_ROTATED_FILE,
  RUN_FILE,
  RunStore,
  RunStoreError,
} from "../src/run-store.ts";

const nextId = createRunIdGenerator();
let root: string;
let store: RunStore;

function newRun(task = "BE-02", fields: Partial<Run> = {}): Run {
  return {
    id: nextId(),
    task,
    task_hash: `sha256:${"b".repeat(64)}`,
    agent: { provider: "claude", model: "opus", permissions: "default" },
    state: "queued",
    ...fields,
  };
}

async function rejection(promise: Promise<unknown>): Promise<RunStoreError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RunStoreError) return error;
    throw error;
  }
  throw new Error("expected a RunStoreError");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "konsora-runs-"));
  mkdirSync(join(root, ".konsora"));
  store = new RunStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("run.json", () => {
  it("creates a private run directory and reads the run back", async () => {
    const run = await store.create(newRun());
    expect(await store.read(run.id)).toEqual(run);
    expect(statSync(store.runDir(run.id)).mode & 0o777).toBe(0o700);
    expect(statSync(join(store.runDir(run.id), RUN_FILE)).mode & 0o777).toBe(0o600);
  });

  it("only creates queued runs and refuses duplicates", async () => {
    expect((await rejection(store.create(newRun("BE-02", { state: "running" })))).code).toBe(
      "invalid",
    );
    const run = await store.create(newRun("BE-02"));
    await store.transition(run.id, "cancelled");
    expect((await rejection(store.create({ ...run, state: "queued" }))).code).toBe("exists");
  });

  it("moves runs through valid transitions and rejects invalid ones without writing", async () => {
    const run = await store.create(newRun());
    await store.transition(run.id, "starting", {
      worktree: "/tmp/wt",
      branch: "konsora/BE-02/x",
      started_at: "2026-11-02T10:00:00Z",
    });
    await store.transition(run.id, "running", { session_id: "s-1" });
    const before = readFileSync(join(store.runDir(run.id), RUN_FILE), "utf8");
    const error = await rejection(store.transition(run.id, "succeeded"));
    expect(error.code).toBe("invalid_transition");
    expect(error.message).toMatch(/running to succeeded/);
    expect(readFileSync(join(store.runDir(run.id), RUN_FILE), "utf8")).toBe(before);
    await store.transition(run.id, "checking");
    await store.transition(run.id, "succeeded", { exit: { code: 0, signal: null } });
    const done = await store.integrate(run.id, "pending");
    expect(done).toMatchObject({
      state: "succeeded",
      session_id: "s-1",
      integration: { state: "pending" },
    });
    expect((await rejection(store.integrate(run.id, "pending"))).code).toBe("invalid_transition");
  });

  it("validates updates and never changes identity", async () => {
    const run = await store.create(newRun());
    expect((await rejection(store.update(run.id, { base_commit: "abc" }))).code).toBe("invalid");
    const updated = await store.update(run.id, { base_commit: "a".repeat(40) });
    expect(updated.base_commit).toBe("a".repeat(40));
    const sneaky = { task: "XX-01" } as unknown as Parameters<RunStore["update"]>[1];
    expect((await rejection(store.update(run.id, sneaky))).code).toBe("invalid");
  });

  it("rewrites run.json atomically: concurrent readers never see a partial file", async () => {
    const run = await store.create(newRun());
    const path = join(store.runDir(run.id), RUN_FILE);
    const summary = "x".repeat(15_000);
    let writing = true;
    const reads: string[] = [];
    const reader = (async () => {
      while (writing) {
        reads.push(readFileSync(path, "utf8"));
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    for (let i = 0; i < 40; i++) {
      await store.update(run.id, { summary: `${i}${summary}`.slice(0, 15_000) });
    }
    writing = false;
    await reader;
    expect(reads.length).toBeGreaterThan(0);
    for (const text of reads) expect(() => JSON.parse(text)).not.toThrow();
    // No temp files are left behind.
    expect(readdirSync(store.runDir(run.id))).toEqual([RUN_FILE]);
  });

  it("serializes concurrent read-modify-write updates without losing any", async () => {
    const run = await store.create(newRun());
    const other = new RunStore(root);
    await Promise.all([
      store.update(run.id, { session_id: "s-1" }),
      other.update(run.id, { base_commit: "c".repeat(40) }),
      store.update(run.id, { branch: "konsora/BE-02/x" }),
      other.update(run.id, { worktree: "/tmp/wt" }),
    ]);
    expect(await store.read(run.id)).toMatchObject({
      session_id: "s-1",
      base_commit: "c".repeat(40),
      branch: "konsora/BE-02/x",
      worktree: "/tmp/wt",
    });
  });
});

describe("active runs", () => {
  it("allows at most one active run per task", async () => {
    const first = await store.create(newRun("BE-02"));
    await store.create(newRun("BE-03"));
    const error = await rejection(store.create(newRun("BE-02")));
    expect(error.code).toBe("active_run");
    expect(error.activeRun?.id).toBe(first.id);
    expect(error.message).toMatch(/cancel it first/);

    await store.transition(first.id, "starting");
    await store.transition(first.id, "interrupted");
    expect((await rejection(store.create(newRun("BE-02")))).code).toBe("active_run");

    await store.transition(first.id, "cancelled");
    const second = await store.create(newRun("BE-02"));
    expect((await store.activeRun("BE-02"))?.id).toBe(second.id);
    expect([...(await store.activeRuns()).keys()].sort()).toEqual(["BE-02", "BE-03"]);
    expect((await store.list({ task: "BE-02" })).runs.map((r) => r.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("lets only one of many concurrent creations for the same task win", async () => {
    const stores = [store, new RunStore(root), new RunStore(root)];
    const results = await Promise.allSettled(
      Array.from({ length: 9 }, (_, i) => (stores[i % 3] as RunStore).create(newRun("BE-02"))),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    for (const r of lost) expect((r.reason as RunStoreError).code).toBe("active_run");
    expect((await store.list({ task: "BE-02" })).runs).toHaveLength(1);
  });

  it("reports broken run directories instead of failing the listing", async () => {
    const run = await store.create(newRun());
    const broken = nextId();
    mkdirSync(join(store.dir, broken));
    writeFileSync(join(store.dir, broken, RUN_FILE), "{ nope");
    const listing = await store.list();
    expect(listing.runs.map((r) => r.id)).toEqual([run.id]);
    expect(listing.invalid).toEqual([
      { id: broken, message: expect.stringMatching(/not valid JSON/) },
    ]);
  });
});

describe("events.jsonl and raw.jsonl", () => {
  it("keeps every line when several writers append at once, including another process", async () => {
    const run = await store.create(newRun());
    const other = new RunStore(root);
    const child = appendFromChild(root, run.id, 300);
    await Promise.all(
      Array.from({ length: 300 }, (_, i) =>
        (i % 2 ? store : other).appendEvent(run.id, {
          type: "message",
          writer: "parent",
          i,
          text: "y".repeat(i * 7),
        }),
      ),
    );
    await child;
    const events = (await store.readEvents(run.id)) as { writer: string; i: number }[];
    expect(events).toHaveLength(600);
    for (const writer of ["parent", "child"]) {
      const seen = events.filter((e) => e.writer === writer).map((e) => e.i);
      expect(new Set(seen).size).toBe(300);
    }
    expect(readFileSync(join(store.runDir(run.id), EVENTS_FILE), "utf8").endsWith("\n")).toBe(true);
  });

  it("never creates files for a run that does not exist", async () => {
    const ghost = nextId();
    expect((await rejection(store.appendEvent(ghost, { type: "x" }))).code).toBe("not_found");
    expect((await rejection(store.appendEvent("../../etc" as RunId, { type: "x" }))).code).toBe(
      "invalid_id",
    );
  });

  it("rotates raw.jsonl before it passes the limit", async () => {
    const small = new RunStore(root, { rawMaxBytes: 100 });
    const run = await small.create(newRun());
    const dir = small.runDir(run.id);
    for (let i = 0; i < 6; i++)
      await small.appendRaw(run.id, `{"n":${i},"pad":"${"z".repeat(20)}"}`);
    const raw = readFileSync(join(dir, RAW_FILE), "utf8");
    const rotated = readFileSync(join(dir, RAW_ROTATED_FILE), "utf8");
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(rotated)).toBeLessThanOrEqual(100);
    const lines = (rotated + raw)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).n);
    expect(lines).toEqual([2, 3, 4, 5]); // lines 0–1 went with the first rotation
  });
});

describe("unsafe paths", () => {
  it("refuses a symlinked runs directory", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "konsora-elsewhere-"));
    try {
      symlinkSync(elsewhere, join(root, ".konsora", "runs"));
      expect((await rejection(store.create(newRun()))).code).toBe("unsafe_path");
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses a project without .konsora", async () => {
    const empty = mkdtempSync(join(tmpdir(), "konsora-empty-"));
    try {
      expect((await rejection(new RunStore(empty).create(newRun()))).code).toBe("unsafe_path");
      expect(readdirSync(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

/** Appends `count` events from a separate Node process, through its own RunStore. */
function appendFromChild(projectRoot: string, id: string, count: number): Promise<void> {
  const storeUrl = new URL("../src/run-store.ts", import.meta.url).href;
  const script = `
    const { RunStore } = await import(${JSON.stringify(storeUrl)});
    const store = new RunStore(${JSON.stringify(projectRoot)});
    await Promise.all(Array.from({ length: ${count} }, (_, i) =>
      store.appendEvent(${JSON.stringify(id)}, { type: "message", writer: "child", i, text: "q".repeat(i * 7) })));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${stderr}`)),
    );
  });
}
