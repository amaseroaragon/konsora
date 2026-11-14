import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeDocument, type Task, type TasksDocument } from "@konsora/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/main.ts";
import { createMcpServer } from "../src/mcp.ts";
import type { Io } from "../src/shared.ts";

const at = "2026-11-02T10:00:00Z";
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
  project: { name: "Weather" },
  groups: [
    { id: "BE", name: "Backend" },
    { id: "FE", name: "Frontend" },
  ],
  seq: { BE: 4, FE: 1 },
  tasks: [
    t("BE-01", "done"),
    t("BE-02", "doing", ["BE-01"]),
    t("BE-03", "todo", ["BE-02"]),
    t("BE-04", "todo", ["BE-01"], {
      desc: "Cache responses.",
      acceptance: [{ id: "ac1", text: "Fast" }],
      notes: [{ id: "n1", at, by: "agent:codex", kind: "question", text: "Which TTL?" }],
    }),
    t("FE-01", "proposed", [], { created: { at, by: "agent:claude" } }),
  ],
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "konsora-mcp-"));
  execFileSync("git", ["init", "-q", "-b", "trunk"], { cwd: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(content: string = serializeDocument(plan())) {
  mkdirSync(join(dir, ".konsora"), { recursive: true });
  writeFileSync(join(dir, ".konsora", "tasks.json"), content);
}

const io = (cwd: string = dir): Io => ({ stdout: () => {}, stderr: () => {}, cwd, env: {} });

async function connect(options: { cwd?: string; root?: string } = {}) {
  const server = createMcpServer(io(options.cwd), options.root);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const first = result.content[0];
    const text = first?.type === "text" ? first.text : "";
    return { isError: Boolean(result.isError), text, json: () => JSON.parse(text) };
  };
  return { client, call, close: () => client.close() };
}

async function cli(args: string[]) {
  let stdout = "";
  const code = await main(args, {
    ...io(),
    stdout: (s) => {
      stdout += s;
    },
  });
  return { code, json: () => JSON.parse(stdout) };
}

/** Every file under `root` with its content and mtime, to prove nothing was written. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[path] = `${statSync(path).mtimeMs}:${readFileSync(path, "base64")}`;
    }
  };
  walk(root);
  return out;
}

describe("konsora mcp: read tools", () => {
  it("lists the read tools, all marked read-only", async () => {
    seed();
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const reads = tools.filter((tool) => tool.annotations?.readOnlyHint);
    expect(reads.map((tool) => tool.name).sort()).toEqual([
      "blocked",
      "check",
      "list",
      "log",
      "ready",
      "show",
      "status",
    ]);
    await close();
  });

  it("returns exactly what the CLI prints with --json", async () => {
    seed();
    const { call, close } = await connect();
    const cases: [string, Record<string, unknown>, string[]][] = [
      ["status", {}, ["status"]],
      ["list", {}, ["list"]],
      ["list", { state: "todo" }, ["list", "--state", "todo"]],
      ["list", { group: "FE" }, ["list", "--group", "FE"]],
      ["list", { ready: true }, ["list", "--ready"]],
      ["list", { blocked: true }, ["list", "--blocked"]],
      ["list", { waiting: true }, ["list", "--waiting"]],
      ["ready", {}, ["ready"]],
      ["blocked", {}, ["blocked"]],
      ["show", { id: "BE-04" }, ["show", "BE-04"]],
      ["show", { id: "be-04" }, ["show", "be-04"]],
      ["check", {}, ["check"]],
    ];
    for (const [tool, args, command] of cases) {
      const result = await call(tool, args);
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(false);
      const expected = await cli([...command, "--json"]);
      expect(expected.code).toBe(0);
      expect(result.json(), `${tool} ${JSON.stringify(args)}`).toEqual(expected.json());
    }
    expect((await call("ready")).json().map((task: { id: string }) => task.id)).toEqual(["BE-04"]);
    await close();
  });

  it("resolves the project like the CLI: nearest .konsora/ above cwd, or an explicit root", async () => {
    seed();
    const nested = join(dir, "src", "deep");
    mkdirSync(nested, { recursive: true });
    const fromNested = await connect({ cwd: nested });
    expect((await fromNested.call("status")).json().project.name).toBe("Weather");
    await fromNested.close();
    const other = mkdtempSync(join(tmpdir(), "konsora-mcp-other-"));
    try {
      const explicit = await connect({ cwd: other, root: dir });
      expect((await explicit.call("status")).json().tasks).toBe(5);
      await explicit.close();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("starting the server and reading writes nothing in the project", async () => {
    seed();
    const before = snapshot(dir);
    const { client, call, close } = await connect();
    await client.listTools();
    for (const tool of ["status", "list", "ready", "blocked", "check"]) await call(tool);
    await call("show", { id: "BE-02" });
    await call("show", { id: "NOPE-1" });
    await close();
    expect(snapshot(dir)).toEqual(before);
  });

  it("reports a missing project as an actionable tool error and keeps serving", async () => {
    const { call, close } = await connect();
    const missing = await call("status");
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/^Error: No \.konsora\/ folder found/);
    expect(missing.text).toContain("Hint: Start the server from the project folder");
    seed();
    expect((await call("status")).isError).toBe(false);
    await close();
  });

  it("reports an invalid plan as a tool error for reads, and with every problem for check", async () => {
    seed("{ not json");
    const { call, close } = await connect();
    for (const tool of ["status", "list", "ready", "blocked"]) {
      const result = await call(tool);
      expect(result.isError, tool).toBe(true);
      expect(result.text).toContain("Error: The plan is invalid");
      expect(result.text).toContain("Hint: Fix the file");
    }
    const check = await call("check");
    expect(check.isError).toBe(true);
    expect(check.json()).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(check.json()).toEqual((await cli(["check", "--json"])).json());
    expect((await call("show", { id: "BE-01" })).isError).toBe(true);
    await close();
  });

  it("returns usage errors for unknown tasks, groups and bad arguments", async () => {
    seed();
    const { call, close } = await connect();
    const task = await call("show", { id: "BE-99" });
    expect(task).toMatchObject({ isError: true });
    expect(task.text).toContain("Task BE-99 does not exist.");
    const group = await call("list", { group: "XX" });
    expect(group.isError).toBe(true);
    expect(group.text).toContain("Hint: Groups: BE, FE.");
    expect((await call("list", { state: "nope" })).isError).toBe(true);
    expect((await call("status")).isError).toBe(false);
    await close();
  });
});

describe("konsora mcp over stdio", () => {
  it("serves the tools to a real stdio client and exits when it disconnects", async () => {
    seed();
    const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "mcp", "--root", dir],
      cwd: tmpdir(),
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("show");
    const result = (await client.callTool({ name: "show", arguments: { id: "BE-04" } })) as {
      content: { type: string; text: string }[];
    };
    expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({ id: "BE-04", ready: true });
    await client.close();
  });

  it("answers every piped request before exiting when stdin ends", () => {
    seed();
    const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
    const messages = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "pipe", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ready", arguments: {} } },
    ];
    const result = spawnSync(process.execPath, [bin, "--root", dir, "mcp"], {
      input: messages.map((m) => `${JSON.stringify(m)}\n`).join(""),
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const replies = result.stdout
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(replies.map((r) => r.id)).toEqual([1, 2]);
    expect(JSON.parse(replies[1].result.content[0].text)).toHaveLength(1);
  });
});
