import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type AgentCatalogEntry,
  agentChoice,
  checkAgent,
  DEFAULT_PROFILE_COMMANDS,
  runAgentFor,
} from "../src/agents.ts";
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
  it("agentChoice says where the agent comes from (UI-21)", () => {
    const p = full.project;
    expect(agentChoice(task({ agent: own }), p, asked)).toEqual({
      agent: asked,
      source: "requested",
    });
    expect(agentChoice(task({ agent: own, difficulty: "high" }), p)).toEqual({
      agent: own,
      source: "task",
    });
    expect(agentChoice(task({ difficulty: "high" }), p)).toEqual({
      agent: hard,
      source: "recommended",
      difficulty: "high",
    });
    expect(agentChoice(task({ difficulty: "medium" }), p)).toEqual({
      agent: fallback,
      source: "defaults",
    });
    expect(agentChoice(task(), doc().project)).toBeUndefined();
  });
});

describe("commands the docs propose", () => {
  const root = new URL("../../../", import.meta.url);
  const read = (file: string) => readFileSync(new URL(file, root), "utf8");
  const docs = readdirSync(new URL("docs/", root))
    .filter((file) => file.endsWith(".md"))
    .map((file) => `docs/${file}`);

  /** The lines of the fenced code blocks and the backtick spans of a markdown file. */
  function proposed(text: string): string[] {
    const fence = /```[a-z]*\n([\s\S]*?)```/g;
    const fenced = [...text.matchAll(fence)].flatMap((m) =>
      (m[1] ?? "")
        .split("\n")
        .map((line) => line.replace(/\s+#.*$/, "").trim())
        .filter((line) => line !== ""),
    );
    const spans = [...text.replace(fence, "").matchAll(/`([^`\n]+)`/g)].map((m) =>
      (m[1] ?? "").trim(),
    );
    return [...fenced, ...spans];
  }

  /** Whether the `default` permission profile lets a run run `command` without asking. */
  function allowedByDefault(command: string): boolean {
    return DEFAULT_PROFILE_COMMANDS.some(({ command: allowed, prefix }) =>
      prefix ? command === allowed || command.startsWith(`${allowed} `) : command === allowed,
    );
  }

  it("does not propose npx in CLAUDE.md, AGENTS.md or docs/", () => {
    for (const file of ["CLAUDE.md", "AGENTS.md", ...docs]) {
      const npx = proposed(read(file)).filter((command) => /^npx\s/.test(command));
      expect(npx, file).toEqual([]);
    }
  });

  it("every npm command CLAUDE.md and AGENTS.md propose is allowed by the default profile", () => {
    for (const file of ["CLAUDE.md", "AGENTS.md"]) {
      const npm = proposed(read(file)).filter((command) => /^npm(\s|$)/.test(command));
      for (const command of npm)
        expect(allowedByDefault(command), `${file}: ${command}`).toBe(true);
    }
  });
});
