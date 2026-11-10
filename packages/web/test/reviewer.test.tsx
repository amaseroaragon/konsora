import {
  type AgentCatalogEntry,
  applyOp,
  type Note,
  type Op,
  OpSchema,
  type Run,
  type TasksDocument,
} from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { agentsKey } from "../src/api/agents.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { requestReviewRequest, runsKey, useRequestReview } from "../src/api/runs.ts";
import { ReviewerSettings } from "../src/shell/ReviewerSettings.tsx";
import { RunReviews } from "../src/shell/ReviewSection.tsx";
import {
  reviewActive,
  reviewErrorText,
  reviewerFrom,
  reviewerOp,
  runReviews,
} from "../src/shell/reviewer-model.ts";
import { activeRun, latestRun, olderDiscardable } from "../src/shell/run-model.ts";
import { ToastProvider } from "../src/ui/index.ts";

const catalog: AgentCatalogEntry[] = [
  {
    provider: "claude",
    installed: true,
    version: "2.1.316",
    models: [{ id: "opus", label: "Claude Opus", efforts: ["low", "high"] }],
    open_models: true,
    profiles: ["default", "readonly"],
  },
  {
    provider: "codex",
    installed: true,
    version: "0.166.0",
    models: [{ id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["high"] }],
    open_models: false,
    profiles: ["default", "readonly"],
  },
];

