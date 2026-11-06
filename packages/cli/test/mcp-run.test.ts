import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeDocument, type Task, type TasksDocument } from "@konsora/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, main } from "../src/main.ts";
import { createMcpServer } from "../src/mcp.ts";
import type { Io } from "../src/shared.ts";

const at = "2026-11-02T10:00:00Z";
const RUN = "r-01JC8Z3K2Q";
const t = (id: string, state: Task["state"], deps: string[] = []) =>
  ({
    id,
    title: `Title ${id}`,
    state,
    group: "BE",
    ...(deps.length ? { deps } : {}),
    rank: "a",
    created: { at, by: "human" },
    updated_at: at,
  }) satisfies Task;

const plan = (): TasksDocument => ({
  schema: "konsora/2",
  project: { name: "Weather", base_branch: "main" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 4 },
  tasks: [
    t("BE-01", "done"),
    t("BE-02", "doing"),
    t("BE-03", "todo", ["BE-01"]),
    t("BE-04", "doing"),
  ],
});

/** The main checkout (KONSORA_PROJECT) and a worktree: a copy with its own stale .konsora/. */
let main_: string;
let worktree: string;
let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "konsora-run-"));
  main_ = join(scratch, "main");
  worktree = join(scratch, "worktrees", "BE-04");
  mkdirSync(join(main_, ".konsora"), { recursive: true });
  writeFileSync(join(main_, ".konsora", "tasks.json"), serializeDocument(plan()));
  mkdirSync(join(main_, "src", "deep"), { recursive: true });
  cpSync(main_, worktree, { recursive: true });
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const file = (dir: string) => readFileSync(join(dir, ".konsora", "tasks.json"), "utf8");
const task = (dir: string, id: string) =>
  (JSON.parse(file(dir)) as TasksDocument).tasks.find((x) => x.id === id);

const runEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  KONSORA_PROJECT: main_,
  KONSORA_RUN: RUN,
  KONSORA_TASK: "BE-04",
  ...extra,
});

async function connect(env: NodeJS.ProcessEnv, options: { cwd?: string; root?: string } = {}) {
  const io: Io = { stdout: () => {}, stderr: () => {}, cwd: options.cwd ?? worktree, env };
  const server = createMcpServer(io, options.root);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "1.0.0" });
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

