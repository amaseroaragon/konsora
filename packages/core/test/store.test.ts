import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TasksDocument } from "../src/schema.ts";
import { parseTasksFile } from "../src/semantics.ts";
import { serializeDocument } from "../src/serialize.ts";
import {
  LOCK_FILE,
  mutate,
  readTasks,
  strayTempFiles,
  tasksPath,
  type WatchEvent,
  watchTasks,
} from "../src/store.ts";

const at = "2026-11-02T10:00:00Z";
const agent = { actor: "agent:claude", at };
const human = { actor: "human", at };

function seed(): TasksDocument {
  return {
    schema: "konsora/3",
    project: { name: "Fixture" },
    groups: [{ id: "BE", name: "Backend" }],
    seq: { BE: 1 },
    tasks: [
      {
        id: "BE-01",
        title: "First",
        state: "proposed",
        group: "BE",
        rank: "a",
        created: { at, by: "human" },
        updated_at: at,
      },
    ],
  };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "konsora-store-"));
  mkdirSync(join(root, ".konsora"));
  writeFileSync(tasksPath(root), serializeDocument(seed()));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("readTasks", () => {
  it("reads and validates, returning the file hash", async () => {
    const r = await readTasks(root);
    expect(r.ok && r.document.tasks[0]?.id).toBe("BE-01");
    expect(r.ok && r.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("never writes or creates anything, even when the folder is missing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "konsora-empty-"));
    const r = await readTasks(empty);
    expect(r.ok ? null : r.error.code).toBe("missing");
    expect(readdirSync(empty)).toEqual([]);
    rmSync(empty, { recursive: true });
  });

  it("rejects symlinked .konsora and tasks.json", async () => {
    const outside = mkdtempSync(join(tmpdir(), "konsora-outside-"));
    writeFileSync(join(outside, "tasks.json"), serializeDocument(seed()));
    rmSync(tasksPath(root));
    symlinkSync(join(outside, "tasks.json"), tasksPath(root));
    expect(((await readTasks(root)) as { error: { code: string } }).error.code).toBe("unsafe_path");

    const other = mkdtempSync(join(tmpdir(), "konsora-root-"));
    symlinkSync(outside, join(other, ".konsora"));
    expect(((await readTasks(other)) as { error: { code: string } }).error.code).toBe(
      "unsafe_path",
    );
    rmSync(outside, { recursive: true });
    rmSync(other, { recursive: true });
  });
});

describe("mutate", () => {
  it("applies an op and writes canonical text atomically, leaving no lock or temp files", async () => {
    const r = await mutate(root, { op: "approve", task: "BE-01" }, human);
    expect(r.ok && r.changed).toEqual(["BE-01"]);
    const text = readFileSync(tasksPath(root), "utf8");
    expect(text).toBe(r.ok ? r.text : "");
    expect(parseTasksFile(text).ok).toBe(true);
    expect(readdirSync(join(root, ".konsora"))).toEqual(["tasks.json"]);
    expect(await strayTempFiles(root)).toEqual([]);
  });

  it("returns op errors without touching the file", async () => {
    const before = readFileSync(tasksPath(root), "utf8");
    const r = await mutate(root, { op: "approve", task: "BE-01" }, agent);
    expect(r.ok ? null : r.error.code).toBe("forbidden");
    expect(readFileSync(tasksPath(root), "utf8")).toBe(before);
  });

  it("never overwrites an invalid file", async () => {
    const broken = '{ "schema": "konsora/3", "tasks": [ ] , "oops": true }\n';
    writeFileSync(tasksPath(root), broken);
    const r = await mutate(root, { op: "propose", title: "x", group: "BE" }, agent);
    expect(r.ok ? null : r.error.code).toBe("invalid");
    expect(r.ok ? [] : (r.error as { issues?: unknown[] }).issues?.length).toBeGreaterThan(0);
    expect(readFileSync(tasksPath(root), "utf8")).toBe(broken);
  });

  it("re-reads under the lock: external edits to other tasks are kept", async () => {
    // Someone edits the file by hand between our read and our write.
    const doc = seed();
    doc.tasks.push({
      ...(doc.tasks[0] as TasksDocument["tasks"][0]),
      id: "BE-02",
      title: "Hand-made",
    });
    doc.seq.BE = 2;
    writeFileSync(tasksPath(root), serializeDocument(doc));
    const r = await mutate(root, { op: "approve", task: "BE-01" }, human);
    expect(r.ok && r.document.tasks.map((t) => `${t.id}:${t.state}`)).toEqual([
      "BE-01:todo",
      "BE-02:proposed",
    ]);
  });

  it("waits for a live lock and reports who holds it on timeout", async () => {
    writeFileSync(
      join(root, ".konsora", LOCK_FILE),
      JSON.stringify({ pid: process.pid, host: hostname(), at }),
    );
    const r = await mutate(root, { op: "approve", task: "BE-01" }, human, { lockTimeoutMs: 150 });
    expect(r.ok ? null : r.error).toMatchObject({ code: "lock_timeout" });
    expect(r.ok ? "" : r.error.message).toContain(`pid ${process.pid}`);
  });

  it("never treats another host's lock as stale", async () => {
    writeFileSync(
      join(root, ".konsora", LOCK_FILE),
      JSON.stringify({ pid: 999999, host: "elsewhere", at }),
    );
    const r = await mutate(root, { op: "approve", task: "BE-01" }, human, { lockTimeoutMs: 100 });
    expect(r.ok ? null : r.error.code).toBe("lock_timeout");
  });

  it("takes over a lock whose process is dead on this host", async () => {
    const dead = spawnSync(process.execPath, ["-e", "process.pid"]).pid as number;
    writeFileSync(
      join(root, ".konsora", LOCK_FILE),
      JSON.stringify({ pid: dead, host: hostname(), at }),
    );
    const r = await mutate(root, { op: "approve", task: "BE-01" }, human, { lockTimeoutMs: 1000 });
    expect(r.ok).toBe(true);
  });

  it("two real processes interleaving 200 ops lose nothing and leave a valid file", async () => {
    const worker = fileURLToPath(new URL("./fixtures/store-worker.ts", import.meta.url));
    const run = (name: string) =>
      new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [worker, root, name, "100"], {
          stdio: ["ignore", "ignore", "inherit"],
        });
        child.on("exit", (code) => resolve(code ?? 1));
      });
    const codes = await Promise.all([run("alpha"), run("beta")]);
    expect(codes).toEqual([0, 0]);
    const r = await readTasks(root);
    if (!r.ok) throw new Error(r.error.message);
    const titles = new Set(r.document.tasks.map((t) => t.title));
    for (const name of ["alpha", "beta"]) {
      for (let i = 0; i < 100; i++) expect(titles.has(`${name}-${i}`)).toBe(true);
    }
    expect(r.document.tasks).toHaveLength(201);
    expect(r.document.seq.BE).toBe(201);
    expect(await strayTempFiles(root)).toEqual([]);
  }, 60_000);
});

