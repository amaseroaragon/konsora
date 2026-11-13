import { describe, expect, it } from "vitest";
import { parseOp } from "../src/op-schema.ts";
import { applyOp, recommendedModel } from "../src/ops.ts";
import { type TasksDocument, validateStructure } from "../src/schema.ts";
import { parseTasksFile } from "../src/semantics.ts";
import { serializeDocument } from "../src/serialize.ts";

const at = "2026-11-02T10:00:00Z";
const base = (): TasksDocument => ({
  schema: "konsora/5",
  project: { name: "P", templates: [{ id: "bug", name: "Bug" }] },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 0 },
  tasks: [],
});

describe("recommended model per difficulty (CORE-23)", () => {
  it("the human sets it, trimmed, leaving out empty levels; {} removes it", () => {
    const set = applyOp(
      base(),
      { op: "set-models", models: { high: " Opus, esfuerzo alto ", low: "Haiku", medium: " " } },
      { actor: "human", at },
    );
    if (!set.ok) throw new Error(set.error.message);
    expect(set.document.project.models).toEqual({ low: "Haiku", high: "Opus, esfuerzo alto" });
    const cleared = applyOp(set.document, { op: "set-models", models: {} }, { actor: "human", at });
    expect(cleared.ok && cleared.document.project.models).toBeUndefined();
  });

  it("is the human's alone: an agent gets forbidden", () => {
    const r = applyOp(
      base(),
      { op: "set-models", models: { low: "x" } },
      {
        actor: "agent:claude",
        at,
      },
    );
    expect(!r.ok && r.error.code).toBe("forbidden");
  });

  it("is serialized in canonical order (low, medium, high) after the templates", () => {
    const r = applyOp(
      base(),
      { op: "set-models", models: { high: "Opus", medium: "Sonnet", low: "Haiku" } },
      { actor: "human", at },
    );
    if (!r.ok) throw new Error(r.error.message);
    const text = serializeDocument(r.document);
    const project = JSON.parse(text).project;
    expect(Object.keys(project)).toEqual(["name", "templates", "models"]);
    expect(Object.keys(project.models)).toEqual(["low", "medium", "high"]);
    const parsed = parseTasksFile(text);
    expect(parsed.ok && serializeDocument(parsed.document)).toBe(text);
  });

  it("validates each level as a short text", () => {
    const doc = (models: unknown) => ({ ...base(), project: { name: "P", models } });
    expect(validateStructure(doc({ low: "Haiku" })).ok).toBe(true);
    expect(validateStructure(doc({ low: "" })).ok).toBe(false);
    expect(validateStructure(doc({ low: "x".repeat(81) })).ok).toBe(false);
    expect(validateStructure(doc({ extreme: "x" })).ok).toBe(false);
    expect(parseOp({ op: "set-models", models: { low: "Haiku" } }).ok).toBe(true);
    expect(parseOp({ op: "set-models", models: { huge: "x" } }).ok).toBe(false);
  });

  it("recommends the model of the task's difficulty, and nothing without one", () => {
    const project = { models: { low: "Haiku", high: "Opus" } };
    expect(recommendedModel(project, { difficulty: "low" })).toBe("Haiku");
    expect(recommendedModel(project, { difficulty: "medium" })).toBeUndefined();
    expect(recommendedModel(project, {})).toBeUndefined();
    expect(recommendedModel({}, { difficulty: "high" })).toBeUndefined();
  });
});
