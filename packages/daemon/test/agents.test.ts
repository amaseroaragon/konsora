import type { AgentAdapter } from "@konsora/runner";
import { describe, expect, it } from "vitest";
import { AgentCatalog } from "../src/agents.ts";

function adapter(id: "claude" | "codex", calls: string[], fail = false): AgentAdapter {
  return {
    id,
    detect: async () => {
      calls.push(`${id}:detect`);
      return { installed: true, version: "1.0.0" };
    },
    models: async () => {
      calls.push(`${id}:models`);
      if (fail) throw new Error("Could not list Codex models: timeout");
      return [{ id: "m", label: "M", efforts: ["low"] }];
    },
    start: () => {
      throw new Error("not used");
    },
  };
}

describe("AgentCatalog", () => {
  it("keeps the catalog for a short time, then asks the adapters again", async () => {
    const calls: string[] = [];
    let now = 0;
    const catalog = new AgentCatalog(
      { claude: adapter("claude", calls) },
      { ttlMs: 1000, now: () => now },
    );
    await Promise.all([catalog.list(), catalog.list()]);
    now = 999;
    await catalog.entry("claude");
    expect(calls).toEqual(["claude:detect", "claude:models"]);
    now = 1000;
    await catalog.list();
    expect(calls).toHaveLength(4);
  });

  it("reports a model list that failed instead of failing the catalog", async () => {
    const catalog = new AgentCatalog({ codex: adapter("codex", [], true) });
    expect(await catalog.entry("codex")).toMatchObject({
      installed: true,
      models: [],
      models_error: "Could not list Codex models: timeout",
    });
    expect(await catalog.entry("claude")).toBeUndefined();
  });
});
