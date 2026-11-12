import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTasksFile, serializeDocument, type Task, type TasksDocument } from "@konsora/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { diffTasks } from "../src/events.ts";
import { type RunningDaemon, startDaemon } from "../src/server.ts";

const at = "2026-11-02T10:00:00Z";
const t = (id: string, state: Task["state"], title = `Title ${id}`): Task => ({
  id,
  title,
  state,
  group: "BE",
  rank: "a",
  created: { at, by: "human" },
  updated_at: at,
});
const doc = (...tasks: Task[]): TasksDocument => ({
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 9 },
  tasks,
});

let data: string;
let root: string;
let daemon: RunningDaemon;
let projectId: string;
const file = () => join(root, ".konsora", "tasks.json");

beforeEach(async () => {
  data = mkdtempSync(join(tmpdir(), "konsora-ev-data-"));
  root = mkdtempSync(join(tmpdir(), "konsora-ev-proj-"));
  mkdirSync(join(root, ".konsora"));
  writeFileSync(file(), serializeDocument(doc(t("BE-01", "doing"), t("BE-02", "todo"))));
  daemon = await startDaemon({ dataDir: data });
  const res = await fetch(`${daemon.url}/api/projects`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    body: JSON.stringify({ path: root }),
  });
  projectId = ((await res.json()) as { project: { id: string } }).project.id;
});
afterEach(async () => {
  await daemon.close();
  rmSync(data, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

type Message = Record<string, unknown> & { type: string };

/** A small client that queues messages and lets tests await the next one of a type. */
function client(headers: Record<string, string> = {}) {
  const ws = new WebSocket(`${daemon.url.replace("http", "ws")}/api/ws`, { headers });
  const queue: Message[] = [];
  const waiters: { type: string; resolve: (m: Message) => void }[] = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw)) as Message;
    const waiter = waiters.findIndex((w) => w.type === message.type);
    if (waiter >= 0) waiters.splice(waiter, 1)[0]?.resolve(message);
    else queue.push(message);
  });
  const next = (type: string, timeoutMs = 2000) =>
    new Promise<Message>((resolve, reject) => {
      const queued = queue.findIndex((m) => m.type === type);
      if (queued >= 0) return resolve(queue.splice(queued, 1)[0] as Message);
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      waiters.push({ type, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.once("close", (code, reason) => resolve({ code, reason: String(reason) })),
  );
  const send = (value: unknown) => ws.send(JSON.stringify(value));
  return { ws, next, opened, closed, send, queue };
}

async function subscribed() {
  const c = client();
  await c.opened;
  c.send({ type: "auth", token: daemon.token });
  await c.next("ready");
  c.send({ type: "subscribe", project: projectId });
  await c.next("subscribed");
  return c;
}

describe("diffTasks", () => {
  it("reports added, removed and modified tasks by content", () => {
    expect(
      diffTasks([t("A-01", "todo"), t("A-02", "todo")], [t("A-01", "doing"), t("A-03", "todo")]),
    ).toEqual({
      added: ["A-03"],
      removed: ["A-02"],
      modified: ["A-01"],
    });
  });
});

describe("WebSocket handshake", () => {
  it("closes with 4401 without an auth message, or with a wrong token", async () => {
    const silent = client();
    await silent.opened;
    silent.send({ type: "subscribe", project: projectId });
    expect((await silent.closed).code).toBe(4401);

    const wrong = client();
    await wrong.opened;
    wrong.send({ type: "auth", token: "f".repeat(64) });
    expect((await wrong.closed).code).toBe(4401);
  });

  it("rejects a foreign Origin or a rebinding Host at the upgrade (403)", async () => {
    for (const headers of [{ origin: "https://evil.example" }, { host: "evil.example" }]) {
      const c = client(headers);
      const status = await new Promise<number>((resolve) => {
        c.ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        c.ws.on("error", () => resolve(-1));
      });
      expect(status).toBe(403);
    }
  });

  it("refuses unknown projects", async () => {
    const c = client();
    await c.opened;
    c.send({ type: "auth", token: daemon.token });
    await c.next("ready");
    c.send({ type: "subscribe", project: "p-000000000000" });
    expect(await c.next("error")).toMatchObject({ message: "Unknown project" });
    c.ws.close();
  });
});

describe("board events", () => {
  it("an external edit emits board.changed within 500 ms with a per-task diff", async () => {
    const c = await subscribed();
    const started = Date.now();
    writeFileSync(
      file(),
      serializeDocument(doc(t("BE-01", "doing"), t("BE-02", "doing"), t("BE-03", "proposed"))),
    );
    const event = await c.next("board.changed", 1000);
    expect(Date.now() - started).toBeLessThan(500);
    expect(event).toMatchObject({
      project: projectId,
      hash: expect.stringMatching(/^sha256:/),
      changes: { added: ["BE-03"], removed: [], modified: ["BE-02"] },
      external: [],
    });
    c.ws.close();
  });

  it("includes unapproved external changes in the event", async () => {
    await fetch(`${daemon.url}/api/projects/${projectId}/board`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    const c = await subscribed();
    writeFileSync(file(), serializeDocument(doc(t("BE-01", "done"), t("BE-02", "todo"))));
    const event = await c.next("board.changed");
    expect(event.external).toEqual([
      expect.objectContaining({ task: "BE-01", kind: "transition", to: "done" }),
    ]);
    c.ws.close();
  });

  it("emits board.invalid with issues and board.missing when the file goes away", async () => {
    const c = await subscribed();
    writeFileSync(file(), '{"schema":"konsora/2"}');
    const invalid = await c.next("board.invalid");
    expect((invalid.issues as unknown[]).length).toBeGreaterThan(0);
    unlinkSync(file());
    await c.next("board.missing");
    c.ws.close();
  });

  it("the daemon's own ops reach subscribers too", async () => {
    const c = await subscribed();
    const res = await fetch(`${daemon.url}/api/projects/${projectId}/ops`, {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "pause", task: "BE-01" }),
    });
    expect(res.status).toBe(200);
    const event = await c.next("board.changed");
    expect(event).toMatchObject({ changes: { modified: ["BE-01"] }, external: [] });
    const onDisk = parseTasksFile(readFileSync(file(), "utf8"));
    expect(onDisk.ok && onDisk.document.tasks[0]?.state).toBe("todo");
    c.ws.close();
  });

  it("several clients share one watcher; it stops when the last one leaves", async () => {
    const a = await subscribed();
    const b = await subscribed();
    writeFileSync(
      file(),
      serializeDocument(doc(t("BE-01", "doing", "Renamed"), t("BE-02", "todo"))),
    );
    await Promise.all([a.next("board.changed"), b.next("board.changed")]);
    a.send({ type: "unsubscribe", project: projectId });
    await a.next("unsubscribed");
    b.ws.close();
    await b.closed;
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(file(), serializeDocument(doc(t("BE-01", "doing", "Again"), t("BE-02", "todo"))));
    await new Promise((r) => setTimeout(r, 300));
    expect(a.queue.filter((m) => m.type === "board.changed")).toEqual([]);
    a.ws.close();
  });
});
