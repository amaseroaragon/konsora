/**
 * HTTP API of the daemon (DMN-01: health, project registry, read endpoints; DMN-02: ops) and,
 * outside `/api`, the built web UI (UI-01).
 */
import {
  applyOp,
  BlockIdSchema,
  blockCommitMessage,
  blockProgress,
  dependentsOf,
  deriveFlags,
  indexTasks,
  parseOp,
  type Task,
  type TasksDocument,
  taskHash,
  topoOrder,
} from "@konsora/core";
import { mutate, readTasks } from "@konsora/core/store";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthConfig, guard } from "./auth.ts";
import { ChatError, type ChatManager } from "./chat.ts";
import { currentBranch, GitError, localBranches, mergeBranch } from "./git.ts";
import { createOversights, type LedgerEntry, type OversightFor } from "./oversight.ts";
import { type Registry, RegistryError } from "./registry.ts";
import { site } from "./site.ts";

export const VERSION = "0.0.0";

export type AppOptions = AuthConfig & {
  registry: Registry;
  oversight?: OversightFor;
  now?: () => Date;
  /** Folder with the built web UI (`packages/web/dist`), served outside `/api`. */
  webDir?: string;
  /** The AI panel's planning chats; without it the chat routes answer 404. */
  chats?: ChatManager;
};

const ChatBody = z.strictObject({ text: z.string().trim().min(1).max(16_384) });

const MergeBody = z.strictObject({ strategy: z.enum(["squash", "merge"]).default("squash") });

/** HTTP status for the git errors of a merge (the body carries code, message and files). */
const GIT_STATUS: Record<GitError["code"], 409 | 422> = {
  not_a_repo: 422,
  no_branch: 409,
  no_base: 409,
  nothing_to_merge: 409,
  conflict: 409,
  dirty: 409,
  git_failed: 409,
};

/** HTTP status for the chat errors (the body carries code and message). */
const CHAT_STATUS: Record<ChatError["code"], 404 | 409 | 503> = {
  not_found: 404,
  busy: 409,
  invalid_plan: 409,
  unavailable: 503,
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
  unknown_template: 404,
  unknown_block: 404,
  block_merged: 409,
  block_not_ready: 409,
  not_waiting: 409,
  summary_required: 422,
  feedback_required: 422,
  text_required: 422,
  invalid: 422,
};

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

  app.onError((error, c) => {
    if (error instanceof GitError) {
      return c.json(
        {
          error: {
            code: `git_${error.code}`,
            message: error.message,
            ...(error.files.length ? { files: error.files } : {}),
          },
        },
        GIT_STATUS[error.code],
      );
    }
    if (error instanceof ChatError) {
      return c.json(
        { error: { code: error.code, message: error.message } },
        CHAT_STATUS[error.code],
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
        ...(plan.document.blocks ? { blocks: plan.document.blocks } : {}),
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
    const affected = new Set([...result.created, ...result.changed]);
    return c.json({
      ok: true,
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

  // ── Blocks: git branch and merge ──────────────────────────────────────────

  /** The project's current branch and its local branches (for a block's base). Read-only. */
  api.get("/projects/:id/git", async (c) => {
    const project = await registry.get(c.req.param("id"));
    return c.json({
      branch: (await currentBranch(project.path)) ?? null,
      branches: await localBranches(project.path),
    });
  });

  /**
   * The human merges a ready block: Konsora checks the plan first (every task done, not merged),
   * merges the branch into its base locally (never pushes), then records `mark-merged`.
   */
  api.post("/projects/:id/blocks/:block/merge", async (c) => {
    const project = await registry.get(c.req.param("id"));
    const id = BlockIdSchema.safeParse(c.req.param("block"));
    const body = MergeBody.safeParse(await c.req.json().catch(() => ({})));
    if (!id.success || !body.success)
      return c.json(
        { error: { code: "bad_request", message: 'Send {strategy?: "squash" | "merge"}' } },
        400,
      );
    const at = now();
    const before = await readTasks(project.path);
    if (!before.ok)
      return c.json(
        { error: { code: `plan_${before.error.code}`, message: before.error.message } },
        409,
      );
    const watch = oversight(project.id);
    await watch.check(before.document, before.hash, at);
    const block = before.document.blocks?.find((b) => b.id === id.data);
    if (!block)
      return c.json(
        { error: { code: "unknown_block", message: `Block ${id.data} does not exist` } },
        404,
      );
    const strategy = body.data.strategy;
    const dry = applyOp(
      before.document,
      { op: "mark-merged", block: block.id, commit: "0".repeat(40), strategy },
      { actor: "human", at },
    );
    if (!dry.ok) return c.json({ error: dry.error }, OP_STATUS[dry.error.code] ?? 409);
    const { commit } = await mergeBranch(project.path, {
      branch: block.branch,
      base: block.base,
      strategy,
      message: blockCommitMessage(before.document, block.id),
    });
    const result = await mutate(
      project.path,
      { op: "mark-merged", block: block.id, commit, strategy },
      { actor: "human", at },
    );
    if (!result.ok)
      return c.json(
        {
          error: {
            code: "merge_not_recorded",
            message: `${block.branch} was merged into ${block.base} (${commit.slice(0, 12)}), but the plan could not record it: ${result.error.message}`,
            commit,
          },
        },
        409,
      );
    await watch.log([{ at, task: `block:${block.id}`, op: "merge-block", actor: "human" }]);
    await watch.trust(result.document, result.hash, at);
    return c.json({
      ok: true,
      commit,
      hash: result.hash,
      block: result.document.blocks?.find((b) => b.id === block.id) ?? null,
      progress: blockProgress(result.document, block.id),
    });
  });

  // ── AI panel: planning chats ──────────────────────────────────────────────

  const chatsOf = () => {
    if (!options.chats) throw new ChatError("unavailable", "The AI panel is not available");
    return options.chats;
  };

  /** The project's chat: its messages so far and whether the agent is answering. */
  api.get("/projects/:id/chat", async (c) => {
    const project = await registry.get(c.req.param("id"));
    return c.json({ chat: chatsOf().view(project.id) });
  });

  /** Sends the human's message; the answer streams over the WebSocket as `chat.*`. */
  api.post("/projects/:id/chat", async (c) => {
    const project = await registry.get(c.req.param("id"));
    const body = ChatBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ error: { code: "bad_request", message: "Send {text} as JSON" } }, 400);
    return c.json({ chat: await chatsOf().send(project, body.data.text) }, 202);
  });

  /** Stops the answer in progress, if any. */
  api.post("/projects/:id/chat/stop", async (c) => {
    const project = await registry.get(c.req.param("id"));
    return c.json({ chat: chatsOf().stop(project.id) });
  });

  /** Starts over: stops the agent and forgets the conversation. */
  api.delete("/projects/:id/chat", async (c) => {
    const project = await registry.get(c.req.param("id"));
    chatsOf().reset(project.id);
    return c.body(null, 204);
  });

  api.notFound((c) => c.json({ error: { code: "not_found", message: "Unknown endpoint" } }, 404));

  app.route("/api", api);
  app.route("/", site(options));
  // An unknown /api route usually means a daemon older than the web UI it serves.
  app.notFound((c) =>
    c.req.path.startsWith("/api/")
      ? c.json({ error: { code: "unknown_endpoint", message: "Unknown endpoint" } }, 404)
      : c.json({ error: { code: "not_found", message: "Not found" } }, 404),
  );
  return app;
}
