import type { Run } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { applyRunMessage, discardRunRequest, runEventsKey, runsKey } from "../src/api/runs.ts";
import { OrphanList } from "../src/shell/Orphans.tsx";
import { RunSection } from "../src/shell/RunSection.tsx";
import { canDiscard } from "../src/shell/run-model.ts";
import { ToastProvider } from "../src/ui/index.ts";

const run = (extra: Partial<Run> = {}): Run => ({
  id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PW",
  task: "BE-01",
  task_hash: `sha256:${"a".repeat(64)}`,
  agent: { provider: "claude", model: "sonnet", permissions: "default" },
  state: "cancelled",
  ...extra,
});

function section(r: Run, readOnly = false, client = new QueryClient()) {
  client.setQueryData(runEventsKey("p", r.id), []);
  return renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <RunSection projectId="p" run={r} readOnly={readOnly} />
        </ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
}

describe("discarding runs (RUN-10)", () => {
  it("is offered only on finished runs that were neither integrated nor discarded", () => {
    expect(canDiscard(run({ state: "cancelled" }))).toBe(true);
    expect(canDiscard(run({ state: "failed" }))).toBe(true);
    expect(canDiscard(run({ state: "succeeded" }))).toBe(true); // e.g. after sending the task back
    expect(canDiscard(run({ state: "succeeded", integration: { state: "conflict" } }))).toBe(true);
    expect(canDiscard(run({ state: "running" }))).toBe(false);
    expect(canDiscard(run({ state: "interrupted" }))).toBe(false);
    expect(canDiscard(run({ state: "succeeded", integration: { state: "merged" } }))).toBe(false);
    expect(canDiscard(run({ state: "failed", integration: { state: "discarded" } }))).toBe(false);

    expect(section(run())).toContain(">Descartar run<");
    expect(section(run(), true)).not.toContain(">Descartar run<");
    expect(section(run({ state: "running" }))).not.toContain(">Descartar run<");
    const merged = section(run({ state: "succeeded", integration: { state: "merged" } }));
    expect(merged).not.toContain(">Descartar run<");
    expect(merged).toContain(">Integrado<");
  });

  it("warns when the run went over codex exec (RUN-15)", () => {
    const exec = section(
      run({ agent: { provider: "codex", model: "gpt-6-luna" }, transport: "exec" }),
    );
    expect(exec).toContain("no admite aprobaciones");
    expect(section(run({ transport: "app-server" }))).not.toContain("no admite aprobaciones");
    expect(section(run())).not.toContain("no admite aprobaciones");
  });

  it("posts the discard and reflects the result", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET" });
      return new Response(JSON.stringify({ run: run({ integration: { state: "discarded" } }) }), {
        status: 200,
      });
    }) as unknown as typeof globalThis.fetch;
    const discarded = await discardRunRequest(createApi("ab".repeat(32), { fetch }), "p", run().id);
    expect(calls).toEqual([{ url: `/api/projects/p/runs/${run().id}/discard`, method: "POST" }]);

    const client = new QueryClient();
    client.setQueryData(runsKey("p"), [run()]);
    applyRunMessage(client, "p", { type: "run.state", run: discarded });
    const after = client.getQueryData<Run[]>(runsKey("p"))?.[0] as Run;
    const out = section(after, false, client);
    expect(out).toContain(">Descartado<");
    expect(out).not.toContain(">Descartar run<");
  });
});

describe("orphan worktrees (RUN-10)", () => {
  it("lists folder names and branches, never the private path", () => {
    const out = renderToStaticMarkup(
      <OrphanList
        orphans={[
          {
            worktree: "/home/me/.local/share/konsora/worktrees/p-1/BE-09-AAAA",
            branch: "konsora/BE-09/AAAA",
            reason: "no_run",
          },
          { branch: "konsora/BE-07/CCCC", reason: "run_closed" },
          { worktree: "/home/me/.local/share/konsora/worktrees/p-1/leftover", reason: "stray_dir" },
        ]}
      />,
    );
    expect(out).toContain("3 worktrees o ramas de Konsora que ningún run necesita:");
    expect(out).toContain("konsora/BE-09/AAAA");
    expect(out).toContain("BE-09-AAAA");
    expect(out).toContain("(carpeta que git no conoce)");
    expect(out).not.toContain("/home/me");
    expect(renderToStaticMarkup(<OrphanList orphans={[]} />)).toBe("");
  });
});

describe("earlier runs (RUN-10)", () => {
  it("lists the task's earlier runs that still hold a worktree, newest first", async () => {
    const { olderDiscardable } = await import("../src/shell/run-model.ts");
    const a = run({ id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PA" });
    const b = run({ id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PB", integration: { state: "discarded" } });
    const c = run({ id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PC", state: "failed" });
    const latest = run({ id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PD" });
    const other = run({ id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PE", task: "BE-02" });
    expect(olderDiscardable([a, b, c, latest, other], "BE-01").map((r) => r.id)).toEqual([
      c.id,
      a.id,
    ]);
    expect(olderDiscardable([latest], "BE-01")).toEqual([]);
    expect(olderDiscardable(undefined, "BE-01")).toEqual([]);
  });
});
