import { deriveFlags, type Run, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { actionBody, type BoardTask } from "../src/api/board.ts";
import { ApiError, createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { runDiffKey, runEventsKey } from "../src/api/runs.ts";
import {
  acceptText,
  diffTotals,
  integrationErrorText,
  parsePatch,
} from "../src/shell/review-model.ts";
import { TaskPanel } from "../src/shell/TaskPanel.tsx";
import { DiffView, ToastProvider } from "../src/ui/index.ts";

const PATCH = `diff --git a/src/app.ts b/src/app.ts
index 3f2c9a1..9ab1c3e 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 import { fetch } from "./http";
-const ttl = 0;
+const ttl = 600;
+const cache = new Map();
 export function get() {
   return fetch();
@@ -10,2 +11,2 @@ export function get() {
-  // old
+  // new
diff --git a/src/cache.ts b/src/cache.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/cache.ts
@@ -0,0 +1,2 @@
+export const cache = new Map();
+export const ttl = 600;
\\ No newline at end of file
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 2222222..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..3333333
Binary files /dev/null and b/logo.png differ
diff --git a/a.txt b/b.txt
similarity index 100%
rename from a.txt
rename to b.txt
`;

describe("diff per file (UI-12 ac1)", () => {
  it("splits a patch into files with their added and removed lines", () => {
    const files = parsePatch(PATCH);
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ["src/app.ts", 3, 2],
      ["src/cache.ts", 2, 0],
      ["old.txt", 0, 1],
      ["logo.png", 0, 0],
      ["b.txt", 0, 0],
    ]);
    expect(files[0]?.lines.map((l) => l.kind)).toEqual([
      "hunk",
      "ctx",
      "del",
      "add",
      "add",
      "ctx",
      "ctx",
      "hunk",
      "del",
      "add",
    ]);
    expect(files[3]?.lines).toEqual([{ kind: "hunk", text: "Archivo binario" }]);
    expect(diffTotals(files)).toEqual({ added: 5, removed: 3 });
    expect(parsePatch("")).toEqual([]);
  });

  it("renders each file with its stats and line kinds", () => {
    const out = renderToStaticMarkup(<DiffView files={parsePatch(PATCH)} />);
    expect(out).toContain('aria-label="src/app.ts"');
    expect(out).toContain("+3");
    expect(out).toContain("−2");
    expect(out).toContain("k-diff__line--add");
    expect(out).toContain("+const ttl = 600;");
    expect(out).toContain("-const ttl = 0;");
  });
});

const at = "2026-11-02T10:00:00Z";
const runId = "r-01JC8Z3K2QX7M4V9T0B6N5R8PW";
const task: Task = {
  id: "BE-01",
  title: "Caché",
  state: "review",
  group: "BE",
  rank: "a",
  created: { at, by: "human" },
  updated_at: at,
  notes: [
    {
      id: "n1",
      at,
      by: "agent:claude",
      kind: "summary",
      text: "Caché de **10 minutos**.",
      run: runId,
    },
  ],
};
const doc: TasksDocument = {
  schema: "konsora/2",
  project: { name: "P", base_branch: "main" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 1 },
  tasks: [task],
};
const boardTask = {
  ...task,
  ...(deriveFlags(doc).get("BE-01") as object),
  hash: taskHash(task),
} as BoardTask;
const run = (extra: Partial<Run> = {}): Run => ({
  id: runId,
  task: "BE-01",
  task_hash: `sha256:${"a".repeat(64)}`,
  agent: { provider: "claude", model: "sonnet", permissions: "default" },
  state: "succeeded",
  started_at: "2026-11-02T10:00:00Z",
  finished_at: "2026-11-02T10:02:05Z",
  usage: { input_tokens: 41200, output_tokens: 5300, cost_usd: 0.42 },
  ...extra,
});

function panel(r: Run) {
  const client = new QueryClient();
  client.setQueryData(runDiffKey("p", r.id), PATCH);
  client.setQueryData(runEventsKey("p", r.id), []);
  return renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <TaskPanel
            projectId="p"
            task={boardTask}
            doc={doc}
            groupName="Backend"
            external={[]}
            readOnly={false}
            runs={[r]}
            onClose={() => {}}
            onOpen={() => {}}
          />
        </ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
}

describe("review panel (UI-12)", () => {
  it("shows the diff per file, the agent's summary, the run's data and the review actions", () => {
    const out = panel(run());
    expect(out).toContain("5 archivos · +5 −3");
    expect(out).toContain('aria-label="src/cache.ts"');
    expect(out).toContain("Resumen del agente");
    expect(out).toContain("<strong>10 minutos</strong>");
    expect(out).toContain("claude · sonnet");
    expect(out).toContain("2 min 5 s");
    expect(out).toContain("41.2k / 5.3k");
    expect(out).toContain("$0.42");
    expect(out).toContain(">Aceptar<");
    expect(out).toContain(">Devolver<");
  });

  it("keeps explaining a failed integration while the run is in conflict", () => {
    expect(panel(run({ integration: { state: "conflict" } }))).toContain(
      "La última integración chocó con la rama base.",
    );
  });
});

describe("accepting (UI-12 ac2)", () => {
  it("calls the accept op and reports the integrated commit", async () => {
    const calls: unknown[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          ok: true,
          integrated: { run: runId, commit: "9ab1c3e5f7a9b1d3f5a7c9e1b3d5f7a9c1e3b5d7" },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;
    const api = createApi("ab".repeat(32), { fetch });
    const result = await api.post(
      "/projects/p/ops",
      actionBody({ task: boardTask, action: "accept" }),
    );
    expect(calls).toEqual([{ op: "accept", task: "BE-01", expect: { "BE-01": boardTask.hash } }]);
    expect(acceptText("BE-01", result as never)).toBe(
      "BE-01 aceptada e integrada en un commit (9ab1c3e).",
    );
    expect(acceptText("BE-02", {})).toBe("BE-02 aceptada: pasa a Hecho.");
  });

  it("explains a 409 conflict with its files, without changing the task", async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "integration_conflict",
            message: "The work of run … conflicts with main; BE-01 stays in review",
            run: runId,
            files: ["src/app.ts"],
          },
        }),
        { status: 409 },
      )) as unknown as typeof globalThis.fetch;
    const api = createApi("ab".repeat(32), { fetch });
    const error = await api
      .post<never>("/projects/p/ops", actionBody({ task: boardTask, action: "accept" }))
      .catch((e: unknown) => e as ApiError);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(error.details.files).toEqual(["src/app.ts"]);
    expect(integrationErrorText(error.code, "BE-01", error.details.files)).toBe(
      "No se pudo integrar BE-01: sus cambios chocan con la rama base en src/app.ts. La tarea sigue en revisión.",
    );
    expect(integrationErrorText("integration_dirty", "BE-01", ["a.ts", "b.ts"])).toContain(
      "a.ts, b.ts",
    );
    expect(integrationErrorText("conflict", "BE-01")).toBeNull();
    // Accept is not optimistic: the task the panel shows is still in review.
    expect(panel(run())).toContain("En revisión");
  });
});
