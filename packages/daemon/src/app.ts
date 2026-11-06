/**
 * HTTP API of the daemon (DMN-01: health, project registry, read endpoints; DMN-02: ops) and,
 * outside `/api`, the built web UI (UI-01).
 */
import {
  AgentSpecSchema,
  applyOp,
  dependentsOf,
  deriveFlags,
  indexTasks,
  parseOp,
  type Task,
  TaskIdSchema,
  type TasksDocument,
  taskHash,
  topoOrder,
} from "@konsora/core";
import { mutate, readTasks } from "@konsora/core/store";
import { IntegrationError, RunError, RunStoreError, WorktreeError } from "@konsora/runner";
import { Hono } from "hono";
import { z } from "zod";
import { Approvals } from "./approvals.ts";
import { type AuthConfig, allowedHosts, guard } from "./auth.ts";
import { createOversights, type LedgerEntry, type OversightFor } from "./oversight.ts";
import { type Registry, RegistryError } from "./registry.ts";
import { type RunManager, RunManagerError } from "./runs.ts";
import { site } from "./site.ts";

export const VERSION = "0.0.0";

export type AppOptions = AuthConfig & {
  registry: Registry;
  oversight?: OversightFor;
  now?: () => Date;
  /** Folder with the built web UI (`packages/web/dist`), served outside `/api`. */
  webDir?: string;
  /** Pending permission approvals of runs (MCP-04). */
  approvals?: Approvals;
  /** Runs (DMN-04); without it the run routes answer 404. */
  runs?: RunManager;
};

const RunBody = z.strictObject({
  task: z
    .string()
    .transform((id) => id.toUpperCase())
    .pipe(TaskIdSchema),
  agent: AgentSpecSchema.optional(),
});

/** HTTP status for the runner's errors (the body carries code and message). */
const RUN_STATUS: Record<string, 400 | 404 | 409 | 422 | 503> = {
  not_found: 404,
  not_ready: 409,
  no_agent: 422,
  wrong_provider: 422,
  invalid_plan: 409,
  launch_failed: 409,
  no_answer: 409,
  invalid_id: 404,
  active_run: 409,
  not_active: 409,
  not_discardable: 409,
  no_adapter: 422,
  invalid_agent: 422,
  lock_timeout: 503,
};

/** Every task as the UI needs it: stored fields, derived flags and the hash for `expect`. */
function taskViews(doc: TasksDocument) {
  const flags = deriveFlags(doc);
  const index = indexTasks(doc);
  return topoOrder(doc).order.map((id) => {
    const task = index.get(id) as Task;
    return { ...task, ...flags.get(id), hash: taskHash(task) };
  });
}

/** HTTP status for each op error code (the body always carries the full error). */
const OP_STATUS: Record<string, 400 | 403 | 404 | 409 | 422> = {
  forbidden: 403,
  out_of_scope: 403,
  not_found: 404,
  conflict: 409,
  invalid_transition: 409,
  blocked: 409,
  has_dependents: 409,
  not_waiting: 409,
  summary_required: 422,
  feedback_required: 422,
  text_required: 422,
  invalid: 422,
};

const PermissionBody = z.strictObject({
  tool_name: z.string().min(1).max(200),
  input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string().max(200).optional(),
  /** How long to wait for the human, in seconds (default 300, at most one hour). */
  wait_s: z.number().int().min(1).max(3600).optional(),
});

const DecisionBody = z.strictObject({
  decision: z.enum(["allow", "deny"]),
  message: z.string().max(2000).optional(),
});

/** Largest permission request accepted (tool inputs can carry whole files). */
const MAX_PERMISSION_BYTES = 1024 * 1024;

const LinkBody = z.strictObject({
  path: z.string().min(1),
  name: z.string().min(1).max(80).optional(),
});

const registryStatus: Record<RegistryError["code"], 400 | 404 | 500> = {
  not_found: 400,
  not_a_directory: 400,
  inside_data_dir: 400,
  not_registered: 404,
  corrupt: 500,
};

