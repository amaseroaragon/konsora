import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeDocument, type TasksDocument } from "@konsora/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Approvals } from "../src/approvals.ts";
import { type RunningDaemon, startDaemon } from "../src/server.ts";

const at = "2026-11-02T10:00:00Z";
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
let projectId: string;
let runToken: string;
const RUN = "r-01JC8Z3K2Q";

beforeEach(async () => {
  data = mkdtempSync(join(tmpdir(), "konsora-ap-data-"));
  root = mkdtempSync(join(tmpdir(), "konsora-ap-proj-"));
  mkdirSync(join(root, ".konsora"));
  writeFileSync(join(root, ".konsora", "tasks.json"), serializeDocument(plan));
  daemon = await startDaemon({ dataDir: data });
  const res = await human("/api/projects", { path: root });
  projectId = ((await res.json()) as { project: { id: string } }).project.id;
  runToken = daemon.approvals.registerRun({ run: RUN, project: projectId, task: "BE-01" });
});
afterEach(async () => {
  await daemon.close();
  rmSync(data, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function human(path: string, body?: unknown, token = daemon.token) {
  return fetch(`${daemon.url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function ask(
  body: Record<string, unknown> = {},
  options: { run?: string; token?: string; headers?: Record<string, string> } = {},
) {
  return fetch(`${daemon.url}/api/runs/${options.run ?? RUN}/permissions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token ?? runToken}`,
      "content-type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify({ tool_name: "Bash", input: { command: "rm -rf build" }, ...body }),
  });
}

type Pending = { id: string; run: string; task: string; tool: string; state: string };

/** Waits until the daemon lists a pending approval, as the UI would see it. */
async function pending(): Promise<Pending> {
  for (let i = 0; i < 100; i++) {
    const list = (await (await human("/api/approvals")).json()) as { approvals: Pending[] };
    if (list.approvals[0]) return list.approvals[0];
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no pending approval");
}

describe("permission approvals of a run", () => {
  it("returns exactly the human's decision: allow", async () => {
    const reply = ask({ tool_use_id: "toolu_1" });
    const approval = await pending();
    expect(approval).toMatchObject({ run: RUN, task: "BE-01", tool: "Bash", state: "pending" });
    const decided = await human(`/api/runs/${RUN}/permissions/${approval.id}`, {
      decision: "allow",
    });
    expect(decided.status).toBe(200);
    const res = await reply;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: approval.id, behavior: "allow" });
    expect(((await (await human("/api/approvals")).json()) as { approvals: [] }).approvals).toEqual(
      [],
    );
  });

  it("returns exactly the human's decision: deny, with the human's reason", async () => {
    const reply = ask();
    const approval = await pending();
    await human(`/api/runs/${RUN}/permissions/${approval.id}`, {
      decision: "deny",
      message: "Not in this repo",
    });
    expect(await (await reply).json()).toEqual({
      id: approval.id,
      behavior: "deny",
      message: "Not in this repo",
    });
  });

  it("denies when no decision arrives in time", async () => {
    const res = await ask({ wait_s: 1 });
    expect(await res.json()).toMatchObject({
      behavior: "deny",
      message: "No decision arrived in time.",
    });
  });

  it("announces requests and resolutions to the project's WebSocket subscribers", async () => {
    const ws = new WebSocket(`${daemon.url.replace("http", "ws")}/api/ws`);
    const messages: { type: string; approval?: Pending }[] = [];
    const seen = (type: string) =>
      new Promise<void>((resolve) => {
        const check = () => (messages.some((m) => m.type === type) ? resolve() : undefined);
        ws.on("message", (raw) => {
          messages.push(JSON.parse(String(raw)));
          check();
        });
        check();
      });
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify({ type: "auth", token: daemon.token }));
    await seen("ready");
    ws.send(JSON.stringify({ type: "subscribe", project: projectId }));
    await seen("subscribed");
    const reply = ask();
    await seen("permission.requested");
    const requested = messages.find((m) => m.type === "permission.requested");
    expect(requested).toMatchObject({
      project: projectId,
      run: RUN,
      approval: { task: "BE-01", tool: "Bash", state: "pending" },
    });
    await human(`/api/runs/${RUN}/permissions/${requested?.approval?.id}`, { decision: "allow" });
    await reply;
    await seen("permission.resolved");
    expect(messages.find((m) => m.type === "permission.resolved")).toMatchObject({
      approval: { state: "allowed" },
    });
    ws.close();
  });
});

describe("who may ask and who may decide", () => {
  it("only the run's own token can ask, and never from a browser", async () => {
    const other = daemon.approvals.registerRun({
      run: "r-OTHER",
      project: projectId,
      task: "BE-01",
    });
    expect((await ask({}, { token: daemon.token })).status).toBe(403);
    expect((await ask({}, { token: other })).status).toBe(403);
    expect((await ask({}, { token: "f".repeat(64) })).status).toBe(403);
    expect((await ask({}, { run: "r-UNKNOWN" })).status).toBe(403);
    expect((await ask({}, { headers: { origin: daemon.url } })).status).toBe(403);
    expect((await ask({ tool_name: "" })).status).toBe(400);
    expect(daemon.approvals.pending()).toEqual([]);
  });

  it("only the human token can decide, only on pending approvals of that run", async () => {
    const reply = ask();
    const approval = await pending();
    const path = `/api/runs/${RUN}/permissions/${approval.id}`;
    // The run cannot approve itself.
    expect((await human(path, { decision: "allow" }, runToken)).status).toBe(403);
    expect((await human("/api/approvals", undefined, runToken)).status).toBe(403);
    // Not that run, not that id, not a decision.
    expect(
      (await human(`/api/runs/r-OTHER/permissions/${approval.id}`, { decision: "allow" })).status,
    ).toBe(404);
    expect((await human(`/api/runs/${RUN}/permissions/p-nope`, { decision: "allow" })).status).toBe(
      404,
    );
    expect((await human(path, { decision: "maybe" })).status).toBe(400);
    expect((await pending()).id).toBe(approval.id);
    expect((await human(path, { decision: "deny" })).status).toBe(200);
    expect((await human(path, { decision: "allow" })).status).toBe(409);
    expect(await (await reply).json()).toMatchObject({ behavior: "deny" });
  });

  it("denies what is still waiting when the run ends or the daemon stops", async () => {
    const approvals = new Approvals();
    const info = { run: "r-1", project: "p", task: "BE-01" };
    approvals.registerRun(info);
    const ended = approvals.request(info, { tool_name: "Bash", input: {} }, 60_000);
    approvals.endRun("r-1");
    expect((await ended).decision).toEqual({ behavior: "deny", message: "The run has ended." });
    const stopped = approvals.request(info, { tool_name: "Bash", input: {} }, 60_000);
    approvals.close();
    expect((await stopped).decision).toMatchObject({ behavior: "deny" });
    expect(approvals.authenticate("r-1", "x")).toBeUndefined();
  });
});
