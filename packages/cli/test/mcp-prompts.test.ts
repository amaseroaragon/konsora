import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlanPrompt, serializeDocument, type Task, type TasksDocument } from "@konsora/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/main.ts";
import { STATUS_URI } from "../src/mcp-prompts.ts";
import { SLOW_TIMEOUT } from "./slow-timeout.ts";

const at = "2026-11-02T10:00:00Z";
const t = (id: string, state: Task["state"], deps: string[] = [], extra: Partial<Task> = {}) =>
  ({
    id,
    title: `Title ${id}`,
    state,
    group: "BE",
    ...(deps.length ? { deps } : {}),
    rank: "m",
    created: { at, by: "human" },
    updated_at: at,
    ...extra,
  }) satisfies Task;

const plan = (tasks: Task[]): TasksDocument => ({
  schema: "konsora/5",
  project: { name: "Weather" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 9 },
  tasks,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "konsora-prompts-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(doc: TasksDocument) {
  mkdirSync(join(dir, ".konsora"), { recursive: true });
  writeFileSync(join(dir, ".konsora", "tasks.json"), serializeDocument(doc));
}

async function cli(args: string[]) {
  let stdout = "";
  await main(args, {
    stdout: (s) => {
      stdout += s;
    },
    stderr: () => {},
    cwd: dir,
    env: {},
  });
  return stdout;
}

async function connect(env: Record<string, string> = {}) {
  const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "mcp", "--root", dir],
    cwd: tmpdir(),
    env: { ...(process.env as Record<string, string>), KONSORA_AGENT: "claude", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  const text = async (name: string, args: Record<string, string> = {}) => {
    const result = await client.getPrompt({ name, arguments: args });
    const content = result.messages[0]?.content;
    return content?.type === "text" ? content.text : "";
  };
  return { client, text };
}

describe("MCP prompts and resources over stdio", { timeout: SLOW_TIMEOUT }, () => {
  it("lists the prompts and the status resource", async () => {
    seed(plan([t("BE-01", "todo")]));
    const { client } = await connect();
    try {
      const { prompts } = await client.listPrompts();
      expect(prompts.map((p) => p.name)).toEqual(["next", "resume", "plan"]);
      expect(prompts.find((p) => p.name === "plan")?.arguments).toEqual([
        expect.objectContaining({ name: "goal", required: false }),
      ]);
      const { resources } = await client.listResources();
      expect(resources).toEqual([
        expect.objectContaining({ uri: STATUS_URI, name: "status", mimeType: "application/json" }),
      ]);
    } finally {
      await client.close();
    }
  });

  it("next gives the next ready task in full with the protocol's steps", async () => {
    seed(
      plan([
        t("BE-01", "done"),
        t("BE-02", "todo", ["BE-01"], {
          rank: "b",
          desc: "Cache responses.",
          acceptance: [{ id: "ac1", text: "Fast" }],
        }),
        t("BE-03", "todo", [], { rank: "c" }),
      ]),
    );
    const { client, text } = await connect();
    try {
      const next = await text("next");
      expect(next).toContain("The next task to take in this project's Konsora plan is BE-02.");
      expect(next).toContain(await cli(["show", "BE-02"]));
      expect(next).toContain("Start it with the start tool");
      expect(next).toContain("Finish it with the finish tool");
      // A prompt only reads: nothing was started.
      expect(JSON.parse(await cli(["show", "BE-02", "--json"])).state).toBe("todo");
    } finally {
      await client.close();
    }
  });

  it("next explains when nothing is ready, and an unreadable plan", async () => {
    seed(plan([t("BE-01", "doing"), t("BE-02", "todo", ["BE-01"])]));
    let { client, text } = await connect();
    try {
      const none = await text("next");
      expect(none).toContain("There is no task to work on");
      expect(none).toContain("every todo task is blocked (BE-02 by BE-01)");
      expect(none).toContain("do not start any task");
    } finally {
      await client.close();
    }
    writeFileSync(join(dir, ".konsora", "tasks.json"), "{ broken");
    ({ client, text } = await connect());
    try {
      const broken = await text("next");
      expect(broken).toContain("Konsora could not give you work: The plan is invalid");
      expect(broken).toContain("Hint: Fix the file");
    } finally {
      await client.close();
    }
  });

  it("resume gives the agent's own tasks in progress with their notes", async () => {
    const start = (by: string) => ({ events: [{ type: "start" as const, at, by }] });
    seed(
      plan([
        t("BE-01", "doing", [], {
          ...start("agent:claude"),
          notes: [{ id: "n1", at, by: "agent:claude", kind: "note", text: "Half done." }],
        }),
        t("BE-02", "doing", [], start("agent:codex")),
      ]),
    );
    let { client, text } = await connect();
    try {
      const resume = await text("resume");
      expect(resume).toContain("You (agent:claude) have a task in progress");
      expect(resume).toContain("BE-01 · Title BE-01");
      expect(resume).toContain("Half done.");
      expect(resume).not.toContain("BE-02");
    } finally {
      await client.close();
    }
    ({ client, text } = await connect({ KONSORA_AGENT: "gemini" }));
    try {
      expect(await text("resume")).toContain("You (agent:gemini) have no task in progress");
    } finally {
      await client.close();
    }
  });

  it("plan is the planning interview, with the goal when given", async () => {
    const doc = plan([t("BE-01", "todo")]);
    seed(doc);
    const { client, text } = await connect();
    try {
      expect(await text("plan")).toBe(buildPlanPrompt(doc));
      expect(await text("plan", { goal: " A weather cache " })).toBe(
        buildPlanPrompt(doc, { goal: "A weather cache" }),
      );
    } finally {
      await client.close();
    }
  });

  it("the status resource has the same content as the status tool, and reading writes nothing", async () => {
    seed(plan([t("BE-01", "todo"), t("BE-02", "proposed")]));
    const before = readFileSync(join(dir, ".konsora", "tasks.json"), "utf8");
    const { client } = await connect();
    try {
      const resource = await client.readResource({ uri: STATUS_URI });
      const content = resource.contents[0] as { text: string; mimeType: string };
      expect(content.mimeType).toBe("application/json");
      const tool = (await client.callTool({ name: "status", arguments: {} })) as {
        content: { text: string }[];
      };
      expect(JSON.parse(content.text)).toEqual(JSON.parse(tool.content[0]?.text ?? ""));
      expect(JSON.parse(content.text)).toMatchObject({ tasks: 2, ready: ["BE-01"] });
    } finally {
      await client.close();
    }
    expect(readFileSync(join(dir, ".konsora", "tasks.json"), "utf8")).toBe(before);
  });
});
