import { describe, expect, it } from "vitest";
import { parseOp } from "../src/op-schema.ts";
import { applyOp } from "../src/ops.ts";
import {
  CHECK_OUTPUT_MAX,
  type CheckAttempt,
  type CheckResult,
  ChecksFileSchema,
  checkSummary,
  checksPassed,
  plannedChecks,
  plannedSetup,
  RunSchema,
  tailOutput,
} from "../src/run.ts";
import { buildRetryPrompt, RETRY_OUTPUT_MAX } from "../src/run-prompt.ts";
import { checkRetries, type TasksDocument } from "../src/schema.ts";
import { validateDocument } from "../src/semantics.ts";
import { serializeDocument } from "../src/serialize.ts";

const at = "2026-11-02T10:00:00Z";
const RUN = "r-01JC8Z3K2QX7M4V9T0B6N5R8PW";

function plan(project: Record<string, unknown> = {}): unknown {
  return {
    schema: "konsora/2",
    project: { name: "P", base_branch: "main", ...project },
    groups: [{ id: "BE", name: "Backend" }],
    seq: { BE: 1 },
    tasks: [
      {
        id: "BE-01",
        title: "Cache",
        state: "doing",
        group: "BE",
        rank: "a",
        acceptance: [
          { id: "ac1", text: "Cached", check: "npm test -- cache" },
          { id: "ac2", text: "Looks right" },
        ],
        created: { at, by: "human" },
        updated_at: at,
      },
    ],
  };
}

const result = (extra: Partial<CheckResult> = {}): CheckResult => ({
  id: "test",
  source: "project",
  command: "npm test",
  exit_code: 0,
  duration_ms: 1200,
  timed_out: false,
  output: "ok\n",
  ...extra,
});

describe("project.check_retries (ac1)", () => {
  it("accepts 0–5, rejects anything else, and defaults to 2 when absent", () => {
    for (const value of [0, 2, 5])
      expect(validateDocument(plan({ check_retries: value })).ok).toBe(true);
    for (const value of [-1, 6, 1.5, "2"]) {
      expect(validateDocument(plan({ check_retries: value })).ok).toBe(false);
    }
    expect(checkRetries({})).toBe(2);
    expect(checkRetries({ check_retries: 0 })).toBe(0);
  });

  it("is serialized canonically right after checks, even when 0", () => {
    const parsed = validateDocument(
      plan({ check_retries: 0, checks: [{ timeout_s: 60, run: "npm test", id: "test" }] }),
    );
    if (!parsed.ok) throw new Error("invalid");
    const text = serializeDocument(parsed.document as TasksDocument);
    expect(text).toContain(
      '"checks": [\n      {\n        "id": "test",\n        "run": "npm test",\n        "timeout_s": 60\n      }\n    ],\n    "check_retries": 0\n',
    );
  });

  it("parses set-checks and complete from JSON with their limits", () => {
    expect(parseOp({ op: "set-checks", check_retries: null }).ok).toBe(true);
    expect(parseOp({ op: "set-checks", check_retries: 9 }).ok).toBe(false);
    expect(parseOp({ op: "set-checks", checks: [{ id: "Bad id", run: "x" }] }).ok).toBe(false);
    expect(parseOp({ op: "complete", task: "BE-01", checks_passed: true }).ok).toBe(true);
    expect(parseOp({ op: "complete", task: "BE-01" }).ok).toBe(false);
  });
});

