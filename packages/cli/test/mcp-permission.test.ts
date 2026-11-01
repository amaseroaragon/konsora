import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeDocument, type TasksDocument } from "@konsora/core";
import { type RunningDaemon, startDaemon } from "@konsora/daemon";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp.ts";
import type { Io } from "../src/shared.ts";

const at = "2026-11-02T10:00:00Z";
const RUN = "r-01JC8Z3K2Q";
const plan: TasksDocument = {
  schema: "konsora/2",
  project: { name: "P", base_branch: "main" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 1 },
  tasks: [
    {
      id: "BE-01",
      title: "First",
      state: "doing",
      group: "BE",
      rank: "a",
      created: { at, by: "human" },
      updated_at: at,
    },
  ],
};

let data: string;
let root: string;
let daemon: RunningDaemon;
let runToken: string;

beforeEach(async () => {
  data = mkdtempSync(join(tmpdir(), "konsora-perm-data-"));
  root = mkdtempSync(join(tmpdir(), "konsora-perm-proj-"));
  mkdirSync(join(root, ".konsora"));
  writeFileSync(join(root, ".konsora", "tasks.json"), serializeDocument(plan));
  daemon = await startDaemon({ dataDir: data });
  runToken = daemon.approvals.registerRun({ run: RUN, project: "p", task: "BE-01" });
});
afterEach(async () => {
  await daemon.close();
  rmSync(data, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const runEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  KONSORA_PROJECT: root,
  KONSORA_RUN: RUN,
  KONSORA_TASK: "BE-01",
  KONSORA_DAEMON_URL: daemon.url,
  KONSORA_RUN_TOKEN: runToken,
  ...extra,
});

async function connect(env: NodeJS.ProcessEnv) {
  const io: Io = { stdout: () => {}, stderr: () => {}, cwd: root, env };
  const server = createMcpServer(io, undefined);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const permission = async (input: Record<string, unknown> = { command: "npm publish" }) => {
    const result = (await client.callTool({
      name: "permission",
      arguments: { tool_name: "Bash", input, tool_use_id: "toolu_1" },
    })) as CallToolResult;
    const first = result.content[0];
    return JSON.parse(first?.type === "text" ? first.text : "") as {
      behavior: string;
      updatedInput?: unknown;
      message?: string;
    };
  };
  return { client, permission, close: () => client.close() };
}

/** Plays the human: waits for the pending approval and decides it with the human token. */
async function decide(decision: "allow" | "deny", message?: string) {
  for (let i = 0; i < 200; i++) {
    const [approval] = daemon.approvals.pending();
    if (approval) {
      const res = await fetch(`${daemon.url}/api/runs/${RUN}/permissions/${approval.id}`, {
        method: "POST",
        headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
        body: JSON.stringify({ decision, ...(message ? { message } : {}) }),
      });
      expect(res.status).toBe(200);
      return approval;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("the MCP never asked the daemon");
}

/** A loopback port with nothing listening. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe("the MCP permission tool", () => {
  it("exists only in run mode", async () => {
    const run = await connect(runEnv());
    expect((await run.client.listTools()).tools.map((t) => t.name)).toContain("permission");
    await run.close();
    const manual = await connect({ KONSORA_PROJECT: root });
    expect((await manual.client.listTools()).tools.map((t) => t.name)).not.toContain("permission");
    await manual.close();
  });

  it("returns the human's allow, in Claude's format with the original input", async () => {
    const { permission, close } = await connect(runEnv());
    const [answer, approval] = await Promise.all([
      permission({ command: "npm publish", cwd: "." }),
      decide("allow"),
    ]);
    expect(approval).toMatchObject({
      run: RUN,
      task: "BE-01",
      tool: "Bash",
      tool_use_id: "toolu_1",
    });
    expect(approval.input).toEqual({ command: "npm publish", cwd: "." });
    expect(answer).toEqual({
      behavior: "allow",
      updatedInput: { command: "npm publish", cwd: "." },
    });
    await close();
  });

  it("returns the human's deny with the reason", async () => {
    const { permission, close } = await connect(runEnv());
    const [answer] = await Promise.all([permission(), decide("deny", "Never publish from a run")]);
    expect(answer).toEqual({
      behavior: "deny",
      message: "Konsora denied Bash: Never publish from a run",
    });
    await close();
  });

  it("denies with a reason when the wait runs out", async () => {
    const { permission, close } = await connect(runEnv({ KONSORA_PERMISSION_TIMEOUT_S: "1" }));
    expect(await permission()).toEqual({
      behavior: "deny",
      message: "Konsora denied Bash: No decision arrived in time.",
    });
    await close();
  });

  it("denies with a reason without a daemon, with a bad token or a non-loopback daemon", async () => {
    const cases: [NodeJS.ProcessEnv, string][] = [
      [{ KONSORA_DAEMON_URL: `http://127.0.0.1:${await closedPort()}` }, "is not reachable"],
      [{ KONSORA_DAEMON_URL: undefined }, "no Konsora daemon is configured"],
      [{ KONSORA_DAEMON_URL: "https://example.com:443" }, "no Konsora daemon is configured"],
      [{ KONSORA_RUN_TOKEN: "f".repeat(64) }, "rejected this run's token"],
      [{ KONSORA_RUN_TOKEN: undefined }, "has no token"],
      [{ KONSORA_RUN: undefined }, "has no id"],
    ];
    for (const [extra, reason] of cases) {
      const { permission, close } = await connect(runEnv(extra));
      const answer = await permission();
      expect(answer.behavior, reason).toBe("deny");
      expect(answer.message, reason).toContain(reason);
      await close();
    }
    expect(daemon.approvals.pending()).toEqual([]);
  });

  it("never sends the human token: the run token cannot decide", async () => {
    const { permission, close } = await connect(runEnv({ KONSORA_PERMISSION_TIMEOUT_S: "2" }));
    const answer = permission();
    let approval = daemon.approvals.pending()[0];
    while (!approval) {
      await new Promise((r) => setTimeout(r, 10));
      approval = daemon.approvals.pending()[0];
    }
    const res = await fetch(`${daemon.url}/api/runs/${RUN}/permissions/${approval.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${runToken}`, "content-type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(res.status).toBe(403);
    expect((await answer).behavior).toBe("deny");
    await close();
  });
});
