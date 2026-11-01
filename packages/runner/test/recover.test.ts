import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunIdGenerator, type RunState } from "@konsora/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverRuns } from "../src/recover.ts";
import { RunStore } from "../src/run-store.ts";

const nextId = createRunIdGenerator();
let root: string;
let store: RunStore;

/** A run of `task` walked to `state` along valid transitions. */
async function runIn(task: string, path: RunState[]) {
  const run = await store.create({
    id: nextId(),
    task,
    task_hash: `sha256:${"e".repeat(64)}`,
    agent: { provider: "claude", model: "opus", permissions: "default" },
    state: "queued",
  });
  for (const state of path) await store.transition(run.id, state);
  return run.id;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "konsora-recover-"));
  mkdirSync(join(root, ".konsora"));
  store = new RunStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("recoverRuns", () => {
  it("marks live runs interrupted and relaunches nothing", async () => {
    const running = await runIn("BE-01", ["starting", "running"]);
    const approving = await runIn("BE-02", ["starting", "running", "waiting_approval"]);
    const checking = await runIn("BE-03", ["starting", "running", "checking"]);
    const starting = await runIn("BE-04", ["starting"]);
    const queued = await runIn("BE-05", []);
    const done = await runIn("BE-06", ["starting", "running", "checking", "succeeded"]);
    const failed = await runIn("BE-07", ["starting", "failed"]);

    const recovered = await recoverRuns(store, () => new Date("2026-11-02T10:00:00Z"));

    expect(recovered).toEqual({
      interrupted: [running, approving, checking, starting],
      cancelled: [queued],
    });
    for (const id of [running, approving, checking, starting]) {
      expect((await store.read(id)).state).toBe("interrupted");
      expect((await store.readEvents(id)).at(-1)).toMatchObject({
        t: "interrupted",
        at: "2026-11-02T10:00:00Z",
      });
    }
    expect((await store.read(queued)).state).toBe("cancelled");
    expect((await store.read(done)).state).toBe("succeeded");
    expect((await store.read(failed)).state).toBe("failed");
    // Still occupying their tasks: the human resumes or discards them.
    expect((await store.activeRun("BE-01"))?.id).toBe(running);

    // A second start-up changes nothing.
    expect(await recoverRuns(store)).toEqual({ interrupted: [], cancelled: [] });
  });
});