export function createApp(options: AppOptions): Hono {
  const { registry } = options;
  const now = () => (options.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const app = new Hono();
  const oversight = options.oversight ?? createOversights(registry.dataDir);
  const approvals = options.approvals ?? new Approvals();

  app.onError((error, c) => {
    if (
      error instanceof RunError ||
      error instanceof RunStoreError ||
      error instanceof RunManagerError ||
      error instanceof WorktreeError
    ) {
      return c.json(
        { error: { code: error.code, message: error.message } },
        RUN_STATUS[error.code] ?? 409,
      );
    }
    if (error instanceof RegistryError) {
      return c.json(
        { error: { code: error.code, message: error.message } },
        registryStatus[error.code],
      );
    }
    return c.json(
      { error: { code: "internal", message: "Unexpected error in the Konsora daemon" } },
      500,
    );
  });

  const api = new Hono();
  api.use("*", guard(options));

  api.get("/health", (c) => c.json({ ok: true, service: "konsora-daemon", version: VERSION }));

  /** Linked projects, each with the state of its plan (never modifies anything). */
  api.get("/projects", async (c) => {
    const projects = await registry.list();
    const withPlan = await Promise.all(
      projects.map(async (project) => {
        const plan = await readTasks(project.path);
        return {
          ...project,
          plan: plan.ok
            ? { status: "ok" as const, tasks: plan.document.tasks.length, hash: plan.hash }
            : { status: plan.error.code, message: plan.error.message },
        };
      }),
    );
    return c.json({ projects: withPlan });
  });

  api.post("/projects", async (c) => {
    const body = LinkBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ error: { code: "bad_request", message: "Send {path, name?} as JSON" } }, 400);
    const project = await registry.add(body.data.path, body.data.name, now());
    return c.json({ project }, 201);
  });

  api.delete("/projects/:id", async (c) => {
    await registry.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  /**
   * The board: the validated plan with derived flags, or why it cannot be shown. An invalid plan
   * is reported with its issues (the UI shows them read-only); it is never "fixed" here.
   */
  api.get("/projects/:id/board", async (c) => {
    const project = await registry.get(c.req.param("id"));
    const plan = await readTasks(project.path);
    if (!plan.ok) {
      return c.json({
        project,
        status: plan.error.code,
        message: plan.error.message,
        issues: plan.error.issues ?? [],
      });
    }
    const external = await oversight(project.id).check(plan.document, plan.hash, now());
    return c.json({
      project,
      status: "ok",
      hash: plan.hash,
      external,
      plan: {
        schema: plan.document.schema,
        project: plan.document.project,
        groups: plan.document.groups,
        seq: plan.document.seq,
      },
      tasks: taskViews(plan.document),
    });
  });

  api.get("/projects/:id/tasks/:taskId", async (c) => {
    const project = await registry.get(c.req.param("id"));
    const plan = await readTasks(project.path);
    if (!plan.ok)
      return c.json(
        {
          error: {
            code: plan.error.code,
            message: plan.error.message,
            issues: plan.error.issues ?? [],
          },
        },
        409,
      );
    const id = c.req.param("taskId").toUpperCase();
    const task = taskViews(plan.document).find((t) => t.id === id);
    if (!task)
      return c.json({ error: { code: "not_found", message: `Task ${id} does not exist` } }, 404);
    return c.json({ task, dependents: dependentsOf(id, plan.document), fileHash: plan.hash });
  });

  /**
   * Semantic ops from the UI. The daemon is the human's channel, so ops run as `human`.
   * External changes made since the last look are recorded before writing, so they cannot
   * hide behind the daemon's own write; then the result becomes the trusted snapshot and the
   * human action is logged in approvals.jsonl.
   */
  api.post("/projects/:id/ops", async (c) => {
    const project = await registry.get(c.req.param("id"));
    const parsed = parseOp(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ error: { code: "bad_request", message: parsed.message } }, 400);
    const at = now();
    const before = await readTasks(project.path);
    if (!before.ok) {
      return c.json(
        {
          error: {
            code: `plan_${before.error.code}`,
            message: before.error.message,
            issues: before.error.issues ?? [],
          },
        },
        409,
      );
    }
    const watch = oversight(project.id);
    await watch.check(before.document, before.hash, at);

    // Accepting work done by a run integrates it first (one squash commit on the base branch);
    // the task only becomes done once that succeeded.
    let integrated: { run: string; commit: string } | undefined;
    let discarded: string | undefined;
    const runs = options.runs;
    if (parsed.op.op === "accept" && runs) {
      const run = await runs.integrable(project, parsed.op.task);
      if (run) {
        const dry = applyOp(before.document, parsed.op, { actor: "human", at });
        if (!dry.ok) return c.json({ error: dry.error }, OP_STATUS[dry.error.code] ?? 409);
        let outcome: Awaited<ReturnType<RunManager["integrate"]>> | null;
        try {
          outcome = await runs.integrate(project, run);
        } catch (error) {
          // A run that changed nothing (a check, an investigation) is accepted without a commit.
          if (error instanceof IntegrationError && error.code === "nothing_to_integrate") {
            await runs.discard(project, run);
            discarded = run.id;
            outcome = null;
          } else if (error instanceof IntegrationError) {
            return c.json(
              {
                error: {
                  code: `integration_${error.code}`,
                  message: error.message,
                  ...(error.files.length ? { files: error.files } : {}),
                },
              },
              409,
            );
          } else {
            throw error;
          }
        }
        if (outcome?.status === "conflict") {
          return c.json(
            {
              error: {
                code: "integration_conflict",
                message: `The work of run ${run.id} conflicts with ${before.document.project.base_branch}; ${parsed.op.task} stays in review`,
                run: run.id,
                files: outcome.files,
              },
            },
            409,
          );
        }
        if (outcome) integrated = { run: run.id, commit: outcome.commit };
      }
    }

    const result = await mutate(project.path, parsed.op, { actor: "human", at });
    if (!result.ok) {
      if (result.source === "store") {
        const status = result.error.code === "lock_timeout" ? 503 : 409;
        return c.json(
          {
            error: {
              code: `plan_${result.error.code}`,
              message: result.error.message,
              issues: result.error.issues ?? [],
            },
          },
          status,
        );
      }
      const status = OP_STATUS[result.error.code] ?? 409;
      return c.json({ error: result.error }, status);
    }
    const previous = new Map(before.document.tasks.map((t) => [t.id, t.state]));
    const entries: LedgerEntry[] = result.changed.map((task) => {
      const after = result.document.tasks.find((t) => t.id === task);
      const from = previous.get(task);
      return {
        at,
        task,
        op: parsed.op.op,
        ...(from ? { from } : {}),
        ...(after ? { to: after.state } : {}),
        actor: "human",
      };
    });
    await watch.log(entries);
    await watch.trust(result.document, result.hash, at);
    if (parsed.op.op === "answer" && runs) {
      // The run waiting for this answer gets it now (its open input, or a resumed session).
      await runs.deliverAnswer(project, parsed.op.task).catch(() => false);
    }
    const affected = new Set([...result.created, ...result.changed]);
    return c.json({
      ok: true,
      ...(integrated ? { integrated } : {}),
      ...(discarded ? { discarded } : {}),
      hash: result.hash,
      created: result.created,
      changed: result.changed,
      tasks: taskViews(result.document).filter((t) => affected.has(t.id)),
      external: await watch.flags(),
    });
  });

  api.get("/projects/:id/external", async (c) => {
    const project = await registry.get(c.req.param("id"));
    return c.json({
      external: await oversight(project.id).flags(),
      approvals: await oversight(project.id).ledger(),
    });
  });

  /** The human accepts an external change as if they had made it. */
  api.post("/projects/:id/external/:taskId/confirm", async (c) => {
    const project = await registry.get(c.req.param("id"));
    const task = c.req.param("taskId").toUpperCase();
    const watch = oversight(project.id);
    const flags = await watch.resolve(task);
    if (flags.length === 0)
      return c.json(
        { error: { code: "not_found", message: `No external change is flagged on ${task}` } },
        404,
      );
    const at = now();
    await watch.log(
      flags.map((f) => ({
        at,
        task,
        op: `confirm:${f.kind}`,
        ...(f.from ? { from: f.from } : {}),
        ...(f.to ? { to: f.to } : {}),
        actor: "human" as const,
      })),
    );
    return c.json({ ok: true, confirmed: flags });
  });

  /** The human undoes an external change: the task goes back to its version before the first flagged change. */
  api.post("/projects/:id/external/:taskId/revert", async (c) => {
    const project = await registry.get(c.req.param("id"));
    const task = c.req.param("taskId").toUpperCase();
    const watch = oversight(project.id);
    const flags = await watch.flags();
    const first = flags.find((f) => f.task === task);
    if (!first)
      return c.json(
        { error: { code: "not_found", message: `No external change is flagged on ${task}` } },
        404,
      );
    const at = now();
    const op = first.previous
      ? ({ op: "restore", task, version: first.previous } as const)
      : // Created externally as approved: send it back to being a proposal.
        null;
    let result: Awaited<ReturnType<typeof mutate>>;
    if (op) result = await mutate(project.path, op, { actor: "human", at });
    else {
      const current = await readTasks(project.path);
      const version = current.ok ? current.document.tasks.find((t) => t.id === task) : undefined;
      if (!version)
        return c.json({ error: { code: "not_found", message: `${task} no longer exists` } }, 404);
      result = await mutate(
        project.path,
        { op: "restore", task, version: { ...version, state: "proposed" } },
        { actor: "human", at },
      );
    }
    if (!result.ok) return c.json({ error: result.error }, 409);
    await watch.resolve(task);
    await watch.log([{ at, task, op: `revert:${first.kind}`, actor: "human" }]);
    await watch.trust(result.document, result.hash, at);
    return c.json({
      ok: true,
      hash: result.hash,
      task: taskViews(result.document).find((t) => t.id === task) ?? null,
    });
  });

  // ── Runs (DMN-04) ──────────────────────────────────────────────────────────

  const runsOf = () => {
    if (!options.runs)
      throw new RunManagerError("not_found", "Runs are not available in this daemon");
    return options.runs;
  };

  /** What each provider offers: installed and version, models with their efforts, profiles. */
  api.get("/agents", async (c) => c.json({ agents: await runsOf().catalog.list() }));

  /**
   * The providers' rate limits without launching a run (DMN-06): each one's freshest data with
   * its source and date, or why there is none. `?refresh=1` reads the providers again.
   */
  api.get("/limits", async (c) =>
    c.json({ limits: await runsOf().limits.list({ refresh: c.req.query("refresh") === "1" }) }),
  );

  /** Launch a run of one task. Only the human calls this, and only for what they selected. */
  api.post("/projects/:id/runs", async (c) => {
    const project = await registry.get(c.req.param("id"));
    const body = RunBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json(
        { error: { code: "bad_request", message: "Send {task, agent?} as JSON" } },
        400,
      );
    const run = await runsOf().start(project, {
      task: body.data.task,
      ...(body.data.agent ? { agent: body.data.agent } : {}),
    });
    return c.json({ run }, 201);
  });

  api.get("/projects/:id/runs", async (c) => {
    const project = await registry.get(c.req.param("id"));
    const task = c.req.query("task")?.toUpperCase();
    return c.json({ runs: await runsOf().list(project, task) });
  });

  api.get("/projects/:id/runs/:runId", async (c) => {
    const project = await registry.get(c.req.param("id"));
    return c.json({ run: await runsOf().get(project, c.req.param("runId")) });
  });

  api.get("/projects/:id/runs/:runId/events", async (c) => {
    const project = await registry.get(c.req.param("id"));
    return c.json({ events: await runsOf().events(project, c.req.param("runId")) });
  });

  /** The run's `diff.patch` (base..head, without `.konsora/`), or null before it closes. */
  api.get("/projects/:id/runs/:runId/diff", async (c) => {
    const project = await registry.get(c.req.param("id"));
    return c.json({ diff: await runsOf().diff(project, c.req.param("runId")) });
  });

  api.post("/projects/:id/runs/:runId/cancel", async (c) => {
    const project = await registry.get(c.req.param("id"));
    return c.json({ run: await runsOf().cancel(project, c.req.param("runId")) });
  });

  /**
   * The human discards a finished run whose work is not kept: its worktree and branch are
   * removed and its integration becomes `discarded`; the run and its diff stay.
   */
  api.post("/projects/:id/runs/:runId/discard", async (c) => {
    const project = await registry.get(c.req.param("id"));
    return c.json({ run: await runsOf().discardById(project, c.req.param("runId")) });
  });

  /** Konsora worktrees and `konsora/` branches no run needs any more. Read-only. */
  api.get("/projects/:id/worktrees/orphans", async (c) => {
    const project = await registry.get(c.req.param("id"));
    return c.json({ orphans: await runsOf().orphans(project) });
  });

  /** Pending permission approvals of every run, for the human. */
  api.get("/approvals", (c) => c.json({ approvals: approvals.pending() }));

  /** The human allows or denies one pending approval of a run. */
  api.post("/runs/:run/permissions/:approval", async (c) => {
    const body = DecisionBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json(
        { error: { code: "bad_request", message: 'Send {decision: "allow" | "deny", message?}' } },
        400,
      );
    const result = approvals.decide(c.req.param("run"), c.req.param("approval"), {
      behavior: body.data.decision,
      ...(body.data.message ? { message: body.data.message } : {}),
    });
    if (!result.ok)
      return result.code === "resolved"
        ? c.json({ error: { code: "resolved", message: "That approval was already decided" } }, 409)
        : c.json(
            {
              error: { code: "not_found", message: "No pending approval with that id in this run" },
            },
            404,
          );
    return c.json({ ok: true, approval: result.approval });
  });

  api.notFound((c) => c.json({ error: { code: "not_found", message: "Unknown endpoint" } }, 404));

  /**
   * A run's MCP asks for a permission (MCP-04). This is the only route that takes a run token
   * instead of the human's: it can ask, never decide, and only for its own run. It answers when
   * the human decides or the wait runs out (then deny).
   */
  app.post("/api/runs/:run/permissions", async (c) => {
    const deny = (reason: string, message: string, status: 400 | 403 | 413) =>
      c.json({ error: { code: "forbidden", reason, message } }, status);
    const host = c.req.header("host")?.toLowerCase();
    if (!host || !allowedHosts(options.port).has(host))
      return deny("host", "Forbidden: unexpected Host header", 403);
    // Only the run's MCP calls this; a browser never should.
    if (c.req.header("origin")) return deny("origin", "Forbidden: origin not allowed", 403);
    const token = /^Bearer ([0-9a-f]{64})$/.exec(c.req.header("authorization") ?? "")?.[1];
    const info = token ? approvals.authenticate(c.req.param("run"), token) : undefined;
    if (!info) return deny("token", "Forbidden: missing or invalid run token", 403);
    const text = await c.req.text();
    if (Buffer.byteLength(text) > MAX_PERMISSION_BYTES)
      return deny("size", "The permission request is too large", 413);
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {}
    const body = PermissionBody.safeParse(json);
    if (!body.success)
      return c.json(
        {
          error: { code: "bad_request", message: "Send {tool_name, input, tool_use_id?, wait_s?}" },
        },
        400,
      );
    c.header("Cache-Control", "no-store");
    const { approval, decision } = await approvals.request(
      info,
      body.data,
      (body.data.wait_s ?? 300) * 1000,
      c.req.raw.signal,
    );
    return c.json({ id: approval.id, ...decision });
  });

  app.route("/api", api);
  app.route("/", site(options));
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));
  return app;
}
