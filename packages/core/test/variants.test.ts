import { describe, expect, it } from "vitest";
import { OpSchema } from "../src/op-schema.ts";
import { applyOp, type OpContext } from "../src/ops.ts";
import { createRunIdGenerator, type Run, RunSchema, type RunState } from "../src/run.ts";
import type { Task, TasksDocument } from "../src/schema.ts";
import {
  canAddRun,
  chooseVariant,
  integrableRun,
  MAX_VARIANTS,
  variantsOutcome,
} from "../src/variants.ts";

const nextId = createRunIdGenerator();

function run(fields: Partial<Run> = {}): Run {
  return {
    id: nextId(),
    task: "BE-01",
    task_hash: `sha256:${"a".repeat(64)}`,
    agent: { provider: "claude", model: "opus", permissions: "default" },
    state: "running",
    ...fields,
  };
}

/** A variant group of `states.length` runs, the first one founding it. */
function group(lead: RunState, ...states: RunState[]): Run[] {
  const first = run({ state: lead });
  const founded = { ...first, variant_of: first.id };
  return [
    founded,
    ...states.map((state, i) =>
      run({
        state,
        variant_of: first.id,
        agent: { provider: i % 2 ? "claude" : "codex", model: "m", permissions: "default" },
      }),
    ),
  ];
}

/** Applies what `chooseVariant` decided. */
function written(runs: Run[], changed: Run[]): Run[] {
  return runs.map((r) => changed.find((c) => c.id === r.id) ?? r);
}

describe("variant_of in run.json", () => {
  it("is a run id, and a rebase run cannot be a variant", () => {
    const [first] = group("running");
    expect(RunSchema.safeParse(first).success).toBe(true);
    expect(RunSchema.safeParse({ ...first, variant_of: "BE-01" }).success).toBe(false);
    expect(RunSchema.safeParse({ ...first, rebase_of: nextId() }).success).toBe(false);
  });
});

describe("the variants of a group count as one active run (ac1)", () => {
  it("lets the variants of a group be active together, up to MAX_VARIANTS", () => {
    const first = run({ state: "queued" });
    const founder = { ...first, variant_of: first.id };
    expect(canAddRun([], founder).ok).toBe(true);
    const runs: Run[] = [founder];
    for (let i = 1; i < MAX_VARIANTS; i++) {
      const variant = run({ state: "queued", variant_of: first.id });
      expect(canAddRun(runs, variant)).toEqual({ ok: true });
      runs.push(variant);
    }
    const extra = canAddRun(runs, run({ state: "queued", variant_of: first.id }));
    expect(extra.ok || extra.error.code).toBe("variant_group_closed");
  });

  it("refuses any other run of the task while a variant is active", () => {
    const runs = group("running", "checking");
    const plain = canAddRun(runs, run({ state: "queued" }));
    expect(plain.ok || plain.error).toMatchObject({ code: "active_run", run: runs[0]?.id });
    const other = run({ state: "queued" });
    const foreign = canAddRun(runs, { ...other, variant_of: other.id });
    expect(foreign.ok || foreign.error.code).toBe("active_run");
    // An interrupted variant still holds the task.
    const interrupted = group("interrupted", "succeeded");
    expect(canAddRun(interrupted, run({ state: "queued" })).ok).toBe(false);
  });

  it("refuses a variant while a plain run is active, or of a group that is not there", () => {
    const plain = [run({ state: "running" })];
    const first = run({ state: "queued" });
    const founder = canAddRun(plain, { ...first, variant_of: first.id });
    expect(founder.ok || founder.error.code).toBe("active_run");
    const orphan = canAddRun([], run({ state: "queued", variant_of: nextId() }));
    expect(orphan.ok || orphan.error.code).toBe("not_a_variant");
  });

  it("closes a decided group to new variants, and frees the task once all have finished", () => {
    const runs = group("succeeded", "succeeded");
    const chosen = chooseVariant(runs, runs[0]?.id as Run["id"]);
    if (!chosen.ok) throw new Error(chosen.error.message);
    const decided = written(runs, chosen.runs);
    const late = canAddRun(decided, run({ state: "queued", variant_of: runs[0]?.id }));
    expect(late.ok || late.error.code).toBe("variant_group_closed");
    expect(canAddRun(decided, run({ state: "queued" })).ok).toBe(true);
  });
});