describe("check results (ac4)", () => {
  it("checks.json keeps every attempt with id, source, command, exit code, duration, timeout and output", () => {
    const file = {
      run: RUN,
      attempts: [
        {
          attempt: 1,
          started_at: at,
          finished_at: at,
          results: [
            result({ exit_code: 1, output: "1 failing\n" }),
            result({
              id: "ac1",
              source: "acceptance",
              command: "npm test -- cache",
              exit_code: null,
              timed_out: true,
              output: "x".repeat(CHECK_OUTPUT_MAX),
              output_truncated: true,
            }),
          ],
        },
        { attempt: 2, started_at: at, results: [result()] },
      ],
    };
    expect(ChecksFileSchema.safeParse(file).success).toBe(true);
    const misnumbered = { ...file, attempts: [{ ...file.attempts[1], attempt: 2 }] };
    expect(ChecksFileSchema.safeParse(misnumbered).success).toBe(false);
    const tooLong = {
      ...file,
      attempts: [
        { ...file.attempts[1], results: [result({ output: "x".repeat(CHECK_OUTPUT_MAX + 1) })] },
      ],
    };
    expect(ChecksFileSchema.safeParse(tooLong).success).toBe(false);
    const missing = { ...file, attempts: [{ ...file.attempts[1], results: [{ id: "test" }] }] };
    expect(ChecksFileSchema.safeParse(missing).success).toBe(false);
  });

  it("run.json takes the last attempt's summary and the attempt count; older run.json stay valid", () => {
    const base = {
      id: RUN,
      task: "BE-01",
      task_hash: `sha256:${"0".repeat(64)}`,
      agent: { provider: "claude", model: "opus" },
      state: "succeeded",
    };
    const attempt: CheckAttempt = {
      attempt: 2,
      started_at: at,
      results: [
        result({ exit_code: 2, timed_out: false }),
        result({ id: "ac1", source: "acceptance" }),
      ],
    };
    const run = { ...base, checks: checkSummary(attempt), check_attempts: 2 };
    expect(RunSchema.safeParse(run).success).toBe(true);
    expect(run.checks[0]).toEqual({
      id: "test",
      source: "project",
      exit_code: 2,
      duration_ms: 1200,
      timed_out: false,
    });
    // Before M8: only id, exit_code and duration_ms.
    const old = { ...base, checks: [{ id: "test", exit_code: 0, duration_ms: 8123 }] };
    expect(RunSchema.safeParse(old).success).toBe(true);
    expect(RunSchema.safeParse({ ...base, check_attempts: 7 }).success).toBe(false);
  });

  it("a check passes only with exit 0 in time; no checks pass", () => {
    expect(checksPassed([])).toBe(true);
    expect(checksPassed([result()])).toBe(true);
    expect(checksPassed([result(), result({ exit_code: 1 })])).toBe(false);
    expect(checksPassed([result({ exit_code: 0, timed_out: true })])).toBe(false);
    expect(checksPassed([result({ exit_code: null })])).toBe(false);
  });

  it("plans the project's checks, then the criteria with a check, with default timeouts", () => {
    const parsed = validateDocument(
      plan({
        checks: [
          { id: "lint", run: "npm run lint" },
          { id: "test", run: "npm test", timeout_s: 30 },
        ],
      }),
    );
    if (!parsed.ok) throw new Error("invalid");
    expect(plannedChecks(parsed.document, "BE-01")).toEqual([
      { id: "lint", source: "project", command: "npm run lint", timeout_s: 600 },
      { id: "test", source: "project", command: "npm test", timeout_s: 30 },
      { id: "ac1", source: "acceptance", command: "npm test -- cache", timeout_s: 600 },
    ]);
  });

  it("keeps the tail of a long output", () => {
    expect(tailOutput("abc", 5)).toEqual({ output: "abc", truncated: false });
    expect(tailOutput("abcdefgh", 5)).toEqual({ output: "defgh", truncated: true });
  });
});