const plan: TasksDocument = {
  schema: "konsora/2",
  project: { name: "Demo", base_branch: "main" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: {},
  tasks: [],
};

function apply(op: unknown, doc = plan) {
  const result = applyOp(structuredClone(doc), OpSchema.parse(op) as Op, {
    actor: "human",
    at: "2026-11-10T10:00:00Z",
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.document.project.reviewer;
}

function wrap(node: React.ReactNode, client = new QueryClient(), fetch?: typeof globalThis.fetch) {
  return (
    <ApiContext.Provider value={createApi("ab".repeat(32), fetch ? { fetch } : {})}>
      <QueryClientProvider client={client}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>
  );
}

const hash = `sha256:${"a".repeat(64)}`;
const work: Run = {
  id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PA",
  task: "BE-01",
  task_hash: hash,
  agent: { provider: "claude", model: "opus", permissions: "default" },
  state: "succeeded",
};
const review = (extra: Partial<Run> = {}): Run => ({
  id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PB",
  task: "BE-01",
  task_hash: hash,
  agent: { provider: "codex", model: "gpt-6-luna", effort: "high", permissions: "readonly" },
  state: "succeeded",
  kind: "review",
  review_of: work.id,
  usage: { input_tokens: 12_400, output_tokens: 900, cost_usd: 0.31 },
  ...extra,
});
const note = (extra: Partial<Note> = {}): Note => ({
  id: "n3",
  at: "2026-11-10T10:00:00Z",
  by: "agent:codex",
  kind: "review",
  verdict: "changes",
  text: "Falta el test del **caso vacío**.",
  run: review().id,
  ...extra,
});

describe("reviewer settings (UI-25 ac1)", () => {
  it("starts from the project's reviewer, or with none and the default agent", () => {
    const agent = { provider: "claude", model: "opus" } as const;
    expect(reviewerFrom({ agent, launch: "auto" }, undefined)).toEqual({
      launch: "auto",
      agent: { ...agent, permissions: "readonly" },
    });
    expect(reviewerFrom(undefined, { ...agent, permissions: "default" })).toEqual({
      launch: "none",
      agent: { ...agent, permissions: "readonly" },
    });
  });

  it("sets, changes and removes the reviewer with set-reviewer", () => {
    const agent = { provider: "codex", model: "gpt-6-luna", effort: "high" } as const;
    const set = reviewerOp(
      { launch: "manual", agent: { ...agent, permissions: "readonly" } },
      undefined,
      catalog,
    );
    expect(set).toEqual({
      ok: true,
      op: { op: "set-reviewer", reviewer: { agent, launch: "manual" } },
    });
    // Core takes it as is; the readonly profile is implied.
    expect(apply(set.ok ? set.op : null)).toEqual({ agent, launch: "manual" });

    const base = { agent, launch: "manual" } as const;
    expect(
      reviewerOp({ launch: "manual", agent: { ...agent, permissions: "readonly" } }, base, catalog),
    ).toEqual({ ok: true, op: null });
    expect(
      reviewerOp({ launch: "auto", agent: { ...agent, permissions: "readonly" } }, base, catalog),
    ).toEqual({ ok: true, op: { op: "set-reviewer", reviewer: { agent, launch: "auto" } } });

    const removed = reviewerOp({ launch: "none", agent: undefined }, base, catalog);
    expect(removed).toEqual({ ok: true, op: { op: "set-reviewer", reviewer: null } });
    expect(
      apply(removed.ok ? removed.op : null, {
        ...plan,
        project: { ...plan.project, reviewer: base },
      }),
    ).toBeUndefined();
  });

  it("refuses a reviewer without a runnable agent, in Spanish", () => {
    expect(reviewerOp({ launch: "auto", agent: undefined }, undefined, catalog)).toEqual({
      ok: false,
      error: "Elige un modelo.",
    });
    const unknown = reviewerOp(
      { launch: "auto", agent: { provider: "codex", model: "nope", permissions: "readonly" } },
      undefined,
      catalog,
    );
    expect(unknown.ok).toBe(false);
  });

  it("posts the op to the project's ops", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const op = reviewerOp(
      { launch: "auto", agent: { provider: "claude", model: "opus", permissions: "readonly" } },
      undefined,
      catalog,
    );
    await createApi("ab".repeat(32), { fetch }).post("/projects/p/ops", op.ok ? op.op : null);
    expect(calls).toEqual([
      {
        url: "/api/projects/p/ops",
        body: {
          op: "set-reviewer",
          reviewer: { agent: { provider: "claude", model: "opus" }, launch: "auto" },
        },
      },
    ]);
  });

  it("offers when it reviews and, with a reviewer, its agent with the readonly profile alone", () => {
    const client = new QueryClient();
    client.setQueryData(agentsKey, catalog);
    const html = renderToStaticMarkup(
      wrap(
        <ReviewerSettings
          projectId="p"
          reviewer={{ agent: { provider: "claude", model: "opus" }, launch: "auto" }}
          defaults={undefined}
          readOnly={false}
        />,
        client,
      ),
    );
    expect(html).toContain("Revisor automático");
    expect(html).toContain("Solo, cada vez que una tarea llega a revisión");
    expect(html).toContain("Agente revisor");
    expect(html).toContain('<option value="readonly" selected="">readonly</option>');
    expect(html).not.toContain('<option value="default"');

    const none = renderToStaticMarkup(
      wrap(<ReviewerSettings projectId="p" reviewer={undefined} defaults={undefined} readOnly />),
    );
    expect(none).not.toContain("Agente revisor");
  });
});

describe("reviews of a run (UI-25 ac2)", () => {
  it("pairs each review run of the run with the review note it left", () => {
    const other = review({
      id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PC",
      review_of: "r-01JC8Z3K2QX7M4V9T0B6N5R8PZ",
    });
    const reviews = runReviews(
      [work, review(), other],
      [note(), note({ id: "n4", kind: "note", verdict: undefined })],
      work.id,
    );
    expect(reviews).toEqual([{ run: review(), note: note() }]);
    expect(reviewActive(reviews)).toBe(false);
    expect(reviewActive(runReviews([work, review({ state: "running" })], [], work.id))).toBe(true);
  });

  it("never takes a review run for the task's run", () => {
    const runs = [work, review({ state: "running" })];
    expect(latestRun(runs, "BE-01")?.id).toBe(work.id);
    expect(activeRun(runs, "BE-01")).toBeUndefined();
    expect(olderDiscardable([work, review()], "BE-01")).toEqual([]);
  });

  it("shows each review's verdict, reasons, agent and usage", () => {
    const client = new QueryClient();
    client.setQueryData(runsKey("p"), [work, review()]);
    const html = renderToStaticMarkup(
      wrap(
        <RunReviews projectId="p" run={work} notes={[note()]} hasReviewer readOnly={false} />,
        client,
      ),
    );
    expect(html).toContain(">Revisiones<");
    expect(html).toContain(">Pediría cambios<");
    expect(html).toContain("<strong>caso vacío</strong>");
    expect(html).toContain("codex · gpt-6-luna · high");
    expect(html).toContain("12.4k / 900 · $0.31");
    expect(html).toMatch(/<button[^>]*>Pedir revisión</);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Pedir revisión</);

    const approve = renderToStaticMarkup(
      wrap(
        <RunReviews
          projectId="p"
          run={work}
          notes={[note({ verdict: "approve", text: "Cumple ac1 y ac2." })]}
          hasReviewer
          readOnly
        />,
        client,
      ),
    );
    expect(approve).toContain(">Aprobaría<");
    expect(approve).toContain("Cumple ac1 y ac2.");
    expect(approve).not.toContain("Pedir revisión");
  });

  it("waits for a running review, and asks for a reviewer when the project has none", () => {
    const client = new QueryClient();
    client.setQueryData(runsKey("p"), [work, review({ state: "running", usage: undefined })]);
    const running = renderToStaticMarkup(
      wrap(<RunReviews projectId="p" run={work} notes={[]} hasReviewer readOnly={false} />, client),
    );
    expect(running).toContain("Revisando…");
    expect(running).toMatch(/<button[^>]*disabled=""[^>]*>Pedir revisión</);

    const empty = new QueryClient();
    empty.setQueryData(runsKey("p"), [work]);
    const none = renderToStaticMarkup(
      wrap(
        <RunReviews projectId="p" run={work} notes={[]} hasReviewer={false} readOnly={false} />,
        empty,
      ),
    );
    expect(none).toMatch(/<button[^>]*disabled=""[^>]*>Pedir revisión</);
    expect(none).toContain("Elige un revisor en los ajustes del proyecto");
  });

  it("Request review launches the review run and lists it", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET", body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ run: review({ state: "starting" }) }), { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const client = new QueryClient();
    client.setQueryData(runsKey("p"), [work]);
    let mutate: ((run: string) => Promise<Run>) | undefined;
    function Probe() {
      mutate = useRequestReview("p").mutateAsync;
      return null;
    }
    renderToStaticMarkup(wrap(<Probe />, client, fetch));
    await mutate?.(work.id);
    expect(calls).toEqual([
      { url: `/api/projects/p/runs/${work.id}/review`, method: "POST", body: {} },
    ]);
    const runs = client.getQueryData<Run[]>(runsKey("p")) ?? [];
    expect(runReviews(runs, [], work.id).map((r) => r.run.state)).toEqual(["starting"]);

    // With an explicit agent, it goes in the body.
    const agent = { provider: "claude", model: "opus" } as const;
    await requestReviewRequest(createApi("ab".repeat(32), { fetch }), "p", work.id, agent);
    expect(calls.at(-1)?.body).toEqual({ agent });
  });

  it("explains the endpoint's errors in Spanish", () => {
    expect(reviewErrorText("invalid_agent", "BE-01", "Choose an agent")).toContain(
      "Elige otro en los ajustes del proyecto",
    );
    expect(reviewErrorText("active_run", "BE-01", "x")).toBe(
      "Ya hay una revisión en marcha para este run de BE-01. Espera a que termine.",
    );
    expect(reviewErrorText("not_reviewable", "BE-01", "x")).toContain("ya no está en revisión");
    expect(reviewErrorText("network", "BE-01", "Failed to fetch")).toBe(
      "No se pudo pedir la revisión de BE-01: Failed to fetch",
    );
  });
});
