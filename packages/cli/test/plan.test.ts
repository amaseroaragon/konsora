import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlanPrompt, serializeDocument, type TasksDocument } from "@konsora/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, main } from "../src/main.ts";
import { createMcpServer } from "../src/mcp.ts";
import type { Io } from "../src/shared.ts";

const at = "2026-11-08T10:00:00Z";
const plan = (): TasksDocument => ({
  schema: "konsora/3",
  project: {
    name: "Weather",
    templates: [{ id: "bug", name: "Bug fix" }],
  },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 2 },
  tasks: [
    {
      id: "BE-01",
      title: "Approved",
      state: "todo",
      group: "BE",
      rank: "a",
      created: { at, by: "human" },
      updated_at: at,
    },
    {
      id: "BE-02",
      title: "Proposal",
      state: "proposed",
      group: "BE",
      rank: "b",
      created: { at, by: "agent:claude" },
      updated_at: at,
    },
  ],
});

let dir: string;
let bin: string;
let out: string;

/** A fake agent CLI: it records how it was started and exits with $FAKE_EXIT. */
function fakeCli(name: string) {
  const file = join(bin, name);
  writeFileSync(
    file,
    `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ name: ${JSON.stringify(name)}, args: process.argv.slice(2), cwd: process.cwd() }));
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`,
  );
  chmodSync(file, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "konsora-plan-"));
  bin = join(dir, "bin");
  out = join(dir, "out.json");
  const project = join(dir, "project");
  mkdirSync(join(project, ".konsora"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: project });
  writeFileSync(join(project, ".konsora", "tasks.json"), serializeDocument(plan()));
  mkdirSync(bin);
  fakeCli("claude");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  let stderr = "";
  const code = await main(args, {
    stdout: () => {},
    stderr: (s) => {
      stderr += s;
    },
    cwd: join(dir, "project"),
    env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_OUT: out, ...env },
  });
  return { code, stderr };
}
const launched = () =>
  JSON.parse(readFileSync(out, "utf8")) as { name: string; args: string[]; cwd: string };
const project = () => join(dir, "project");

describe("konsora plan (CLI-05)", () => {
  it("opens Claude Code with the interview prompt and only the MCP server in plan mode", async () => {
    const r = await run(["plan", "Add a forecast cache", "--model", "opus"]);
    expect(r.code, r.stderr).toBe(EXIT.ok);
    expect(r.stderr).toContain("Starting a planning session with Claude Code");
    const { name, args, cwd } = launched();
    expect(name).toBe("claude");
    expect(cwd).toBe(project());
    expect(args.at(-1)).toBe(buildPlanPrompt(plan(), { goal: "Add a forecast cache" }));
    expect(args.slice(0, 3)).toEqual(["--model", "opus", "--strict-mcp-config"]);
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1] as string);
    expect(Object.keys(config.mcpServers)).toEqual(["konsora"]);
    expect(config.mcpServers.konsora.env).toEqual({ KONSORA_AGENT: "claude", KONSORA_PLAN: "1" });
    expect(config.mcpServers.konsora.args.slice(-3)).toEqual(["mcp", "--root", project()]);
    // `--allowedTools` is variadic in Claude Code: as `--allowedTools X prompt` it would take
    // the prompt as one more tool, so it goes as a single `--allowedTools=…` argument.
    const allowed = args.find((a) => a.startsWith("--allowedTools="));
    expect(allowed).toBeDefined();
    expect(allowed).not.toMatch(/start|note|finish|ask/);
    expect(args).not.toContain("--allowedTools");
    expect(args.some((a) => a.startsWith("--dangerously"))).toBe(false);
    expect(args).not.toContain("-p");
  });

  it("reports a missing agent CLI and a failed session", async () => {
    const failed = await run(["plan"], { FAKE_EXIT: "3" });
    expect(failed.code).toBe(EXIT.failure);
    expect(failed.stderr).toContain("claude exited with code 3.");
    rmSync(join(bin, "claude"));
    const missing = await run(["plan"]);
    expect(missing.code).toBe(EXIT.failure);
    expect(missing.stderr).toContain("claude is not installed or not on PATH.");
    expect((await run(["plan", "--agent", "codex"])).code).toBe(EXIT.usage);
  });
});

describe("the MCP server in plan mode (CLI-05)", () => {
  async function connect() {
    const io: Io = {
      stdout: () => {},
      stderr: () => {},
      cwd: project(),
      env: { KONSORA_AGENT: "claude", KONSORA_PLAN: "1" },
      now: () => new Date("2026-11-08T11:00:00Z"),
    };
    const server = createMcpServer(io, undefined);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "claude-code", version: "1.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return {
        isError: Boolean(result.isError),
        text: result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"),
      };
    };
    return { client, call };
  }
  const file = () => readFileSync(join(project(), ".konsora", "tasks.json"), "utf8");

  it("says it is a planning session", async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toContain("This is a planning session");
    await client.close();
  });

  it("refuses start, note, finish, ask, pause, depend and changes to approved work", async () => {
    const { client, call } = await connect();
    const before = file();
    const refused: [string, Record<string, unknown>][] = [
      ["start", { id: "BE-01" }],
      ["note", { id: "BE-02", text: "x" }],
      ["finish", { id: "BE-01", summary: "x" }],
      ["ask", { id: "BE-01", question: "x" }],
      ["pause", { id: "BE-01" }],
      ["depend", { id: "BE-02", on: "BE-01" }],
      ["undepend", { id: "BE-02", on: "BE-01" }],
      ["edit", { id: "BE-01", title: "Hijack" }],
      ["withdraw", { id: "BE-01" }],
    ];
    for (const [tool, args] of refused) {
      const result = await call(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(result.text, tool).toContain("Error (out_of_scope)");
    }
    expect(file()).toBe(before);
    await client.close();
  });

  it("lets the agent read, propose and revise or withdraw proposals", async () => {
    const { client, call } = await connect();
    expect((await call("status")).isError).toBe(false);
    expect((await call("show", { id: "BE-01" })).isError).toBe(false);
    const proposed = await call("propose", {
      title: "Cache",
      group: "BE",
      template: "bug",
      difficulty: "low",
    });
    expect(proposed.isError, proposed.text).toBe(false);
    const batch = await call("batch", { tasks: [{ title: "A", group: "BE", deps: ["BE-03"] }] });
    expect(batch.isError, batch.text).toBe(false);
    expect((await call("edit", { id: "BE-02", title: "Better" })).isError).toBe(false);
    expect((await call("withdraw", { id: "BE-04" })).isError).toBe(false);
    const doc = JSON.parse(file()) as TasksDocument;
    expect(doc.tasks.map((t) => [t.id, t.state])).toEqual([
      ["BE-01", "todo"],
      ["BE-02", "proposed"],
      ["BE-03", "proposed"],
    ]);
    await client.close();
  });
});
