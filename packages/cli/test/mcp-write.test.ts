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
  schema: "konsora/2",
  project: { name: "Weather", base_branch: "main" },
  groups: [
    { id: "BE", name: "Backend" },
    { id: "FE", name: "Frontend" },
  ],
  seq: { BE: 4, FE: 1 },
  tasks: [
    t("BE-01", "done"),
    t("BE-02", "review", ["BE-01"]),
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
        {
          title: "Rollback",
          group: "OPS",
          deps: ["Deploy script"],
          labels: ["ops"],
          difficulty: "high",
        },
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
          difficulty: "low",
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
          "--difficulty",
          "low",
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
      ["edit", { id: "FE-02", difficulty: "medium" }, ["edit", "FE-02", "--difficulty", "medium"]],
      ["edit", { id: "OPS-02", difficulty: "none" }, ["edit", "OPS-02", "--difficulty", "none"]],
      ["depend", { id: "OPS-01", on: "FE-02" }, ["depend", "OPS-01", "FE-02"]],
      ["undepend", { id: "OPS-01", on: "FE-02" }, ["undepend", "OPS-01", "FE-02"]],
      ["withdraw", { id: "FE-02" }, ["withdraw", "FE-02"]],
      ["start", { id: "BE-04", plan: "Plan" }, ["start", "BE-04", "-m", "Plan"]],
      ["note", { id: "BE-04", text: "Progress" }, ["note", "BE-04", "Progress"]],
      ["ask", { id: "BE-04", question: "Which TTL?" }, ["ask", "BE-04", "Which TTL?"]],
      ["pause", { id: "BE-04", reason: "Waiting" }, ["pause", "BE-04", "-m", "Waiting"]],
      ["start", { id: "BE-04" }, ["start", "BE-04"]],
      ["finish", { id: "BE-04", summary: "Done it" }, ["finish", "BE-04", "--summary", "Done it"]],
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
    expect(doc(viaMcp).tasks.find((task) => task.id === "BE-04")?.state).toBe("review");
    expect(doc(viaMcp).tasks.find((task) => task.id === "OPS-02")).not.toHaveProperty("difficulty");
    await close();
  });

  it("exposes no human transition, and refuses to change approved work with a hint", async () => {
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
      "add-group",
    ])
      expect(names).not.toContain(human);
    const before = file(dir);
    const edit = await call("edit", { id: "BE-04", title: "Hijacked" });
    expect(edit.isError).toBe(true);
    expect(edit.text).toContain("Error (forbidden): BE-04 is approved");
    expect(edit.text).toContain("Hint: Agents propose, start, note, ask and finish");
    const withdraw = await call("withdraw", { id: "BE-03" });
    expect(withdraw.isError).toBe(true);
    expect(withdraw.text).toContain("only proposals can be withdrawn");
    expect((await call("undepend", { id: "BE-04", on: "BE-01" })).text).toContain("forbidden");
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

  it("never lets a client impersonate a human or the runner", () => {
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
    expect(nothing.text).toContain("Error: Nothing to change.");
    const summary = await call("finish", { id: "BE-04" });
    expect(summary.isError).toBe(true);
    rmSync(join(dir, ".konsora"), { recursive: true });
    const missing = await call("note", { id: "BE-04", text: "x" });
    expect(missing.text).toMatch(/^Error: No \.konsora\/ folder found/);
    await close();
  });

  it("tells the agent to stop after ask and finish", async () => {
    const dir = project();
    const { call, close } = await connect(dir);
    await call("start", { id: "BE-04" });
    expect((await call("ask", { id: "BE-04", question: "Q?" })).text).toContain(
      "Stop here and wait",
    );
    expect((await call("finish", { id: "BE-04", summary: "S" })).text).toContain(
      "waiting for human review. Stop here.",
    );
    await close();
  });
});
