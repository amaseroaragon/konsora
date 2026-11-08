import { describe, expect, it } from "vitest";
import { HINTS, OP_HINTS, opHint } from "../src/hints.ts";
import { CliError } from "../src/shared.ts";

/** A CLI command (`konsora ready`, `` `konsora` ``) or a `--option`. */
const CLI_WORDING = /\bkonsora [a-z]|`konsora\b|(^|\s|\()--[a-z]/;

const all = [
  ...Object.entries(OP_HINTS).map(([code, hint]) => [`op ${code}`, hint] as const),
  ...Object.entries(HINTS).map(([name, hint]) => [name, hint] as const),
];

describe("hints per channel (MCP-07)", () => {
  it.each(all)("%s: the MCP wording names no CLI command or --option", (_name, hint) => {
    expect(hint.mcp).not.toMatch(CLI_WORDING);
    expect(hint.mcp.trim()).not.toBe("");
  });

  it("the CLI keeps its wording", () => {
    expect(opHint({ code: "blocked" })).toBe(
      "Pick another task with `konsora ready`, or wait until its dependencies are done.",
    );
    expect(opHint({ code: "summary_required" })).toBe(
      "Pass --summary with what you did and how it meets the acceptance criteria.",
    );
    expect(opHint({ code: "summary_required" }, "mcp")).toBe(
      "Pass summary with what you did and how it meets the acceptance criteria.",
    );
    expect(HINTS.noProject.cli).toBe(
      "Run `konsora init` in your project folder, or pass --root <dir>.",
    );
    expect(opHint({ code: "invalid" })).toBeUndefined();
  });

  it("a CliError gives the CLI hint by default and each channel its own", () => {
    const error = new CliError("x", HINTS.unknownTask);
    expect(error.hint).toBe("Use `konsora list` to see task ids.");
    expect(error.hintFor("mcp")).toBe("Use the list tool to see task ids.");
    const plain = new CliError("x", "Same everywhere.");
    expect([plain.hint, plain.hintFor("mcp")]).toEqual(["Same everywhere.", "Same everywhere."]);
  });
});
