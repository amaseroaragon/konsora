import { describe, expect, it } from "vitest";
import { buildPlanPrompt } from "../src/plan-prompt.ts";
import type { Task, TasksDocument } from "../src/schema.ts";

const at = "2026-11-08T10:00:00Z";
const task = (id: string, state: Task["state"]): Task => ({
  id,
  title: id,
  state,
  group: id.split("-")[0] as string,
  rank: "a",
  created: { at, by: "human" },
  updated_at: at,
});
const doc: TasksDocument = {
  schema: "konsora/5",
  project: {
    name: "Weather",
    templates: [
      { id: "bug", name: "Bug fix" },
      { id: "spike", name: "Spike" },
    ],
  },
  groups: [
    { id: "BE", name: "Backend" },
    { id: "FE", name: "Frontend" },
  ],
  seq: { BE: 2, FE: 1 },
  tasks: [task("BE-01", "done"), task("BE-02", "todo"), task("FE-01", "proposed")],
};

describe("buildPlanPrompt", () => {
  it("is deterministic and matches the snapshot", () => {
    const prompt = buildPlanPrompt(doc);
    expect(buildPlanPrompt(structuredClone(doc))).toBe(prompt);
    expect(prompt).toMatchSnapshot();
  });

  it("asks for verifiable criteria", () => {
    const prompt = buildPlanPrompt(doc);
    expect(prompt).toContain("Acceptance criteria that can be verified");
    expect(prompt).toContain("single batch call");
  });

  it("starts from the human's goal when given, and says when there are no templates", () => {
    const plain = { ...doc, project: { name: "P" } };
    const prompt = buildPlanPrompt(plain, { goal: "  Add a forecast cache.  " });
    expect(prompt).toContain("## What the human wants to plan\n\nAdd a forecast cache.\n");
    expect(prompt).toContain("ask only what is missing");
    expect(prompt).toContain("Templates: none.");
    expect(buildPlanPrompt(plain, { goal: "   " })).toBe(buildPlanPrompt(plain));
  });
});
