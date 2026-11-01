import type { ProviderRateLimits, Run } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { runEventsKey } from "../src/api/runs.ts";
import { RateLimitList } from "../src/shell/RateLimits.tsx";
import { RunSection } from "../src/shell/RunSection.tsx";
import { runUsage, windowLabel } from "../src/shell/run-model.ts";
import { ToastProvider } from "../src/ui/index.ts";

const run = (extra: Partial<Run> = {}): Run => ({
  id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PW",
  task: "BE-01",
  task_hash: `sha256:${"a".repeat(64)}`,
  agent: { provider: "claude", model: "sonnet", permissions: "default" },
  state: "succeeded",
  ...extra,
});

function section(r: Run, events: Record<string, unknown>[] = []) {
  const client = new QueryClient();
  client.setQueryData(runEventsKey("p", r.id), events);
  return renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <RunSection projectId="p" run={r} readOnly={false} />
        </ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
}

describe("a run's usage (UI-14)", () => {
  it("shows the breakdown: tokens, cache apart, reasoning and cost", () => {
    const html = section(
      run({
        usage: {
          input_tokens: 80772,
          output_tokens: 765,
          cost_usd: 0.005146,
          cache_read_tokens: 59948,
          cache_write_tokens: 20816,
          reasoning_tokens: 131,
        },
      }),
    );
    expect(html).toContain("Caché (de la entrada)");
    expect(html).toMatch(/leída · .* escrita/);
    expect(html).toContain("Razonamiento (de la salida)");
    expect(html).toContain("$0.01");
    expect(html).not.toContain("El proveedor no");
  });

  it("says when the provider gives no cost (Codex) or no usage at all", () => {
    const codex = section(
      run({
        agent: { provider: "codex", model: "gpt-6-luna" },
        usage: {
          input_tokens: 50604,
          output_tokens: 189,
          cost_usd: null,
          cache_read_tokens: 23808,
        },
      }),
    );
    expect(codex).toContain("El proveedor no lo da");
    expect(codex).toContain("Caché (de la entrada)");

    const none = section(run({ usage: { input_tokens: 0, output_tokens: 0, cost_usd: null } }));
    expect(none).toContain("El proveedor no da el uso");
    expect(none).not.toContain("Coste");
  });

  it("adds up the live usage events, breakdown included", () => {
    const events = [
      { at: "x", t: "usage", input_tokens: 100, output_tokens: 10, cache_read_tokens: 60 },
      { at: "x", t: "usage", rate_limits: { status: "allowed" } },
      { at: "x", t: "usage", input_tokens: 50, output_tokens: 5, cache_read_tokens: 40 },
    ];
    expect(runUsage(run({ state: "running" }), events)).toEqual({
      input: 150,
      output: 15,
      cost: null,
      cacheRead: 100,
    });
    expect(runUsage(run({ state: "running" }), [])).toBeNull();
  });
});

describe("rate limits on the project page (UI-14)", () => {
  const limits: ProviderRateLimits[] = [
    {
      provider: "claude",
      run: "r-01JC8Z3K2QX7M4V9T0B6N5R8PA",
      at: "2026-11-01T12:00:00Z",
      windows: [
        {
          window: "five_hour",
          status: "allowed",
          utilization: 0.68,
          resets_at: "2026-11-01T13:20:00Z",
        },
        { window: "seven_day", status: "allowed_warning", utilization: 0.92 },
      ],
    },
    {
      provider: "codex",
      run: "r-01JC8Z3K2QX7M4V9T0B6N5R8PB",
      at: "2026-11-01T14:00:00Z",
      windows: [
        {
          window: "window_90m",
          status: "rejected",
          utilization: 1,
          resets_at: "2026-11-01T15:00:00Z",
        },
      ],
    },
  ];

  it("shows each provider's windows with their use, status and reset", () => {
    const html = renderToStaticMarkup(<RateLimitList limits={limits} />);
    expect(html).toContain("claude");
    expect(html).toContain("codex");
    expect(html).toContain(">5 h<");
    expect(html).toContain(">7 días<");
    expect(html).toContain(">90 min<");
    expect(html).toContain("68 % usado");
    expect(html).toContain("92 % usado");
    expect(html).toContain("cerca del límite");
    expect(html).toContain("agotado");
    expect(html.match(/se reinicia el/g)).toHaveLength(2);
    expect(html).toContain('<meter class="b-limits__meter"');
  });

  it("shows nothing until a run has reported them", () => {
    expect(renderToStaticMarkup(<RateLimitList limits={[]} />)).toBe("");
    expect(windowLabel("weekly")).toBe("weekly");
  });
});
