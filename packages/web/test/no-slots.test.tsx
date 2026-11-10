import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError, createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { enqueueRequest } from "../src/api/queue.ts";
import { startRunRequest } from "../src/api/runs.ts";
import { launchEach, startErrorText } from "../src/shell/run-model.ts";
import { SelectionBar } from "../src/shell/SelectionBar.tsx";
import { ToastProvider } from "../src/ui/index.ts";

const agent = { provider: "codex", model: "gpt-6-luna", permissions: "default" } as const;

type Call = { method: string; url: string; body: unknown };

/** A daemon with `slots` free slots: it refuses runs with 409 no_slots when none is left. */
function daemon(slots: number) {
  const calls: Call[] = [];
  let free = slots;
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ method: init.method ?? "GET", url, body });
    if (url.endsWith("/runs")) {
      if (free === 0) {
        return new Response(
          JSON.stringify({ error: { code: "no_slots", message: "0 of 1 are free" } }),
          { status: 409 },
        );
      }
      free--;
      return new Response(JSON.stringify({ run: { id: `r-${body.task}` } }), { status: 201 });
    }
    return new Response(JSON.stringify({ added: [body.items?.[0]?.task], already: [] }), {
      status: 200,
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, api: createApi("ab".repeat(32), { fetch }) };
}

describe("Run when max_parallel has no slot (DMN-11)", () => {
  it("explains the refusal in Spanish and queues the task with the same agent", async () => {
    const { calls, api } = daemon(0);
    const item = { task: "BE-01", agent };
    const error = await startRunRequest(api, "p", item).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("no_slots");
    const text = startErrorText("no_slots", "BE-01", (error as ApiError).message);
    expect(text).toContain("BE-01 no cabe ahora");
    expect(text).toContain("encolarla");
    expect(text).not.toContain("0 of 1");

    // The Queue button sends the task to the queue with the agent that was refused.
    await enqueueRequest(api, "p", [item]);
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", "/api/projects/p/runs"],
      ["POST", "/api/projects/p/queue"],
    ]);
    expect(calls[1]?.body).toEqual({ items: [{ task: "BE-01", agent }] });
  });

  it("keeps the variants' wording for variants and the old one for other errors", () => {
    expect(startErrorText("not_ready", "BE-01", "")).toBe("BE-01 no está lista para ejecutarse.");
  });
});

describe("Run from the selection bar when only some tasks fit (DMN-11)", () => {
  const items = ["BE-01", "BE-02", "BE-03"].map((task) => ({ task, agent }));

  it("launches the ones that fit and reports the rest to be queued", async () => {
    const { calls, api } = daemon(1);
    const outcome = await launchEach(items, (item) => startRunRequest(api, "p", item));
    expect(outcome).toEqual({
      started: ["BE-01"],
      unfit: ["BE-02", "BE-03"],
      failed: [],
      unauthorized: false,
    });
    // Every task was tried, each with its own agent, and nothing was queued by itself.
    expect(calls.map((c) => (c.body as { task: string }).task)).toEqual([
      "BE-01",
      "BE-02",
      "BE-03",
    ]);
    expect(calls.every((c) => c.url.endsWith("/runs"))).toBe(true);

    // Encolar sends exactly the ones that did not fit, with the same agents.
    await enqueueRequest(
      api,
      "p",
      items.filter((item) => outcome.unfit.includes(item.task)),
    );
    expect(calls.at(-1)?.body).toEqual({
      items: [
        { task: "BE-02", agent },
        { task: "BE-03", agent },
      ],
    });
  });

  it("keeps other failures apart from the missing slots", async () => {
    const outcome = await launchEach(items, async (item) => {
      if (item.task === "BE-02") throw new ApiError(409, "not_ready", "not ready");
      if (item.task === "BE-03") throw new ApiError(409, "no_slots", "full");
    });
    expect(outcome.started).toEqual(["BE-01"]);
    expect(outcome.unfit).toEqual(["BE-03"]);
    expect(outcome.failed).toEqual([{ task: "BE-02", code: "not_ready", message: "not ready" }]);
  });

  it("stops at an unauthorized answer", async () => {
    const outcome = await launchEach(items, async () => {
      throw new ApiError(403, "forbidden", "no");
    });
    expect(outcome).toEqual({ started: [], unfit: [], failed: [], unauthorized: true });
  });

  it("offers Encolar for the refused tasks, in Spanish", () => {
    const bar = (full: string[]) =>
      renderToStaticMarkup(
        <ApiContext.Provider value={createApi("t".repeat(64))}>
          <QueryClientProvider client={new QueryClient()}>
            <ToastProvider>
              <SelectionBar
                ids={["BE-02", "BE-03"]}
                runnable={["BE-02", "BE-03"]}
                readOnly={false}
                onRun={() => {}}
                onClear={() => {}}
                queueable={["BE-02", "BE-03"]}
                onQueue={() => {}}
                full={full}
              />
            </ToastProvider>
          </QueryClientProvider>
        </ApiContext.Provider>,
      );
    const html = bar(["BE-02", "BE-03"]);
    expect(html).toContain("No caben ahora, por el máximo de runs en paralelo: BE-02, BE-03.");
    expect(html).toContain(">Encolar<");
    expect(bar([])).not.toContain("No caben ahora");
  });
});
