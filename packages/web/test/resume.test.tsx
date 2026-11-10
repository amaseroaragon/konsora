import type { Run } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError, createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import type { QueueView } from "../src/api/queue.ts";
import { resumeRunRequest, runEventsKey, runsKey, useResumeRun } from "../src/api/runs.ts";
import { ProjectQueueView } from "../src/shell/QueuePage.tsx";
import { RunSection } from "../src/shell/RunSection.tsx";
import { canResume, resumeErrorText } from "../src/shell/run-model.ts";
import { ToastProvider } from "../src/ui/index.ts";

const id = "r-01JC8Z3K2QX7M4V9T0B6N5R8PW";
const run = (extra: Partial<Run> = {}): Run => ({
  id,
  task: "BE-01",
  task_hash: `sha256:${"a".repeat(64)}`,
  agent: { provider: "claude", model: "sonnet", permissions: "default" },
  state: "interrupted",
  ...extra,
});

function wrap(node: React.ReactNode, client: QueryClient, fetch?: typeof globalThis.fetch) {
  return (
    <ApiContext.Provider value={createApi("ab".repeat(32), fetch ? { fetch } : {})}>
      <QueryClientProvider client={client}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>
  );
}

function section(r: Run, readOnly = false, client = new QueryClient()) {
  client.setQueryData(runEventsKey("p", r.id), []);
  return renderToStaticMarkup(
    wrap(<RunSection projectId="p" run={r} readOnly={readOnly} />, client),
  );
}

describe("resuming an interrupted run (UI-19)", () => {
  it("offers Resume and Discard on an interrupted run, and Cancel on a live one", () => {
    expect(canResume(run())).toBe(true);
    expect(canResume(run({ state: "running" }))).toBe(false);
    expect(canResume(run({ state: "cancelled" }))).toBe(false);

    const interrupted = section(run());
    expect(interrupted).toContain(">Retomar<");
    expect(interrupted).toContain(">Descartar run<");
    expect(interrupted).not.toContain(">Cancelar run<");
    expect(section(run(), true)).not.toContain(">Retomar<");

    const running = section(run({ state: "running" }));
    expect(running).not.toContain(">Retomar<");
    expect(running).toContain(">Cancelar run<");
  });

  it("posts the resume and shows the same run under way without reloading", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET" });
      return new Response(JSON.stringify({ run: run({ state: "starting" }) }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    // The hook the button uses: its result replaces the run in the cache the section reads.
    const client = new QueryClient();
    client.setQueryData(runsKey("p"), [run()]);
    let mutate: ((run: string) => Promise<Run>) | undefined;
    function Probe() {
      mutate = useResumeRun("p").mutateAsync;
      return null;
    }
    renderToStaticMarkup(wrap(<Probe />, client, fetch));
    await mutate?.(id);
    expect(calls).toEqual([{ url: `/api/projects/p/runs/${id}/resume`, method: "POST" }]);

    const after = client.getQueryData<Run[]>(runsKey("p")) ?? [];
    expect(after.map((r) => [r.id, r.state])).toEqual([[id, "starting"]]);
    const out = section(after[0] as Run, false, client);
    expect(out).toContain(">Preparando<");
    expect(out).toContain(">Cancelar run<");
    expect(out).not.toContain(">Retomar<");
  });

  it("explains the endpoint's errors in Spanish, with what to do", async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "not_resumable",
            message: `The worktree of run ${id} is gone or left its branch; discard the run and run the task again`,
          },
        }),
        { status: 409 },
      )) as unknown as typeof globalThis.fetch;
    const error = await resumeRunRequest(createApi("ab".repeat(32), { fetch }), "p", id).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    const text = resumeErrorText((error as ApiError).code, "BE-01", (error as ApiError).message);
    expect(text).toBe(
      "No se puede retomar el run de BE-01: su worktree ya no existe o la tarea ya no está en curso. Descártalo y vuelve a ejecutar BE-01.",
    );
    expect(text).not.toContain("worktree of run");

    expect(resumeErrorText("no_adapter", "BE-01", "Konsora cannot run codex yet")).toContain(
      "Comprueba que su CLI está instalado",
    );
    expect(resumeErrorText("lock_timeout", "BE-01", "x")).toContain("Vuelve a pulsar Retomar");
    expect(resumeErrorText("not_found", "BE-01", "x")).toContain("Recarga la tarea");
    expect(resumeErrorText("network", "BE-01", "Failed to fetch")).toBe(
      "No se pudo retomar el run de BE-01: Failed to fetch",
    );
  });

  it("offers Resume on the queue page's interrupted runs", () => {
    const view: QueueView = {
      queue: { version: 1, state: "paused", entries: [] },
      status: [],
      limits: { max_parallel: 2, per_provider: {} },
      usage: { total: 0, per_provider: {} },
    };
    const html = renderToStaticMarkup(
      wrap(
        <ProjectQueueView
          project={{ id: "p", name: "Demo" }}
          view={view}
          runs={[
            run(),
            run({ id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PX", task: "BE-02", state: "running" }),
          ]}
        />,
        new QueryClient(),
      ),
    );
    expect(html).toContain("BE-01</a> · Interrumpido");
    expect(html.match(/>Retomar</g)).toHaveLength(1);
  });
});
