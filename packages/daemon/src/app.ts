/**
 * HTTP API of the daemon (DMN-01: health, project registry, read endpoints).
 * Writes to plans (ops) arrive in DMN-02; live events over WebSocket in DMN-03.
 */
import {
  dependentsOf,
  deriveFlags,
  indexTasks,
  type Task,
  type TasksDocument,
  taskHash,
  topoOrder,
} from "@konsora/core";
import { readTasks } from "@konsora/core/store";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthConfig, guard } from "./auth.ts";
import { type Registry, RegistryError } from "./registry.ts";

export const VERSION = "0.0.0";

export type AppOptions = AuthConfig & { registry: Registry; now?: () => Date };

/** Every task as the UI needs it: stored fields, derived flags and the hash for `expect`. */
function taskViews(doc: TasksDocument) {
  const flags = deriveFlags(doc);
  const index = indexTasks(doc);
  return topoOrder(doc).order.map((id) => {
    const task = index.get(id) as Task;
    return { ...task, ...flags.get(id), hash: taskHash(task) };
  });
}

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

  app.onError((error, c) => {
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
    return c.json({
      project,
      status: "ok",
      hash: plan.hash,
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

  api.notFound((c) => c.json({ error: { code: "not_found", message: "Unknown endpoint" } }, 404));
  app.route("/api", api);
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));
  return app;
}
