import type { AgentCatalogEntry } from "@konsora/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { editBody } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { startRunRequest } from "../src/api/runs.ts";
import { AgentPicker } from "../src/shell/AgentPicker.tsx";
import {
  agentProblem,
  changeAgent,
  effortOptions,
  initialAgent,
  initialBatchAgent,
  modelOptions,
} from "../src/shell/agent-model.ts";
import { changesFrom, draftFrom } from "../src/shell/edit-model.ts";

const catalog: AgentCatalogEntry[] = [
  {
    provider: "claude",
    installed: true,
    version: "2.1.316",
    models: [
      { id: "opus", label: "Claude Opus", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "haiku", label: "Claude Haiku", efforts: ["low", "medium"] },
    ],
    open_models: true,
    profiles: ["default"],
  },
  {
    provider: "codex",
    installed: true,
    version: "0.166.0",
    models: [
      { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: ["low", "ultra"] },
    ],
    open_models: false,
    profiles: ["default"],
  },
];
const noCodex = catalog.map((e) =>
  e.provider === "codex" ? { ...e, installed: false, models: [] } : e,
);

const optionsOf = (html: string, label: string) => {
  const select = html.split(`>${label}</span>`)[1]?.split("</select>")[0] ?? "";
  return [...select.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)</g)].map((m) => ({
    value: m[1],
    disabled: /disabled/.test(m[2] ?? ""),
    text: m[3],
  }));
};

describe("where the selector starts (UI-13)", () => {
  it("from the task's agent, else the project's default, else the first available", () => {
    const plan = {
      defaults: { provider: "claude" as const, model: "opus", effort: "high" as const },
    };
    expect(
      initialAgent({ agent: { provider: "codex", model: "gpt-6-luna" } }, plan, catalog),
    ).toEqual({
      provider: "codex",
      model: "gpt-6-luna",
      permissions: "default",
    });
    expect(initialAgent({}, plan, catalog)).toEqual({ ...plan.defaults, permissions: "default" });
    expect(initialAgent({}, {}, catalog)).toEqual({
      provider: "claude",
      model: "opus",
      permissions: "default",
    });
  });

  it("the selection bar starts from the agent the tasks share, else the project's", () => {
    const plan = { defaults: { provider: "claude" as const, model: "opus" } };
    const luna = { provider: "codex" as const, model: "gpt-6-luna" };
    expect(initialBatchAgent([{ agent: luna }, { agent: luna }], plan, catalog)).toMatchObject(
      luna,
    );
    expect(initialBatchAgent([{ agent: luna }, {}], plan, catalog)).toMatchObject(plan.defaults);
  });
});

describe("the selector offers only what each adapter declares", () => {
  it("lists the provider's models and the chosen model's efforts", () => {
    const html = renderToStaticMarkup(
      <AgentPicker
        agent={{ provider: "codex", model: "gpt-6.1-sol", permissions: "default" }}
        catalog={catalog}
        onChange={() => {}}
      />,
    );
    expect(optionsOf(html, "Modelo").map((o) => o.value)).toEqual(["gpt-6-luna", "gpt-6.1-sol"]);
    // gpt-6.1-sol declares low and ultra; Konsora cannot ask for ultra.
    expect(optionsOf(html, "Esfuerzo").map((o) => o.value)).toEqual(["", "low"]);
    expect(optionsOf(html, "Permisos").map((o) => o.value)).toEqual(["default"]);
  });

  it("keeps a full Claude id saved in the task, since Claude Code takes them", () => {
    const claude = catalog[0];
    expect(modelOptions(claude, "claude-opus-5-5").map((m) => m.id)).toEqual([
      "opus",
      "haiku",
      "claude-opus-5-5",
    ]);
    expect(modelOptions(catalog[1], "gpt-9").map((m) => m.id)).toEqual([
      "gpt-6-luna",
      "gpt-6.1-sol",
    ]);
    expect(effortOptions(claude, "claude-opus-5-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("drops what a new provider or model does not take", () => {
    const opusMax = {
      provider: "claude" as const,
      model: "opus",
      effort: "max" as const,
      permissions: "default",
    };
    expect(changeAgent(opusMax, { field: "model", value: "haiku" }, catalog)).toEqual({
      provider: "claude",
      model: "haiku",
      permissions: "default",
    });
    expect(changeAgent(opusMax, { field: "provider", value: "codex" }, catalog)).toEqual({
      provider: "codex",
      model: "gpt-6-luna",
      effort: "max",
      permissions: "default",
    });
  });
});

describe("a provider that is not installed", () => {
  it("is listed disabled, with why, and cannot run", () => {
    const html = renderToStaticMarkup(
      <AgentPicker
        agent={{ provider: "codex", model: "gpt-6-luna", permissions: "default" }}
        catalog={noCodex}
        onChange={() => {}}
      />,
    );
    expect(optionsOf(html, "Proveedor")).toEqual([
      { value: "claude", disabled: false, text: "claude" },
      { value: "codex", disabled: true, text: "codex (no instalado)" },
    ]);
    expect(html).toContain("codex no está instalado o no está en el PATH");
    expect(agentProblem({ provider: "claude", model: "opus" }, noCodex)).toBeNull();
  });

  it("explains a declared model that does not take the effort", () => {
    expect(agentProblem({ provider: "claude", model: "haiku", effort: "max" }, catalog)).toBe(
      "haiku no admite ese esfuerzo; usa low, medium o el de por defecto.",
    );
  });
});

describe("launching and saving the chosen agent", () => {
  it("sends the chosen agent with the launch", async () => {
    const calls: { body: unknown }[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      calls.push({ body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ run: { id: "r-1" } }), { status: 201 });
    }) as typeof globalThis.fetch;
    const api = createApi("ab".repeat(32), { fetch });
    const start = initialAgent({}, {}, catalog);
    const chosen = changeAgent(
      start ?? { provider: "claude", model: "opus" },
      { field: "provider", value: "codex" },
      catalog,
    );
    await startRunRequest(api, "p", { task: "BE-01", agent: chosen });
    expect(calls[0]?.body).toEqual({
      task: "BE-01",
      agent: { provider: "codex", model: "gpt-6-luna", permissions: "default" },
    });
  });

  it("saves the task's agent with the edit op, and refuses one that cannot run", () => {
    const task = { id: "BE-01", title: "T", group: "BE" };
    const groups = [{ id: "BE" }];
    const agent = { provider: "codex" as const, model: "gpt-6-luna", permissions: "default" };
    const check = changesFrom({ ...draftFrom(task), agent }, task, groups, null);
    expect(check).toEqual({ ok: true, changes: { agent }, empty: false });
    expect(
      editBody({
        op: "edit",
        task: "BE-01",
        hash: "sha256:x",
        changes: check.ok ? check.changes : {},
      }),
    ).toEqual({
      op: "edit",
      task: "BE-01",
      expect: { "BE-01": "sha256:x" },
      changes: { agent },
    });
    expect(changesFrom({ ...draftFrom(task), agent }, task, groups, "no instalado")).toEqual({
      ok: false,
      field: "agent",
      message: "no instalado",
    });
    // Untouched, or the same agent again, is not a change.
    expect(
      changesFrom(draftFrom({ ...task, agent }), { ...task, agent }, groups).ok && "empty",
    ).toBe("empty");
  });
});
