import { describe, expect, it } from "vitest";
import { agentBrief, canBrief } from "../src/brief.ts";

describe("agent brief (UI-28)", () => {
  it("asks an agent to work a ready task through Konsora, in English", () => {
    expect(agentBrief({ id: "UI-12", title: "Human notes", state: "todo" })).toBe(
      [
        'Work on task UI-12 of this project\'s Konsora plan ("Human notes").',
        "Read it first with `konsora show UI-12` (or the show tool of Konsora's MCP server): its description, acceptance criteria and notes.",
        "Then follow the Konsora skill: start it, note progress, ask if a decision is the human's, and finish it with a summary, evidence per criterion and your commits.",
      ].join("\n"),
    );
  });

  it("asks to resume a task in progress, without starting it again", () => {
    const brief = agentBrief({ id: "UI-12", title: "Human notes", state: "doing" });
    expect(brief).toContain("Resume task UI-12");
    expect(brief).not.toContain("start it");
  });

  it("is offered for ready and in-progress tasks only", () => {
    expect(canBrief({ state: "todo" }, { ready: true })).toBe(true);
    expect(canBrief({ state: "doing" }, { ready: false })).toBe(true);
    expect(canBrief({ state: "todo" }, { ready: false })).toBe(false);
    expect(canBrief({ state: "proposed" }, { ready: false })).toBe(false);
    expect(canBrief({ state: "done" }, { ready: false })).toBe(false);
  });
});
