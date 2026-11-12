import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlanPrompt, serializeDocument, type TasksDocument } from "@konsora/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { ChatManager, type ChatView } from "../src/chat.ts";
import { Registry } from "../src/registry.ts";

const token = "a".repeat(64);
const port = 4871;
const at = "2026-11-02T10:00:00Z";

const plan = (): TasksDocument => ({
  schema: "konsora/4",
  project: { name: "Weather" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 0 },
  tasks: [],
});

/** A fake `claude -p`: records its arguments, then streams a canned answer as stream-json. */
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const runs = fs.existsSync(process.env.FAKE_OUT) ? JSON.parse(fs.readFileSync(process.env.FAKE_OUT, "utf8")) : [];
runs.push({ args: process.argv.slice(2), cwd: process.cwd() });
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify(runs));
if (process.env.FAKE_MODE === "hang") { setInterval(() => {}, 1000); return; }
// Like the real CLI: it traps SIGTERM and exits with 143 instead of dying by the signal.
if (process.env.FAKE_MODE === "trap") { process.on("SIGTERM", () => process.exit(143)); setInterval(() => {}, 1000); return; }
const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
out({ type: "system", subtype: "init", session_id: "sess-1" });
out({ type: "assistant", message: { content: [
  { type: "text", text: "What should the cache keep?" },
  { type: "tool_use", name: "mcp__konsora__propose", input: { title: "Add cache" } },
] } });
if (process.env.FAKE_MODE === "fail") {
  out({ type: "result", is_error: true, result: "Not logged in" });
  process.exit(1);
}
out({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "sess-1" });
`;

let dir: string;
let project: string;
let fake: string;
let out: string;
let events: unknown[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "konsora-chat-"));
  project = join(dir, "project");
  mkdirSync(join(project, ".konsora"), { recursive: true });
  writeFileSync(join(project, ".konsora", "tasks.json"), serializeDocument(plan()));
  fake = join(dir, "claude");
  writeFileSync(fake, FAKE);
  chmodSync(fake, 0o755);
  out = join(dir, "runs.json");
  events = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function manager(mode = "") {
  return new ChatManager({
    publish: (_project, payload) => events.push(payload),
    command: fake,
    mcp: { command: "/node", args: ["/bin.ts", "mcp"] },
    env: { ...process.env, FAKE_OUT: out, FAKE_MODE: mode },
    now: () => new Date(at),
  });
}

const runs = () => JSON.parse(readFileSync(out, "utf8")) as { args: string[]; cwd: string }[];

async function idle(chats: ChatManager, id: string): Promise<ChatView> {
  for (let i = 0; i < 200; i++) {
    const view = chats.view(id);
    if (!view.busy) return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the chat never finished");
}

const proj = () => ({ id: "p1", name: "Weather", path: project, added_at: at });

describe("ChatManager (AI panel)", () => {
  it("runs claude -p with the plan prompt and only Konsora's MCP in plan mode, then resumes", async () => {
    const chats = manager();
    const first = await chats.send(proj(), "A forecast cache");
    expect(first.busy).toBe(true);
    const view = await idle(chats, "p1");
    expect(view.messages.map((m) => [m.role, m.text])).toEqual([
      ["human", "A forecast cache"],
      ["agent", "What should the cache keep?"],
      ["tool", 'propose "Add cache"'],
    ]);
    const [run] = runs();
    expect(run?.cwd).toBe(project);
    const args = run?.args ?? [];
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe(buildPlanPrompt(plan(), { goal: "A forecast cache" }));
    expect(args).toContain("--strict-mcp-config");
    expect(
      args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2),
    ).toEqual(["--output-format", "stream-json"]);
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1] as string);
    expect(config.mcpServers.konsora).toEqual({
      type: "stdio",
      command: "/node",
      args: ["/bin.ts", "mcp", "--root", project],
      env: { KONSORA_AGENT: "claude", KONSORA_PLAN: "1" },
    });
    const allowed = args.find((a) => a.startsWith("--allowedTools="));
    expect(allowed).toContain("mcp__konsora__propose");
    expect(allowed).not.toMatch(/start|note|finish|Bash|Edit|Write/);
    // It may read the code, but never write: whatever the user's default mode or allow rules.
    expect(args).toContain("--tools=Glob,Grep,Read,ToolSearch");
    expect(args).toContain("--disallowedTools=Bash,Edit,NotebookEdit,Write");
    expect(
      args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2),
    ).toEqual(["--permission-mode", "default"]);
    expect(args.some((a) => a.startsWith("--dangerously"))).toBe(false);
    expect(args).not.toContain("--resume");

    await chats.send(proj(), "Keep it 10 minutes");
    await idle(chats, "p1");
    const second = runs()[1]?.args ?? [];
    expect(second[1]).toBe("Keep it 10 minutes");
    expect(second.slice(-2)).toEqual(["--resume", "sess-1"]);
    expect(events.at(-1)).toMatchObject({ type: "chat.updated", project: "p1" });
  });

  it("reports a failed turn, a missing CLI, a busy chat and a stopped answer", async () => {
    const failing = manager("fail");
    await failing.send(proj(), "Hi");
    expect((await idle(failing, "p1")).messages.at(-1)).toMatchObject({
      role: "error",
      text: "Not logged in",
    });

    const missing = new ChatManager({ publish: () => {}, command: join(dir, "nope") });
    await missing.send(proj(), "Hi");
    expect((await idle(missing, "p1")).messages.at(-1)?.text).toContain("not installed");

    const hanging = manager("hang");
    await hanging.send(proj(), "Hi");
    await expect(hanging.send(proj(), "Again")).rejects.toMatchObject({ code: "busy" });
    hanging.stop("p1");
    expect((await idle(hanging, "p1")).messages.at(-1)).toMatchObject({
      role: "stopped",
      text: "Stopped.",
    });
    hanging.reset("p1");
    expect(hanging.view("p1")).toEqual({ messages: [], busy: false });

    // The real CLI exits with 143 on SIGTERM: still a stop, not "exited with code 143".
    const trapping = manager("trap");
    await trapping.send(proj(), "Hi");
    await new Promise((resolve) => setTimeout(resolve, 300)); // let it install its handler
    trapping.stop("p1");
    const stopped = await idle(trapping, "p1");
    expect(stopped.messages.at(-1)).toMatchObject({ role: "stopped", text: "Stopped." });
    expect(stopped.messages.some((m) => m.role === "error")).toBe(false);
  });
});

describe("chat routes", () => {
  it("send, read and reset the chat of a linked project", async () => {
    const registry = new Registry(join(dir, "data"));
    const chats = manager();
    const app = createApp({ token, port, registry, chats, now: () => new Date(at) });
    const headers = {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const linked = await registry.add(project, undefined, at);
    const url = `http://127.0.0.1:${port}/api/projects/${linked.id}/chat`;
    const bad = await app.request(url, { method: "POST", headers, body: "{}" });
    expect(bad.status).toBe(400);
    const sent = await app.request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "Plan a cache" }),
    });
    expect(sent.status).toBe(202);
    await idle(chats, linked.id);
    const read = (await (await app.request(url, { headers })).json()) as { chat: ChatView };
    expect(read.chat.messages[0]).toMatchObject({ role: "human", text: "Plan a cache" });
    expect((await app.request(url, { method: "DELETE", headers })).status).toBe(204);
    const after = (await (await app.request(url, { headers })).json()) as { chat: ChatView };
    expect(after.chat.messages).toEqual([]);
    const none = createApp({ token, port, registry, now: () => new Date(at) });
    expect((await none.request(url, { headers })).status).toBe(503);
  });
});