describe("konsora mcp in run mode", () => {
  it("refuses writes on another task with out_of_scope and leaves the plan untouched", async () => {
    const { call, close } = await connect(runEnv());
    const before = file(main_);
    const attempts: [string, Record<string, unknown>][] = [
      ["note", { id: "BE-02", text: "x" }],
      ["ask", { id: "BE-02", question: "x?" }],
      ["finish", { id: "BE-02", summary: "x" }],
      ["start", { id: "BE-03" }],
      ["pause", { id: "BE-02" }],
      ["depend", { id: "BE-03", on: "BE-02" }],
    ];
    for (const [tool, args] of attempts) {
      const result = await call(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(result.text, tool).toContain("Error (out_of_scope): This run works on BE-04");
      expect(result.text, tool).toContain(
        "Hint: Inside a Konsora run you may only act on the run's task",
      );
    }
    expect(file(main_)).toBe(before);
    await close();
  });

  it("allows only note, ask and finish on its own task, plus proposals", async () => {
    const { call, close } = await connect(runEnv());
    for (const [tool, args] of [
      ["pause", { id: "BE-04" }],
      ["start", { id: "BE-04" }],
      ["depend", { id: "BE-04", on: "BE-01" }],
    ] as const) {
      const result = await call(tool, args);
      expect(result.text, tool).toContain(
        "Error (out_of_scope): Inside a run you can only note, ask and finish BE-04, or propose new tasks",
      );
    }
    const proposal = await call("propose", { title: "Follow-up", group: "BE", deps: ["BE-04"] });
    expect(proposal.isError).toBe(false);
    expect(task(main_, "BE-05")).toMatchObject({
      state: "proposed",
      created: { by: "agent:claude" },
    });
    await close();
  });

  it("writes to the plan in KONSORA_PROJECT even when it starts inside the worktree", async () => {
    const worktreeBefore = file(worktree);
    const { call, close } = await connect(runEnv(), { cwd: join(worktree, "src", "deep") });
    expect((await call("show", { id: "BE-04" })).json()).toMatchObject({ id: "BE-04" });
    await call("note", { id: "BE-04", text: "Progress" });
    await call("ask", { id: "BE-04", question: "Which TTL?" });
    expect((await call("status")).json().waiting).toEqual(["BE-04"]);
    const finished = await call("finish", { id: "BE-04", summary: "Done" });
    expect(JSON.stringify(finished)).toContain("Konsora now runs the checks");
    expect(file(worktree)).toBe(worktreeBefore);
    // Inside a run, finish records the summary; Konsora moves the task after the checks.
    expect(task(main_, "BE-04")?.state).toBe("doing");
    expect(task(main_, "BE-04")?.notes?.at(-1)).toMatchObject({ kind: "summary", text: "Done" });
    await close();
  });

  it("records the run id on every note it writes", async () => {
    const { call, close } = await connect(runEnv());
    await call("note", { id: "BE-04", text: "Progress" });
    await call("ask", { id: "BE-04", question: "Which TTL?" });
    await call("finish", { id: "BE-04", summary: "Done" });
    expect(task(main_, "BE-04")?.notes?.map((n) => [n.kind, n.run, n.by])).toEqual([
      ["note", RUN, "agent:claude"],
      ["question", RUN, "agent:claude"],
      ["summary", RUN, "agent:claude"],
    ]);
    await close();
  });

  it("explains the run to the agent in the server instructions", async () => {
    const { client, close } = await connect(runEnv());
    expect(client.getInstructions()).toContain(
      `You are inside Konsora run ${RUN}, working on BE-04`,
    );
    await close();
    const manual = await connect({}, { cwd: main_ });
    expect(manual.client.getInstructions()).not.toContain("inside Konsora run");
    await manual.close();
  });

  it("accepts KONSORA_RUN_TASK as an alias, and rejects aliases that disagree", async () => {
    const alias = await connect({ KONSORA_PROJECT: main_, KONSORA_RUN_TASK: "be-04" });
    expect((await alias.call("note", { id: "BE-02", text: "x" })).text).toContain("out_of_scope");
    await alias.close();
    const both = await connect(runEnv({ KONSORA_RUN_TASK: "BE-02" }));
    const result = await both.call("note", { id: "BE-04", text: "x" });
    expect(result.text).toContain(
      "KONSORA_TASK (BE-04) and KONSORA_RUN_TASK (BE-02) name different tasks.",
    );
    await both.close();
  });

  it("refuses a --root that points away from KONSORA_PROJECT", async () => {
    const { call, close } = await connect(runEnv(), { root: worktree });
    const result = await call("note", { id: "BE-04", text: "x" });
    expect(result.text).toContain("Error: --root points to a different plan than KONSORA_PROJECT.");
    expect(file(worktree)).toBe(file(main_));
    await close();
  });
});

describe("the CLI in run mode", () => {
  async function cli(args: string[], env: NodeJS.ProcessEnv) {
    let stderr = "";
    const code = await main(args, {
      stdout: () => {},
      stderr: (s) => {
        stderr += s;
      },
      cwd: worktree,
      env,
    });
    return { code, stderr };
  }

  it("uses the same scope and project as the MCP", async () => {
    const env = runEnv({ KONSORA_AGENT: "codex" });
    const other = await cli(["note", "BE-02", "x"], env);
    expect(other.code).toBe(EXIT.failure);
    expect(other.stderr).toContain("This run works on BE-04");
    expect((await cli(["note", "BE-04", "from the cli"], env)).code).toBe(EXIT.ok);
    expect(task(main_, "BE-04")?.notes?.at(-1)).toMatchObject({ by: "agent:codex", run: RUN });
    expect(task(worktree, "BE-04")?.notes).toBeUndefined();
  });
});
