import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeDocument, type Task, type TasksDocument } from "@konsora/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/main.ts";
import { createMcpServer } from "../src/mcp.ts";
import { mcpActor } from "../src/mcp-write.ts";
import type { Io } from "../src/shared.ts";

const at = "2026-11-02T10:00:00Z";
const now = () => new Date("2026-11-03T08:30:00Z");
const t = (id: string, state: Task["state"], deps: string[] = [], extra: Partial<Task> = {}) =>
  ({
    id,
    title: `Title ${id}`,
    state,
    group: id.split("-")[0] as string,
    ...(deps.length ? { deps } : {}),
    rank: "a",
    created: { at, by: "human" },
    updated_at: at,
    ...extra,
  }) satisfies Task;

const plan = (): TasksDocument => ({
  schema: "konsora/5",
  project: {
    name: "Weather",
    templates: [
      {
        id: "bug",
        name: "Bug fix",
        desc: "Reproduce and fix.",
        acceptance: [{ text: "A test reproduces it" }],
        labels: ["bug"],
      },
    ],
  },
  groups: [
    { id: "BE", name: "Backend" },
    { id: "FE", name: "Frontend" },
  ],
  seq: { BE: 4, FE: 1 },
  tasks: [
    t("BE-01", "done"),
    t("BE-02", "doing", ["BE-01"]),
    t("BE-03", "todo", ["BE-02"]),
    t("BE-04", "todo", ["BE-01"], { acceptance: [{ id: "ac1", text: "Fast" }] }),
    t("FE-01", "proposed", [], { created: { at, by: "agent:claude" } }),
  ],
});

const dirs: string[] = [];
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "konsora-mcpw-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "trunk"], { cwd: dir });
  mkdirSync(join(dir, ".konsora"));
  writeFileSync(join(dir, ".konsora", "tasks.json"), serializeDocument(plan()));
  return dir;
}
beforeEach(() => {
  dirs.length = 0;
});
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const file = (dir: string) => readFileSync(join(dir, ".konsora", "tasks.json"), "utf8");
const doc = (dir: string) => JSON.parse(file(dir)) as TasksDocument;

async function connect(dir: string, options: { client?: string; env?: NodeJS.ProcessEnv } = {}) {
  const io: Io = { stdout: () => {}, stderr: () => {}, cwd: dir, env: options.env ?? {}, now };
  const server = createMcpServer(io, undefined);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: options.client ?? "claude-code", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const texts = result.content.map((c) => (c.type === "text" ? c.text : ""));
    return {
      isError: Boolean(result.isError),
      text: texts.join("\n"),
      json: () => JSON.parse(texts[0] ?? ""),
    };
  };
  return { client, call, close: () => client.close() };
}

async function cli(dir: string, args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
    cwd: dir,
    env: {},
    now,
  });
  return { code, stderr, json: () => JSON.parse(stdout) };
}