describe("watchTasks", () => {
  it("reports an external edit within 300 ms, and invalid content as such", async () => {
    const events: WatchEvent[] = [];
    const watcher = watchTasks(root, (e) => events.push(e), { debounceMs: 50 });
    await watcher.ready;
    const doc = seed();
    doc.tasks[0] = { ...(doc.tasks[0] as TasksDocument["tasks"][0]), title: "Edited by hand" };
    const started = Date.now();
    writeFileSync(tasksPath(root), serializeDocument(doc));
    while (events.length === 0 && Date.now() - started < 1000)
      await new Promise((r) => setTimeout(r, 10));
    expect(Date.now() - started).toBeLessThan(300);
    expect(events[0]).toMatchObject({ type: "changed" });
    expect(events[0]?.type === "changed" && events[0].document.tasks[0]?.title).toBe(
      "Edited by hand",
    );

    writeFileSync(tasksPath(root), "{ not json");
    const t2 = Date.now();
    while (events.length < 2 && Date.now() - t2 < 1000) await new Promise((r) => setTimeout(r, 10));
    expect(events[1]).toMatchObject({ type: "invalid", error: { code: "invalid" } });
    watcher.close();
  });

  it("does not fire for Konsora's own lock and temp files or unchanged content", async () => {
    const events: WatchEvent[] = [];
    const watcher = watchTasks(root, (e) => events.push(e), { debounceMs: 30 });
    await watcher.ready;
    writeFileSync(join(root, ".konsora", LOCK_FILE), "{}");
    rmSync(join(root, ".konsora", LOCK_FILE));
    writeFileSync(tasksPath(root), readFileSync(tasksPath(root), "utf8")); // same bytes
    await new Promise((r) => setTimeout(r, 150));
    expect(events).toEqual([]);
    watcher.close();
  });
});
