/**
 * The agent's session commands: `log` (CLI-06), `next` (CLI-04) and the dependencies' closing
 * summaries that `start` hands over (CLI-05), on the CLI and on the MCP server.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { completionLog, serializeDocument, type Task, type TasksDocument } from "@konsora/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, main } from "../src/main.ts";
import { createMcpServer } from "../src/mcp.ts";

const at = "2026-11-02T10:00:00Z";
const t = (id: string, state: Task["state"], deps: string[] = [], extra: Partial<Task> = {}) =>
  ({
    id,
    title: `Title ${id}`,
    state,
    group: id.split("-")[0] as string,
    ...(deps.length ? { deps } : {}),
    rank: "m",
    created: { at, by: "human" },
    updated_at: at,
    ...extra,
  }) satisfies Task;

const summary = (when: string, by: string, text: string) => ({
  notes: [{ id: "n1", at: when, by, kind: "summary" as const, text }],
  updated_at: when,
});

function plan(): TasksDocument {
  return {
    schema: "konsora/5",
    project: { name: "Weather" },
    groups: [{ id: "BE", name: "Backend" }],
    seq: { BE: 6 },
    tasks: [
      t(
        "BE-01",
        "done",
        [],
        summary("2026-11-03T09:00:00Z", "agent:claude", "Added the API client.\nWith retries."),
      ),
      t("BE-02", "done", [], {
        ...summary("2026-11-05T09:00:00Z", "agent:codex", "Cached responses for 10 min."),
        acceptance: [{ id: "ac1", text: "Fast" }],
      }),
      t("BE-03", "done"),
      t("BE-04", "todo", ["BE-01", "BE-02"], { rank: "c" }),
      t("BE-05", "todo", [], { rank: "b", title: "First ready" }),
      t("BE-06", "todo", ["BE-04"], { rank: "a" }),
    ],
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "konsora-flow-"));
  execFileSync("git", ["init", "-q", "-b", "trunk"], { cwd: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(doc: TasksDocument = plan()) {
  mkdirSync(join(dir, ".konsora"), { recursive: true });
  writeFileSync(join(dir, ".konsora", "tasks.json"), serializeDocument(doc));
}

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
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
    env,
    now: () => new Date("2026-11-10T12:00:00Z"),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

async function connect(env: NodeJS.ProcessEnv = {}) {
  const server = createMcpServer(
    {
      stdout: () => {},
      stderr: () => {},
      cwd: dir,
      env,
      now: () => new Date("2026-11-10T12:00:00Z"),
    },
    undefined,
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const first = result.content[0];
    const text = first?.type === "text" ? first.text : "";
    return { isError: Boolean(result.isError), text, json: () => JSON.parse(text) };
  };
  return { client, call, close: () => client.close() };
}

describe("konsora log", () => {
  it("lists the done tasks newest first with date, who closed it and the summary's first line", async () => {
    seed();
    const r = await run(["log"]);
    expect(r.code).toBe(EXIT.ok);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(
      /^2026-11-05 09:00 {2}BE-02 {2}codex +Title BE-02 {2}\[1 without evidence\]$/,
    );
    expect(lines[1]?.trim()).toBe("Cached responses for 10 min.");
    expect(lines[2]).toMatch(/^2026-11-03 09:00 {2}BE-01 {2}claude {2}Title BE-01$/);
    expect(lines[3]?.trim()).toBe("Added the API client.");
    expect(lines[4]).toMatch(/^2026-11-02 10:00 {2}BE-03 {2}- +Title BE-03$/);
    expect(lines[5]?.trim()).toBe("(no closing summary)");
    expect(r.stdout).not.toContain("With retries.");
  });

  it("--json is core's completionLog; --since and --limit filter it", async () => {
    seed();
    expect((await run(["log", "--json"])).json()).toEqual(completionLog(plan()));
    const since = (await run(["log", "--since", "2026-11-03", "--json"])).json();
    expect(since.map((e: { id: string }) => e.id)).toEqual(["BE-02", "BE-01"]);
    const at = (await run(["log", "--since", "2026-11-05T09:00:00Z", "--json"])).json();
    expect(at.map((e: { id: string }) => e.id)).toEqual(["BE-02"]);
    const limited = (await run(["log", "--limit", "1", "--json"])).json();
    expect(limited).toEqual(completionLog(plan()).slice(0, 1));
    expect((await run(["log", "--since", "2026-12-01"])).stdout).toBe("No finished tasks match.\n");
  });

  it("includes archived tasks and rejects bad options", async () => {
    seed();
    expect((await run(["archive", "--before", "2026-11-04", "--write"])).code).toBe(EXIT.ok);
    const log = (await run(["log", "--json"])).json();
    expect(log.map((e: { id: string; archived?: true }) => [e.id, e.archived ?? false])).toEqual([
      ["BE-02", false],
      ["BE-01", true],
      ["BE-03", true],
    ]);
    expect((await run(["log"])).stdout).toContain("[archived]");
    for (const bad of [
      ["--since", "yesterday"],
      ["--limit", "0"],
      ["--limit", "2.5"],
    ]) {
      const r = await run(["log", ...bad]);
      expect(r.code, bad.join(" ")).toBe(EXIT.usage);
      expect(r.stderr).toContain("Hint:");
    }
  });

  it("the MCP log tool returns the same, read-only, and is allowed in planning sessions", async () => {
    seed();
    const { client, call, close } = await connect({ KONSORA_PLAN: "1" });
    const tool = (await client.listTools()).tools.find((x) => x.name === "log");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect((await call("log")).json()).toEqual((await run(["log", "--json"])).json());
    expect((await call("log", { since: "2026-11-03", limit: 1 })).json()).toEqual(
      (await run(["log", "--since", "2026-11-03", "--limit", "1", "--json"])).json(),
    );
    expect((await call("log", { since: "nope" })).isError).toBe(true);
    await close();
    const { PLAN_TOOLS } = await import("@konsora/core");
    expect(PLAN_TOOLS).toContain("mcp__konsora__log");
  });
});

describe("start hands over the dependencies' closing summaries", () => {
  it("the CLI prints each done direct dependency with its id, title and summary", async () => {
    seed();
    const r = await run(["start", "BE-04", "--as", "claude"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("Started BE-04 (doing).");
    const section = r.stdout.slice(r.stdout.indexOf("Done dependencies"));
    expect(section).toBe(
      [
        "Done dependencies (their closing summaries):",
        "  BE-01 · Title BE-01  (done 2026-11-03 09:00 by claude)",
        "      Added the API client.",
        "      With retries.",
        "  BE-02 · Title BE-02  (done 2026-11-05 09:00 by codex)",
        "      Cached responses for 10 min.",
        "",
      ].join("\n"),
    );
  });

  it("--json adds them under dependencies, and the MCP start tool returns the same", async () => {
    seed();
    const cli = (await run(["start", "BE-04", "--as", "claude", "--json"])).json();
    const expected = completionLog(plan()).filter((e) => e.id === "BE-01" || e.id === "BE-02");
    expect(cli.dependencies).toEqual([expected[1], expected[0]]);
    expect(cli.tasks[0]).toMatchObject({ id: "BE-04", state: "doing" });

    seed();
    const { call, close } = await connect({ KONSORA_AGENT: "claude" });
    const mcp = await call("start", { id: "be-04" });
    expect(mcp.isError).toBe(false);
    expect(mcp.json()).toEqual(cli);
    await close();
  });

  it("finds an archived dependency's summary in the archive", async () => {
    seed();
    expect((await run(["archive", "--before", "2026-11-04", "--write"])).code).toBe(EXIT.ok);
    const cli = (await run(["start", "BE-04", "--as", "claude", "--json"])).json();
    expect(
      cli.dependencies.map((e: { id: string; archived?: true }) => [e.id, e.archived]),
    ).toEqual([
      ["BE-01", true],
      ["BE-02", undefined],
    ]);
  });

  it("a task without dependencies adds no empty section", async () => {
    seed();
    const r = await run(["start", "BE-05", "--as", "claude"]);
    expect(r.stdout).not.toContain("Done dependencies");
    seed();
    expect((await run(["start", "BE-05", "--as", "claude", "--json"])).json()).not.toHaveProperty(
      "dependencies",
    );
    seed();
    const { call, close } = await connect({ KONSORA_AGENT: "claude" });
    expect((await call("start", { id: "BE-05" })).json()).not.toHaveProperty("dependencies");
    await close();
  });
});

describe("konsora next", () => {
  it("prints the ready task with the lowest rank like show, and --json like show --json", async () => {
    seed();
    const r = await run(["next"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toBe((await run(["show", "BE-05"])).stdout);
    expect((await run(["next", "--json"])).json()).toEqual(
      (await run(["show", "BE-05", "--json"])).json(),
    );
  });

  it("--start also starts it, with what start prints", async () => {
    seed();
    const r = await run(["next", "--start", "--as", "claude", "-m", "Do it"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toMatch(/^Started BE-05 \(doing\)\./);
    const started = (await run(["show", "BE-05", "--json"])).json();
    expect(started.state).toBe("doing");
    expect(started.notes.at(-1)).toMatchObject({ by: "agent:claude", text: "Do it" });
    // The next one is BE-04, whose start hands over its dependencies' summaries.
    const json = (await run(["next", "--start", "--as", "claude", "--json"])).json();
    expect(json.tasks[0]).toMatchObject({ id: "BE-04", state: "doing" });
    expect(json.dependencies.map((e: { id: string }) => e.id)).toEqual(["BE-01", "BE-02"]);
  });

  it("with nothing ready says why and exits non-zero", async () => {
    seed({ ...plan(), tasks: [] });
    let r = await run(["next"]);
    expect(r.code).toBe(EXIT.failure);
    expect(r.stderr).toContain("No task is ready. The plan is empty.");
    expect(r.stderr).toContain("Hint: Promote an idea");

    const base = plan();
    const at = "2026-11-06T10:00:00Z";
    seed({
      ...base,
      tasks: [
        t("BE-01", "doing", [], {
          notes: [{ id: "n1", at, by: "agent:claude", kind: "question", text: "Which API?" }],
        }),
        t("BE-02", "todo", ["BE-01"]),
        t("BE-03", "proposed"),
      ],
    });
    r = await run(["next"]);
    expect(r.code).toBe(EXIT.failure);
    expect(r.stderr).toContain("every todo task is blocked (BE-02 by BE-01)");
    expect(r.stderr).toContain("In progress: BE-01.");
    expect(r.stderr).toContain("Waiting for an answer from the human: BE-01.");
    expect(r.stderr).toContain("Hint: Finish the tasks in progress");

    seed({ ...base, tasks: [t("BE-01", "done"), t("BE-03", "proposed")] });
    r = await run(["next", "--start", "--as", "claude"]);
    expect(r.code).toBe(EXIT.failure);
    expect(r.stderr).toContain("No task is left to do (ideas: BE-03).");
  });

  it("the MCP next tool returns the same over stdio, and starts it with start: true", async () => {
    seed();
    const expected = (await run(["next", "--json"])).json();
    const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "mcp", "--root", dir],
      cwd: tmpdir(),
      env: { ...process.env, KONSORA_AGENT: "claude" } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    const call = async (args: Record<string, unknown>) => {
      const result = (await client.callTool({ name: "next", arguments: args })) as CallToolResult;
      const first = result.content[0];
      return { isError: Boolean(result.isError), text: first?.type === "text" ? first.text : "" };
    };
    const shown = await call({});
    expect(shown.isError).toBe(false);
    expect(JSON.parse(shown.text)).toEqual(expected);
    const started = await call({ start: true, plan: "Go" });
    expect(started.isError).toBe(false);
    expect(JSON.parse(started.text).tasks[0]).toMatchObject({ id: "BE-05", state: "doing" });
    await client.close();
    expect((await run(["show", "BE-05", "--json"])).json().notes.at(-1)).toMatchObject({
      by: "agent:claude",
      text: "Go",
    });

    seed({ ...plan(), tasks: [] });
    const { call: inMemory, close } = await connect();
    const none = await inMemory("next");
    expect(none.isError).toBe(true);
    expect(none.text).toContain("No task is ready. The plan is empty.");
    expect(none.text).toContain("Hint: Promote an idea with the promote tool");
    await close();
  });
});
