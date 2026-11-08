import { describe, expect, it } from "vitest";
import { type AgentCatalogEntry, checkAgent, runAgentFor } from "../src/agents.ts";
import type { AgentSpec, Task, TasksDocument } from "../src/schema.ts";

const claude: AgentCatalogEntry = {
  provider: "claude",
  installed: true,
  models: [{ id: "opus", label: "Claude Opus", efforts: ["low", "high"] }],
  open_models: true,
  profiles: ["default"],
};
const codex: AgentCatalogEntry = {
  provider: "codex",
  installed: true,
  models: [{ id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "ultra"] }],
  open_models: false,
  profiles: ["default"],
};

describe("checkAgent", () => {
  it("accepts what the adapter declares", () => {
    expect(checkAgent({ provider: "codex", model: "gpt-6-luna", effort: "low" }, codex)).toEqual({
      ok: true,
    });
    expect(
      checkAgent({ provider: "claude", model: "opus", permissions: "default" }, claude).ok,
    ).toBe(true);
  });

  it("passes unlisted models through only for providers that take them", () => {
    expect(
      checkAgent({ provider: "claude", model: "claude-opus-5-5", effort: "max" }, claude).ok,
    ).toBe(true);
    expect(checkAgent({ provider: "codex", model: "gpt-9" }, codex)).toEqual({
      ok: false,
      code: "model",
      options: ["gpt-6-luna"],
      reason: 'codex has no model "gpt-9"; use "gpt-6-luna"',
    });
  });

  it("does not block on a model list the provider could not give", () => {
    const broken = { ...codex, models: [], models_error: "codex app-server exited" };
    expect(checkAgent({ provider: "codex", model: "gpt-9" }, broken).ok).toBe(true);
  });

  it("only offers the efforts Konsora can ask for", () => {
    expect(checkAgent({ provider: "codex", model: "gpt-6-luna", effort: "high" }, codex)).toEqual({
      ok: false,
      code: "effort",
      options: ["low"],
      reason: 'gpt-6-luna does not take effort "high"; use "low" or none',
    });
  });

  it("refuses providers without an adapter or not installed", () => {
    expect(checkAgent({ provider: "codex", model: "x" }, undefined).ok).toBe(false);
    expect(
      checkAgent({ provider: "codex", model: "x" }, { ...codex, installed: false }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not installed"),
    });
  });
});

describe("runAgentFor", () => {
  const at = "2026-11-08T10:00:00Z";
  const asked: AgentSpec = { provider: "codex", model: "gpt-6-luna" };
  const own: AgentSpec = { provider: "claude", model: "own" };
  const hard: AgentSpec = { provider: "claude", model: "opus", effort: "high" };
  const easy: AgentSpec = { provider: "claude", model: "haiku" };
  const fallback: AgentSpec = { provider: "claude", model: "sonnet" };
  const task = (extra: Partial<Task> = {}): Task => ({
    id: "BE-01",
    title: "t",
    state: "todo",
    group: "BE",
    rank: "a",
    created: { at, by: "human" },
    updated_at: at,
    ...extra,
  });
  const doc = (project: Partial<TasksDocument["project"]> = {}): TasksDocument => ({
    schema: "konsora/2",
    project: { name: "P", base_branch: "main", ...project },
    groups: [{ id: "BE", name: "BE" }],
    seq: { BE: 1 },
    tasks: [],
  });
  const full = doc({ defaults: fallback, recommended: { high: hard, low: easy } });

  it("prefers the agent asked for", () => {
    expect(runAgentFor(task({ agent: own, difficulty: "high" }), full, asked)).toBe(asked);
  });
  it("then the task's agent", () => {
    expect(runAgentFor(task({ agent: own, difficulty: "high" }), full)).toBe(own);
  });
  it("then the one recommended for the task's difficulty", () => {
    expect(runAgentFor(task({ difficulty: "high" }), full)).toBe(hard);
    expect(runAgentFor(task({ difficulty: "low" }), full)).toBe(easy);
  });
  it("then the project's defaults, when the difficulty has no recommendation or there is none", () => {
    expect(runAgentFor(task({ difficulty: "medium" }), full)).toBe(fallback);
    expect(runAgentFor(task(), full)).toBe(fallback);
    expect(runAgentFor(task({ difficulty: "high" }), doc({ defaults: fallback }))).toBe(fallback);
  });
  it("and nothing when there is nothing to use", () => {
    expect(runAgentFor(task({ difficulty: "high" }), doc())).toBeUndefined();
  });
});