describe("the retry prompt (ac5)", () => {
  const attempt: CheckAttempt = {
    attempt: 1,
    started_at: at,
    results: [
      result({ id: "lint", command: "npm run lint", output: "all good\n" }),
      result({ exit_code: 1, output: "FAIL cache.test.ts\n  expected 1 to be 2\n" }),
      result({
        id: "ac1",
        source: "acceptance",
        command: "npm test -- cache",
        exit_code: null,
        timed_out: true,
        output: `${"a".repeat(RETRY_OUTPUT_MAX)}THE END\n`,
        output_truncated: true,
      }),
    ],
  };

  it("lists only the failed checks, with command, ending and output, and what to do next", () => {
    const text = buildRetryPrompt("BE-01", attempt, 1);
    expect(text).toBe(buildRetryPrompt("BE-01", structuredClone(attempt), 1));
    expect(text).toContain(
      "Konsora ran the checks of BE-01 after you called `finish` (attempt 1), and 2 failed.",
    );
    expect(text).not.toContain("npm run lint");
    expect(text).toContain(
      "### Project check test: `npm test`\n\nIt exited with code 1.\n\nIts output:\n```\nFAIL cache.test.ts\n  expected 1 to be 2\n```",
    );
    expect(text).toContain(
      "### Acceptance criterion ac1: `npm test -- cache`\n\nIt ran out of time and was stopped.",
    );
    expect(text).toContain("call `finish` on BE-01 again");
    expect(text).toContain("one more try");
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).not.toContain("1200");
  });

  it("cuts each output to its last RETRY_OUTPUT_MAX characters", () => {
    const text = buildRetryPrompt("BE-01", attempt, 0);
    expect(text).toContain("Last part of its output (earlier output omitted):");
    expect(text).toContain("THE END");
    const block = text.slice(text.indexOf("Last part of its output"));
    const open = block.indexOf("```\n") + 4;
    const body = block.slice(open, block.indexOf("\n```", open));
    expect(body.length).toBe(RETRY_OUTPUT_MAX);
    expect(text).toContain("This is the last try");
  });

  it("fences output that contains backticks safely, and says when a check printed nothing", () => {
    const tricky: CheckAttempt = {
      attempt: 2,
      started_at: at,
      results: [
        result({ exit_code: 1, output: "```\nnot the end\n````\n" }),
        result({ id: "e2e", exit_code: 3, output: "" }),
      ],
    };
    const text = buildRetryPrompt("BE-01", tricky, 2);
    expect(text).toContain("`````\n```\nnot the end\n````\n`````");
    expect(text).toContain("It printed nothing.");
    expect(text).toContain("2 more tries");
  });
});

describe("project.setup (RUN-20 ac1)", () => {
  it("is validated, serialized canonically before checks, and set only by a human", () => {
    expect(validateDocument(plan({ setup: { run: "npm ci" } })).ok).toBe(true);
    expect(validateDocument(plan({ setup: { run: "" } })).ok).toBe(false);
    expect(validateDocument(plan({ setup: "npm ci" })).ok).toBe(false);
    expect(validateDocument(plan({ setup: { run: "npm ci", timeout_s: 0 } })).ok).toBe(false);
    const parsed = validateDocument(
      plan({
        checks: [{ id: "test", run: "npm test" }],
        setup: { timeout_s: 900, run: "npm ci" },
      }),
    );
    if (!parsed.ok) throw new Error("invalid");
    expect(serializeDocument(parsed.document)).toContain(
      '"setup": {\n      "run": "npm ci",\n      "timeout_s": 900\n    },\n    "checks": [',
    );
    expect(plannedSetup(parsed.document)).toEqual({ command: "npm ci", timeout_s: 900 });
    expect(parseOp({ op: "set-checks", setup: { run: "npm ci" } }).ok).toBe(true);
    expect(parseOp({ op: "set-checks", setup: null }).ok).toBe(true);
    expect(parseOp({ op: "set-checks", setup: { run: "npm ci", extra: 1 } }).ok).toBe(false);

    const document = parsed.document;
    const op = { op: "set-checks" as const, setup: { run: "pnpm i" } };
    for (const actor of ["agent:claude", "konsora"]) {
      const result = applyOp(document, op, { actor, at });
      expect(result.ok ? "ok" : result.error.code).toBe("forbidden");
    }
    const set = applyOp(document, op, { actor: "human", at });
    expect(set.ok && set.document.project.setup).toEqual({ run: "pnpm i" });
    const cleared = applyOp(document, { op: "set-checks", setup: null }, { actor: "human", at });
    expect(cleared.ok && cleared.document.project.setup).toBeUndefined();
  });
});