describe("konsora mcp: agent write tools", () => {
  it("each tool writes exactly what the equivalent CLI command writes", async () => {
    const viaCli = project();
    const viaMcp = project();
    const batchFile = join(viaCli, "batch.json");
    const batch = {
      groups: [{ id: "OPS", name: "Operations" }],
      tasks: [
        { title: "Deploy script", group: "OPS", acceptance: ["Runs in CI"] },
        { title: "Hotfix", group: "OPS", template: "bug", acceptance: ["No regression"] },
        {
          title: "Rollback",
          group: "OPS",
          deps: ["Deploy script"],
          labels: ["ops"],
        },
        { title: "Metrics someday", group: "OPS", idea: true },
      ],
    };
    writeFileSync(batchFile, JSON.stringify(batch));
    const steps: [string, Record<string, unknown>, string[]][] = [
      [
        "propose",
        {
          title: "Cache layer",
          group: "fe",
          desc: "Why",
          acceptance: ["a", "b"],
          deps: ["be-01"],
          labels: ["x", "y"],
        },
        [
          "propose",
          "Cache layer",
          "--group",
          "fe",
          "--desc",
          "Why",
          "--criterion",
          "a",
          "--criterion",
          "b",
          "--deps",
          "be-01",
          "--labels",
          "x,y",
        ],
      ],
      ["batch", batch, ["batch", "--file", batchFile]],
      [
        "edit",
        { id: "fe-01", title: "Better title", acceptance: ["c"], labels: ["z"], group: "BE" },
        [
          "edit",
          "fe-01",
          "--title",
          "Better title",
          "--criterion",
          "c",
          "--labels",
          "z",
          "--group",
          "BE",
        ],
      ],
      ["edit", { id: "FE-02", desc: "Updated" }, ["edit", "FE-02", "--desc", "Updated"]],
      [
        "propose",
        { title: "Rated", group: "BE", difficulty: "medium" },
        ["propose", "Rated", "--group", "BE", "--difficulty", "medium"],
      ],
      ["edit", { id: "FE-02", difficulty: "high" }, ["edit", "FE-02", "--difficulty", "high"]],
      ["edit", { id: "FE-02", difficulty: "none" }, ["edit", "FE-02", "--difficulty", "none"]],
      [
        "propose",
        { title: "Login crash", group: "BE", template: "bug", labels: ["auth"] },
        ["propose", "Login crash", "--group", "BE", "--template", "bug", "--labels", "auth"],
      ],
      ["depend", { id: "OPS-01", on: "FE-02" }, ["depend", "OPS-01", "FE-02"]],
      ["undepend", { id: "OPS-01", on: "FE-02" }, ["undepend", "OPS-01", "FE-02"]],
      ["delete", { id: "FE-02" }, ["delete", "FE-02"]],
      ["promote", { id: "FE-01" }, ["promote", "FE-01"]],
      ["add_group", { id: "qa", name: "QA" }, ["group", "add", "qa", "QA"]],
      ["rename_group", { id: "QA", name: "Quality" }, ["group", "rename", "QA", "Quality"]],
      ["remove_group", { id: "QA" }, ["group", "remove", "QA"]],
      [
        "add_milestone",
        { id: "M1", name: "First", criterion: "Shipped" },
        ["milestone", "add", "M1", "First", "--criterion", "Shipped"],
      ],
      [
        "propose",
        { title: "In a milestone", group: "BE", milestone: "m1" },
        ["propose", "In a milestone", "--group", "BE", "--milestone", "m1"],
      ],
      ["edit", { id: "BE-04", milestone: "m1" }, ["edit", "BE-04", "--milestone", "m1"]],
      ["edit", { id: "BE-04", milestone: "none" }, ["edit", "BE-04", "--milestone", "none"]],
      [
        "edit_milestone",
        { id: "m1", name: "Renamed", criterion: "none" },
        ["milestone", "edit", "m1", "--name", "Renamed", "--no-criterion"],
      ],
      ["add_milestone", { id: "m2", name: "Empty" }, ["milestone", "add", "m2", "Empty"]],
      ["remove_milestone", { id: "m2" }, ["milestone", "remove", "m2"]],
      ["start", { id: "BE-04", plan: "Plan" }, ["start", "BE-04", "-m", "Plan"]],
      ["note", { id: "BE-04", text: "Progress" }, ["note", "BE-04", "Progress"]],
      ["ask", { id: "BE-04", question: "Which TTL?" }, ["ask", "BE-04", "Which TTL?"]],
      [
        "ask",
        { id: "BE-04", question: "Which store?", options: ["Memory", "Redis"] },
        ["ask", "BE-04", "Which store?", "--option", "Memory", "--option", "Redis"],
      ],
      ["pause", { id: "BE-04", reason: "Waiting" }, ["pause", "BE-04", "-m", "Waiting"]],
      ["start", { id: "BE-04" }, ["start", "BE-04"]],
      [
        "finish",
        {
          id: "BE-04",
          summary: "Done it",
          evidence: [{ ac: "ac1", text: "bench: 3 ms" }],
          commits: ["abcdef1"],
        },
        [
          "finish",
          "BE-04",
          "--summary",
          "Done it",
          "--evidence",
          "ac1=bench: 3 ms",
          "--commit",
          "abcdef1",
        ],
      ],
    ];
    const { call, close } = await connect(viaMcp);
    for (const [tool, args, command] of steps) {
      const fromCli = await cli(viaCli, [...command, "--as", "claude", "--json"]);
      expect(fromCli.code, `${command.join(" ")}: ${fromCli.stderr}`).toBe(0);
      const fromMcp = await call(tool, args);
      expect(fromMcp.isError, `${tool}: ${fromMcp.text}`).toBe(false);
      expect(fromMcp.json(), tool).toEqual(fromCli.json());
      expect(file(viaMcp), tool).toBe(file(viaCli));
    }
    expect(doc(viaMcp).tasks.find((task) => task.id === "BE-04")).toMatchObject({
      state: "done",
    });
    const tasks = doc(viaMcp).tasks;
    expect(tasks.find((task) => task.id === "OPS-03")).toMatchObject({ labels: ["ops"] });
    expect(tasks.find((task) => task.id === "OPS-04")).toMatchObject({
      title: "Metrics someday",
      state: "proposed",
    });
    expect(tasks.find((task) => task.id === "OPS-02")).toMatchObject({
      desc: "Reproduce and fix.",
      acceptance: [
        { id: "ac1", text: "A test reproduces it" },
        { id: "ac2", text: "No regression" },
      ],
      labels: ["bug"],
    });
    expect(tasks.find((task) => task.title === "Login crash")).toMatchObject({
      labels: ["auth", "bug"],
    });
    await close();
  });

  it("exposes no human action, and refuses to change finished work with a hint", async () => {
    const dir = project();
    const { client, call, close } = await connect(dir);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const human of [
      "approve",
      "accept",
      "send-back",
      "send_back",
      "reopen",
      "answer",
      "set-yolo",
      "restore",
      "delete_block",
      "mark_merged",
      "merge",
      "withdraw",
    ])
      expect(names).not.toContain(human);
    const before = file(dir);
    const edit = await call("edit", { id: "BE-01", title: "Hijacked" });
    expect(edit.isError).toBe(true);
    expect(edit.text).toContain("Error (forbidden): BE-01 is done");
    expect(edit.text).toContain("Hint: Agents create, start, note, ask and finish");
    const deleted = await call("delete", { id: "BE-02" });
    expect(deleted.isError).toBe(true);
    expect(deleted.text).toContain("agents can only delete tasks nobody started");
    expect((await call("start", { id: "BE-03" })).text).toContain("Error (blocked)");
    expect(file(dir)).toBe(before);
    await close();
  });

  it("attributes notes and proposals to agent:<name> from the client or KONSORA_AGENT", async () => {
    const dir = project();
    const claude = await connect(dir);
    await claude.call("propose", { title: "From Claude", group: "FE" });
    await claude.call("start", { id: "BE-04", plan: "My plan" });
    await claude.close();
    const codex = await connect(dir, { client: "codex-mcp-client" });
    await codex.call("note", { id: "BE-04", text: "From Codex" });
    await codex.close();
    const named = await connect(dir, { client: "claude-code", env: { KONSORA_AGENT: "gemini" } });
    await named.call("note", { id: "BE-04", text: "Named" });
    await named.close();

    const tasks = doc(dir).tasks;
    expect(tasks.find((task) => task.title === "From Claude")?.created.by).toBe("agent:claude");
    expect(tasks.find((task) => task.id === "BE-04")?.notes?.map((n) => [n.by, n.text])).toEqual([
      ["agent:claude", "My plan"],
      ["agent:codex", "From Codex"],
      ["agent:gemini", "Named"],
    ]);
  });

  it("start tells the agent the recommended model for the task's difficulty (CORE-23)", async () => {
    const dir = project();
    const plan = doc(dir);
    plan.project.models = { medium: "Sonnet" };
    const four = plan.tasks.find((task) => task.id === "BE-04");
    if (four) four.difficulty = "medium";
    writeFileSync(join(dir, ".konsora", "tasks.json"), serializeDocument(plan));
    const { call, close } = await connect(dir);
    const started = await call("start", { id: "BE-04" });
    expect(started.text).toContain("Recommended model for this medium task: Sonnet.");
    await call("propose", { title: "Plain", group: "BE" });
    expect((await call("start", { id: "BE-05" })).text).not.toContain("Recommended model");
    await close();
  });

  it("move reorders a task with the same rules as the CLI (CORE-11)", async () => {
    const dir = project();
    const { call, close } = await connect(dir);
    await call("propose", { title: "Five", group: "BE" });
    const ready = async () => (await call("ready")).json().map((x: { id: string }) => x.id);
    expect(await ready()).toEqual(["BE-04", "BE-05"]);
    const moved = await call("move", { id: "be-05", before: "BE-04" });
    expect(moved.isError).toBe(false);
    expect(moved.json().changed).toEqual(["BE-05"]);
    expect(await ready()).toEqual(["BE-05", "BE-04"]);
    expect((await call("move", { id: "BE-04", top: true })).json().changed).toEqual(["BE-04"]);
    expect(await ready()).toEqual(["BE-04", "BE-05"]);
    const none = await call("move", { id: "BE-04" });
    expect(none.text).toBe(
      "Error: Say where to move it, once.\nHint: Pass exactly one of before, after or top.",
    );
    expect((await call("move", { id: "BE-01", top: true })).text).toContain("Error (forbidden)");
    await close();
  });

  it("demote turns a todo task back into an idea, also in a planning session (CORE-12)", async () => {
    const dir = project();
    const { call, close } = await connect(dir, { env: { KONSORA_PLAN: "1" } });
    const demoted = await call("demote", { id: "be-04" });
    expect(demoted.isError).toBe(false);
    expect(demoted.json().tasks[0]).toMatchObject({ id: "BE-04", state: "proposed" });
    expect((await call("demote", { id: "BE-02" })).text).toContain("Error (out_of_scope)");
    expect((await call("demote", { id: "FE-01" })).text).toContain("Error (invalid_transition)");
    await close();
  });

  it("split replaces a task nobody started, also in a planning session (CORE-20)", async () => {
    const viaMcp = project();
    const viaCli = project();
    const { call, close } = await connect(viaMcp, { env: { KONSORA_PLAN: "1" } });
    const parts = { into: [{ title: "First", acceptance: ["A"] }, { title: "Second" }] };
    const fromMcp = await call("split", { id: "be-03", ...parts });
    expect(fromMcp.isError, fromMcp.text).toBe(false);
    writeFileSync(join(viaCli, "parts.json"), JSON.stringify(parts));
    const fromCli = await cli(viaCli, [
      "split",
      "BE-03",
      "--file",
      "parts.json",
      "--as",
      "claude",
      "--json",
    ]);
    expect(fromMcp.json()).toEqual(fromCli.json());
    expect(file(viaMcp)).toBe(file(viaCli));
    expect(doc(viaMcp).tasks.find((t) => t.id === "BE-06")?.deps).toEqual(["BE-05"]);
    expect((await call("split", { id: "BE-02", ...parts })).text).toContain("Error (out_of_scope)");
    await close();
  });

  it("never lets a client impersonate a human or Konsora", () => {
    expect(mcpActor({}, "Human")).toBe("agent:unknown");
    expect(mcpActor({}, "konsora")).toBe("agent:unknown");
    expect(mcpActor({}, undefined)).toBe("agent:unknown");
    expect(mcpActor({}, "Cursor VSCode")).toBe("agent:cursor");
    expect(() => mcpActor({ KONSORA_AGENT: "human" }, "claude-code")).toThrow(/always acts as/);
  });

  it("returns actionable errors for bad input and a missing plan, and keeps serving", async () => {
    const dir = project();
    const { call, close } = await connect(dir);
    const shape = await call("batch", { tasks: [] });
    expect(shape.isError).toBe(true);
    const nothing = await call("edit", { id: "FE-01" });
    expect(nothing.text).toBe(
      "Error: Nothing to change.\nHint: Pass title, desc, acceptance, labels, group, difficulty or milestone.",
    );
    const blocked = await call("start", { id: "BE-03" });
    expect(blocked.text).toContain("Hint: Pick another task with the ready tool");
    const unknown = await call("show", { id: "BE-99" });
    expect(unknown.text).toBe(
      "Error: Task BE-99 does not exist.\nHint: Use the list tool to see task ids.",
    );
    const summary = await call("finish", { id: "BE-04" });
    expect(summary.isError).toBe(true);
    const template = await call("propose", { title: "X", group: "BE", template: "feature" });
    expect(template.isError).toBe(true);
    expect(template.text).toContain(
      'Error (unknown_template): Template "feature" does not exist\nHint: ',
    );
    const status = await call("status");
    expect(status.json().project.templates.map((t: { id: string }) => t.id)).toEqual(["bug"]);
    rmSync(join(dir, ".konsora"), { recursive: true });
    const missing = await call("note", { id: "BE-04", text: "x" });
    expect(missing.text).toMatch(/^Error: No \.konsora\/ folder found/);
    expect(missing.text).not.toMatch(/konsora init|--root/);
    await close();
  });

  it("tells the agent to stop after ask, and that a finished task is done", async () => {
    const dir = project();
    const { call, close } = await connect(dir);
    await call("start", { id: "BE-04" });
    expect((await call("ask", { id: "BE-04", question: "Q?" })).text).toContain(
      "Stop here and wait",
    );
    expect((await call("finish", { id: "BE-04", summary: "S" })).text).toContain(
      "The task is done.",
    );
    await close();
  });
});
