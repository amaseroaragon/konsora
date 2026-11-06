import type { ProviderLimits } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError, createApi } from "../src/api/client.ts";
import { applyLimitsMessage, limitsKey } from "../src/api/limits.ts";
import { ApiContext } from "../src/api/projects.ts";
import { LimitsLink, LimitsList } from "../src/shell/LimitsPage.tsx";
import { ago, headerSummary, resetText, sourceText, until } from "../src/shell/limits-model.ts";
import { parseRoute } from "../src/shell/route.ts";
import { windowLabel } from "../src/shell/run-model.ts";
import { NoSession, QueryError, Shell } from "../src/shell/Shell.tsx";

const NOW = Date.parse("2026-11-06T20:00:00Z");

const limits: ProviderLimits[] = [
  {
    provider: "claude",
    source: "provider",
    at: "2026-11-06T19:57:00Z",
    windows: [
      { window: "five_hour", utilization: 0.1, resets_at: "2026-11-07T00:19:00Z" },
      { window: "seven_day", utilization: 0.84, resets_at: "2026-11-09T09:59:00Z" },
      { window: "seven_day_sonnet", utilization: 0.07 },
    ],
  },
  {
    provider: "codex",
    source: "run",
    at: "2026-11-06T17:00:00Z",
    run: "r-01JC8Z3K2QX7M4V9T0B6N5R8PB",
    unavailable: "Could not read Codex rate limits: Codex is not installed or not on PATH",
    windows: [{ window: "window_90m", status: "rejected", utilization: 1 }],
  },
];

function withLimits(node: React.ReactNode, data: ProviderLimits[] | undefined) {
  const client = new QueryClient();
  if (data) client.setQueryData(limitsKey, data);
  return renderToStaticMarkup(
    <ApiContext.Provider value={createApi("t".repeat(64))}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </ApiContext.Provider>,
  );
}

describe("the limits view (UI-15)", () => {
  it("is one click away from every screen: a header link to #/limites", () => {
    expect(parseRoute("#/limites")).toEqual({ name: "limits" });
    const html = withLimits(
      <Shell nav={<LimitsLink current={false} />}>
        <p>page</p>
      </Shell>,
      limits,
    );
    expect(html).toContain('href="#/limites"');
    expect(html).toContain("Límites");
    // The header already says how close each provider is to its limit.
    expect(html).toContain("Claude Code 84 % · Codex 100 %");
    const current = withLimits(<LimitsLink current />, []);
    expect(current).toContain('aria-current="page"');
    // Without a session there is no link (nothing to read limits with).
    expect(renderToStaticMarkup(<NoSession />)).not.toContain("#/limites");
  });

  it("shows each window with its use, status and reset, and how old and where the data is from", () => {
    const html = renderToStaticMarkup(<LimitsList limits={limits} now={NOW} />);
    expect(html).toContain("Claude Code");
    expect(html).toContain("Codex");
    expect(html).toContain("Leídos del proveedor hace 3 min");
    expect(html).toContain("Según el run r-01JC8Z3K2QX7M4V9T0B6N5R8PB, hace 3 h");
    expect(html).toContain(">5 h<");
    expect(html).toContain(">7 días<");
    expect(html).toContain(">7 días (sonnet)<");
    expect(html).toContain(">90 min<");
    expect(html).toContain("84 %");
    expect(html).toContain("agotado");
    expect(html).toContain("en 4 h 19 min");
    expect(html).toContain("en 3 d");
    expect(html.match(/<meter/g)).toHaveLength(4);
    expect(html).toContain('<th scope="col">Reinicio</th>');
  });

  it("says when a provider gives no data instead of leaving it empty", () => {
    const none: ProviderLimits = {
      provider: "claude",
      source: "none",
      windows: [],
      unavailable: "This provider has no way to read its limits without a run",
    };
    const html = renderToStaticMarkup(<LimitsList limits={[none]} now={NOW} />);
    expect(html).toContain("Todavía no hay datos de este proveedor.");
    expect(html).toContain("No se pudieron leer directamente: This provider has no way");
    expect(html).not.toContain("<table");
  });

  it("formats ages and resets, and a reset already past", () => {
    expect(ago("2026-11-06T19:59:30Z", NOW)).toBe("hace un momento");
    expect(ago("2026-11-04T19:00:00Z", NOW)).toBe("hace 2 d");
    expect(until("2026-11-06T20:00:20Z", NOW)).toBe("en 1 min");
    expect(until("2026-11-06T22:00:00Z", NOW)).toBe("en 2 h");
    expect(until("2026-11-06T19:00:00Z", NOW)).toBeNull();
    expect(resetText({ window: "five_hour", resets_at: "2026-11-06T19:00:00Z" }, NOW)).toMatch(
      /^ya pasó/,
    );
    expect(resetText({ window: "five_hour" }, NOW)).toBeNull();
    expect(sourceText({ provider: "codex", source: "none", windows: [] }, NOW)).toBe(
      "Todavía no hay datos de este proveedor.",
    );
    expect(headerSummary([])).toBe("");
    expect(windowLabel("seven_day_sonnet")).toBe("7 días (sonnet)");
  });

  it("applies limits.updated to the cache without refetching", () => {
    const client = new QueryClient();
    applyLimitsMessage(client, { limits });
    expect(client.getQueryData(limitsKey)).toEqual(limits);
    applyLimitsMessage(client, { limits: "nope" });
    expect(client.getQueryData(limitsKey)).toEqual(limits);
  });
});

describe("a daemon older than the UI", () => {
  it("explains how to restart it instead of showing Not found", () => {
    const old = new ApiError(404, "not_found", "Not found");
    const html = renderToStaticMarkup(<QueryError error={old} retry={() => undefined} />);
    expect(html).toContain("konsora ui --restart");
    expect(html).not.toContain("Not found");
    const newer = new ApiError(404, "unknown_endpoint", "Unknown endpoint");
    expect(renderToStaticMarkup(<QueryError error={newer} retry={() => undefined} />)).toContain(
      "anterior a esta versión",
    );
    // A real missing thing keeps its own message.
    const missing = new ApiError(404, "not_found", "Task BE-09 does not exist");
    expect(renderToStaticMarkup(<QueryError error={missing} retry={() => undefined} />)).toContain(
      "Task BE-09 does not exist",
    );
  });
});
