import { describe, expect, it } from "vitest";
import { type AgentCatalogEntry, checkAgent } from "../src/agents.ts";

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