describe("closing a group (ac2)", () => {
  it("keeps the task running until every variant has closed", () => {
    const runs = group("succeeded", "checking");
    const id = runs[0]?.id as Run["id"];
    expect(variantsOutcome(runs, id)).toBe("running");
    expect(variantsOutcome(written(runs, [{ ...(runs[1] as Run), state: "failed" }]), id)).toBe(
      "review",
    );
    const failed = group("failed", "cancelled");
    expect(variantsOutcome(failed, failed[0]?.id as Run["id"])).toBe("failed");
  });

  const at = "2026-11-02T10:00:00Z";
  function doing(yoloChain: boolean): TasksDocument {
    const task = (id: string, extra: Partial<Task>): Task => ({
      id,
      title: id,
      state: "todo",
      group: "BE",
      rank: id.toLowerCase().replace("-", ""),
      created: { at, by: "human" },
      updated_at: at,
      ...extra,
    });
    return {
      schema: "konsora/2",
      project: { name: "demo", base_branch: "main" },
      groups: [{ id: "BE", name: "Backend" }],
      seq: { BE: 2 },
      tasks: [
        task("BE-01", { state: "doing" }),
        task("BE-02", { deps: ["BE-01"], ...(yoloChain ? { yolo: true } : {}) }),
      ],
    };
  }

  it("completes the task to review with the group, whichever variant finished last", () => {
    const [a, b] = group("succeeded", "failed") as [Run, Run];
    const inA: OpContext = { actor: "agent:claude", at, runTask: "BE-01", run: a.id };
    const finished = applyOp(doing(true), { op: "finish", task: "BE-01", summary: "A" }, inA);
    if (!finished.ok) throw new Error(finished.error.message);
    // B failed and closed last: its own summary is missing, but the group has A's.
    const konsoraInB: OpContext = { actor: "konsora", at, run: b.id };
    const alone = applyOp(
      finished.document,
      { op: "complete", task: "BE-01", checks_passed: true, integrated: true },
      konsoraInB,
    );
    expect(alone.ok || alone.error.code).toBe("summary_required");
    const op = {
      op: "complete" as const,
      task: "BE-01",
      checks_passed: true,
      integrated: true,
      variants: [a.id, b.id],
    };
    expect(OpSchema.safeParse(op).success).toBe(true);
    const completed = applyOp(finished.document, op, konsoraInB);
    if (!completed.ok) throw new Error(completed.error.message);
    // Never done, even in a YOLO chain: the human chooses the winner in review.
    expect(completed.document.tasks[0]?.state).toBe("review");
    expect(OpSchema.safeParse({ ...op, variants: [a.id] }).success).toBe(false);
  });

  it("choosing a winner leaves it pending and discards the others, keeping their data", () => {
    const runs = group("succeeded", "succeeded", "failed").map((r) => ({
      ...r,
      summary: `Work of ${r.id}`,
      head_commit: "a".repeat(40),
    }));
    const [a, b, c] = runs as [Run, Run, Run];
    const chosen = chooseVariant(runs, b.id);
    if (!chosen.ok) throw new Error(chosen.error.message);
    const after = written(runs, chosen.runs);
    expect(after.map((r) => r.integration?.state)).toEqual(["discarded", "pending", "discarded"]);
    for (const [i, r] of after.entries()) {
      const { integration: _, ...rest } = r;
      expect(rest).toEqual(runs[i]);
      expect(RunSchema.safeParse(r).success).toBe(true);
    }
    // Again: nothing changes. Another winner now: the others are already discarded.
    const again = chooseVariant(after, b.id);
    expect(again.ok && again.runs).toEqual([]);
    const switched = chooseVariant(after, a.id);
    expect(switched.ok || switched.error.code).toBe("not_choosable");
    const loser = chooseVariant(runs, c.id);
    expect(loser.ok || loser.error.code).toBe("not_choosable");
  });

  it("refuses to choose while a variant is still running, or a run that is no variant", () => {
    const runs = group("succeeded", "running");
    const early = chooseVariant(runs, runs[0]?.id as Run["id"]);
    expect(early.ok || early.error.code).toBe("variants_running");
    const plain = run({ state: "succeeded" });
    const none = chooseVariant([plain], plain.id);
    expect(none.ok || none.error.code).toBe("not_a_variant");
  });
});

describe("accept integrates only the winner (ac3)", () => {
  it("is an actionable error to accept before choosing among several", () => {
    const runs = group("succeeded", "succeeded");
    const result = integrableRun(runs);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "variant_not_chosen",
      variants: runs.map((r) => r.id),
    });
    expect(result.error.message).toMatch(/choose the winner before accepting/);

    const chosen = chooseVariant(runs, runs[1]?.id as Run["id"]);
    if (!chosen.ok) throw new Error(chosen.error.message);
    const after = integrableRun(written(runs, chosen.runs));
    expect(after.ok && after.run?.id).toBe(runs[1]?.id);
  });

  it("needs no choice when only one variant succeeded", () => {
    const runs = group("failed", "succeeded");
    const result = integrableRun(runs);
    expect(result.ok && result.run?.id).toBe(runs[1]?.id);
  });

  it("keeps the rules for plain and rebase runs", () => {
    const plain = run({ state: "succeeded" });
    expect(integrableRun([plain])).toEqual({ ok: true, run: plain });
    const conflicted = run({ state: "succeeded", integration: { state: "conflict" } });
    const rebase = run({ state: "failed", rebase_of: conflicted.id });
    expect(integrableRun([conflicted, rebase])).toEqual({ ok: true, run: conflicted });
    expect(integrableRun([run({ state: "failed" })])).toEqual({ ok: true, run: null });
  });
});
