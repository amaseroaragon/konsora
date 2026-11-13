import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeDocument, type TasksDocument } from "@konsora/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { checkRequest } from "../src/auth.ts";
import { Registry } from "../src/registry.ts";
import { findDaemon, startDaemon } from "../src/server.ts";

const token = "a".repeat(64);
const port = 4870;
const at = "2026-11-02T10:00:00Z";

let data: string;
let projectDir: string;
let app: ReturnType<typeof createApp>;

function plan(): TasksDocument {
  return {
    schema: "konsora/5",
    project: { name: "Weather" },
    groups: [{ id: "BE", name: "Backend" }],
    seq: { BE: 2 },
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
      {
        id: "BE-02",
        title: "Second",
        state: "todo",
        group: "BE",
        deps: ["BE-01"],
        rank: "b",
        created: { at, by: "human" },
        updated_at: at,
      },
    ],
  };
}

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "konsora-data-"));
  projectDir = mkdtempSync(join(tmpdir(), "konsora-proj-"));
  app = createApp({
    token,
    port,
    extraOrigins: ["http://127.0.0.1:5173"],
    registry: new Registry(data),
    now: () => new Date(at),
  });
});
afterEach(() => {
  rmSync(data, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

const ok = { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` };
function call(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
) {
  const headers: Record<string, string> = { ...ok, ...(init.headers ?? {}) };
  for (const [k, v] of Object.entries(headers)) if (v === "") delete headers[k];
  return app.request(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...headers,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function link(path = projectDir) {
  const res = await call("/api/projects", { method: "POST", body: { path } });
  return { res, body: (await res.json()) as { project: { id: string; path: string } } };
}

describe("request guard", () => {
  it.each([
    ["no token", { authorization: "" }, "token"],
    ["a wrong token", { authorization: `Bearer ${"b".repeat(64)}` }, "token"],
    ["a malformed token", { authorization: `Bearer ${token}x` }, "token"],
    ["a non-bearer scheme", { authorization: `Basic ${token}` }, "token"],
    ["a foreign Origin", { origin: "https://evil.example" }, "origin"],
    ["an Origin on another port", { origin: "http://127.0.0.1:9999" }, "origin"],
    ["a rebinding Host", { host: `evil.example:${port}` }, "host"],
    ["the right host on another port", { host: "127.0.0.1:9999" }, "host"],
  ])("rejects %s with 403", async (_name, headers, reason) => {
    const res = await call("/api/health", { headers });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "forbidden", reason } });
  });

  it("guards every API route, including writes", async () => {
    expect((await call("/api/projects", { headers: { authorization: "" } })).status).toBe(403);
    expect(
      (
        await call("/api/projects", {
          method: "POST",
          body: { path: projectDir },
          headers: { origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(readdirSync(data)).toEqual([]); // nothing registered
  });

  it("accepts the right token with allowed hosts and origins", async () => {
    for (const headers of [
      {},
      { host: `localhost:${port}` },
      { origin: `http://localhost:${port}` },
      { origin: "http://127.0.0.1:5173" },
    ]) {
      const res = await call("/api/health", { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("checkRequest is pure and usable for the WebSocket handshake", () => {
    expect(
      checkRequest(
        { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` },
        { token, port },
      ),
    ).toBeNull();
    expect(checkRequest({ host: null, authorization: `Bearer ${token}` }, { token, port })).toBe(
      "host",
    );
  });
});

describe("project registry", () => {
  it("links a folder by its canonical path, idempotently, writing nothing inside it", async () => {
    mkdirSync(join(projectDir, "src"));
    writeFileSync(join(projectDir, "src", "main.ts"), "x");
    const before = JSON.stringify(readdirSync(projectDir, { recursive: true }).sort());
    const mtime = statSync(projectDir).mtimeMs;
    const alias = `${projectDir}-alias`;
    symlinkSync(projectDir, alias);

    const first = await link(alias);
    expect(first.res.status).toBe(201);
    expect(first.body.project.path).toBe(projectDir);
    expect(first.body.project.id).toMatch(/^p-[0-9a-f]{12}$/);
    const again = await link(projectDir);
    expect(again.body.project.id).toBe(first.body.project.id);

    expect(JSON.stringify(readdirSync(projectDir, { recursive: true }).sort())).toBe(before);
    expect(statSync(projectDir).mtimeMs).toBe(mtime);
    const list = (await (await call("/api/projects")).json()) as { projects: unknown[] };
    expect(list.projects).toHaveLength(1);
    rmSync(alias);
  });

  it("stores the registry privately (dir 0700, file 0600)", async () => {
    await link();
    expect(statSync(data).mode & 0o777).toBe(0o700);
    expect(statSync(join(data, "projects.json")).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["a relative path", "some/folder", "not_found"],
    ["a missing folder", "/definitely/not/here", "not_found"],
  ])("rejects %s", async (_name, path, code) => {
    const res = await call("/api/projects", { method: "POST", body: { path } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code } });
  });

  it("rejects files and Konsora's own data folder", async () => {
    writeFileSync(join(projectDir, "file.txt"), "x");
    expect(
      (await (
        await call("/api/projects", {
          method: "POST",
          body: { path: join(projectDir, "file.txt") },
        })
      ).json()) as object,
    ).toMatchObject({ error: { code: "not_a_directory" } });
    expect(
      (await (
        await call("/api/projects", { method: "POST", body: { path: data } })
      ).json()) as object,
    ).toMatchObject({ error: { code: "inside_data_dir" } });
    expect((await call("/api/projects", { method: "POST", body: { nope: 1 } })).status).toBe(400);
  });

  it("unlinking forgets the project and leaves its files untouched", async () => {
    mkdirSync(join(projectDir, ".konsora"));
    writeFileSync(join(projectDir, ".konsora", "tasks.json"), serializeDocument(plan()));
    const { body } = await link();
    expect((await call(`/api/projects/${body.project.id}`, { method: "DELETE" })).status).toBe(204);
    expect(readFileSync(join(projectDir, ".konsora", "tasks.json"), "utf8")).toBe(
      serializeDocument(plan()),
    );
    expect((await call(`/api/projects/${body.project.id}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("read endpoints", () => {
  it("board reports a folder without a plan as missing", async () => {
    const { body } = await link();
    const board = (await (await call(`/api/projects/${body.project.id}/board`)).json()) as Record<
      string,
      unknown
    >;
    expect(board).toMatchObject({ status: "missing" });
    expect(readdirSync(projectDir)).toEqual([]);
  });

  it("board carries the plan's milestones for the UI (CORE-19)", async () => {
    mkdirSync(join(projectDir, ".konsora"));
    const withMilestones = { ...plan(), milestones: [{ id: "m1", name: "Primero" }] };
    writeFileSync(join(projectDir, ".konsora", "tasks.json"), serializeDocument(withMilestones));
    const { body } = await link();
    const board = (await (await call(`/api/projects/${body.project.id}/board`)).json()) as {
      plan: { milestones?: unknown[] };
    };
    expect(board.plan.milestones).toEqual([{ id: "m1", name: "Primero" }]);
  });

  it("board returns tasks in dependency order with derived flags and hashes", async () => {
    mkdirSync(join(projectDir, ".konsora"));
    writeFileSync(join(projectDir, ".konsora", "tasks.json"), serializeDocument(plan()));
    const { body } = await link();
    const board = (await (await call(`/api/projects/${body.project.id}/board`)).json()) as {
      status: string;
      hash: string;
      plan: { groups: unknown[] };
      tasks: { id: string; blocked: boolean; blockers: string[]; hash: string }[];
    };
    expect(board.status).toBe("ok");
    expect(board.hash).toMatch(/^sha256:/);
    expect(board.plan.groups).toEqual([{ id: "BE", name: "Backend" }]);
    expect(board.tasks.map((t) => t.id)).toEqual(["BE-01", "BE-02"]);
    expect(board.plan).not.toHaveProperty("milestones");
    expect(board.tasks[1]).toMatchObject({
      blocked: true,
      blockers: ["BE-01"],
      hash: expect.stringMatching(/^sha256:/),
    });
    const list = (await (await call("/api/projects")).json()) as { projects: { plan: object }[] };
    expect(list.projects[0]?.plan).toMatchObject({ status: "ok", tasks: 2 });
  });

  it("the project list summarizes each readable plan (UI-14)", async () => {
    const later = "2026-11-05T09:30:00Z";
    const doc = plan();
    doc.seq.BE = 5;
    doc.tasks[0] = {
      ...(doc.tasks[0] as TasksDocument["tasks"][number]),
      notes: [{ id: "n1", at, by: "agent:claude", kind: "question", text: "¿A o B?" }],
    };
    const base = doc.tasks[1] as TasksDocument["tasks"][number];
    doc.tasks.push(
      { ...base, id: "BE-03", title: "Third", deps: [], rank: "c" },
      {
        ...base,
        id: "BE-04",
        title: "Fourth",
        state: "done",
        deps: [],
        rank: "d",
        notes: [{ id: "n1", at: later, by: "agent:claude", kind: "summary", text: "Hecho" }],
      },
      { ...base, id: "BE-05", title: "Fifth", state: "proposed", deps: [], rank: "e" },
    );
    mkdirSync(join(projectDir, ".konsora"));
    writeFileSync(join(projectDir, ".konsora", "tasks.json"), serializeDocument(doc));
    await link();
    const missing = mkdtempSync(join(tmpdir(), "konsora-proj-"));
    try {
      await link(missing);
      const list = (await (await call("/api/projects")).json()) as {
        projects: { path: string; plan: Record<string, unknown> }[];
      };
      const [summary, absent] = list.projects;
      expect(summary?.plan).toEqual({
        status: "ok",
        hash: expect.stringMatching(/^sha256:/),
        tasks: 5,
        byState: { proposed: 1, todo: 2, doing: 1, done: 1 },
        ready: 1,
        waiting: 1,
        lastDone: later,
      });
      // A folder without a plan keeps its notice, with no summary.
      expect(absent?.plan).toEqual({ status: "missing", message: expect.any(String) });
    } finally {
      rmSync(missing, { recursive: true, force: true });
    }
  });

  it("board shows an invalid plan with its issues, read-only", async () => {
    mkdirSync(join(projectDir, ".konsora"));
    writeFileSync(join(projectDir, ".konsora", "tasks.json"), '{"schema":"konsora/2"}');
    const { body } = await link();
    const board = (await (await call(`/api/projects/${body.project.id}/board`)).json()) as {
      status: string;
      issues: unknown[];
    };
    expect(board.status).toBe("invalid");
    expect(board.issues.length).toBeGreaterThan(0);
    expect(readFileSync(join(projectDir, ".konsora", "tasks.json"), "utf8")).toBe(
      '{"schema":"konsora/2"}',
    );
  });

  it("task endpoint returns one task with dependents; unknown ids are 404", async () => {
    mkdirSync(join(projectDir, ".konsora"));
    writeFileSync(join(projectDir, ".konsora", "tasks.json"), serializeDocument(plan()));
    const { body } = await link();
    const res = await call(`/api/projects/${body.project.id}/tasks/be-01`);
    expect(await res.json()).toMatchObject({
      task: { id: "BE-01", state: "doing" },
      dependents: ["BE-02"],
    });
    expect((await call(`/api/projects/${body.project.id}/tasks/BE-09`)).status).toBe(404);
    expect((await call("/api/projects/p-000000000000/board")).status).toBe(404);
    const unknown = await call("/api/nope");
    expect(unknown.status).toBe(404);
    // An unknown API route says so: usually a daemon older than the web UI it serves.
    expect(await unknown.json()).toEqual({
      error: { code: "unknown_endpoint", message: "Unknown endpoint" },
    });
  });
});

describe("pending questions across projects (UI-13)", () => {
  const note = (n: number, kind: "question" | "answer", text: string, options?: string[]) => ({
    id: `n${n}`,
    at,
    by: kind === "question" ? "agent:claude" : "human",
    kind,
    text,
    ...(options ? { options } : {}),
  });

  it("lists the waiting tasks of every readable project with their open question", async () => {
    const waiting = plan();
    waiting.tasks[0] = {
      ...(waiting.tasks[0] as TasksDocument["tasks"][number]),
      notes: [
        note(1, "question", "¿Primero?"),
        note(2, "answer", "Sí"),
        note(3, "question", "¿A o B?", ["A", "B"]),
      ],
    };
    mkdirSync(join(projectDir, ".konsora"));
    writeFileSync(join(projectDir, ".konsora", "tasks.json"), serializeDocument(waiting));
    const { body } = await link();
    // A project without questions and one with an unreadable plan are left out.
    const quiet = mkdtempSync(join(tmpdir(), "konsora-proj-"));
    const broken = mkdtempSync(join(tmpdir(), "konsora-proj-"));
    try {
      mkdirSync(join(quiet, ".konsora"));
      writeFileSync(join(quiet, ".konsora", "tasks.json"), serializeDocument(plan()));
      mkdirSync(join(broken, ".konsora"));
      writeFileSync(join(broken, ".konsora", "tasks.json"), "{");
      await link(quiet);
      await link(broken);
      const res = await call("/api/questions");
      expect(res.status).toBe(200);
      const list = (await res.json()) as {
        total: number;
        projects: {
          project: { id: string; name: string };
          questions: { task: { id: string; hash: string; waiting: boolean }; question: unknown }[];
        }[];
      };
      expect(list.total).toBe(1);
      expect(list.projects).toHaveLength(1);
      expect(list.projects[0]?.project).toEqual({
        id: body.project.id,
        name: expect.any(String),
      });
      expect(list.projects[0]?.questions).toEqual([
        {
          task: expect.objectContaining({ id: "BE-01", waiting: true, hash: expect.any(String) }),
          question: note(3, "question", "¿A o B?", ["A", "B"]),
        },
      ]);
      // Once answered, it is no longer pending.
      const task = list.projects[0]?.questions[0]?.task as { id: string; hash: string };
      const answered = await call(`/api/projects/${body.project.id}/ops`, {
        method: "POST",
        body: { op: "answer", task: task.id, text: "A", expect: { [task.id]: task.hash } },
      });
      expect(answered.status).toBe(200);
      expect(await (await call("/api/questions")).json()).toEqual({ projects: [], total: 0 });
    } finally {
      rmSync(quiet, { recursive: true, force: true });
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

describe("startDaemon (real server)", () => {
  it("listens on 127.0.0.1, records daemon.json privately, and refuses a second instance", async () => {
    const daemon = await startDaemon({ dataDir: data });
    try {
      expect(daemon.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const file = join(data, "daemon.json");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
        url: daemon.url,
        token: daemon.token,
        pid: process.pid,
      });
      expect(daemon.token).toMatch(/^[0-9a-f]{64}$/);

      const health = await fetch(`${daemon.url}/api/health`, {
        headers: { authorization: `Bearer ${daemon.token}` },
      });
      expect([health.status, await health.json()]).toEqual([
        200,
        { ok: true, service: "konsora-daemon", version: "0.0.0" },
      ]);
      expect((await fetch(`${daemon.url}/api/health`)).status).toBe(403);
      expect(
        (
          await fetch(`${daemon.url.replace("127.0.0.1", "localhost")}/api/health`, {
            headers: { authorization: `Bearer ${daemon.token}` },
          })
        ).status,
      ).toBe(200);

      expect(await findDaemon(data)).toMatchObject({ url: daemon.url });
      await expect(startDaemon({ dataDir: data })).rejects.toThrow(/already running/);
    } finally {
      await daemon.close();
    }
    expect(readdirSync(data)).not.toContain("daemon.json");
    expect(await findDaemon(data)).toBeUndefined();
  });

  it("comes back on the same port, so the browser keeps the UI's preferences; else any free one", async () => {
    const first = await startDaemon({ dataDir: data });
    await first.close();
    const second = await startDaemon({ dataDir: data });
    try {
      expect(second.url).toBe(first.url);
    } finally {
      await second.close();
    }
    // Something else took the port meanwhile: the daemon starts anyway, elsewhere.
    const port = Number(new URL(first.url).port);
    const squatter = createServer().listen(port, "127.0.0.1");
    await new Promise((resolve) => squatter.once("listening", resolve));
    try {
      const third = await startDaemon({ dataDir: data });
      expect(third.url).not.toBe(first.url);
      await third.close();
    } finally {
      squatter.close();
    }
  });
});

describe("undo of a human action (UI-21)", () => {
  type OpReply = { ok?: boolean; undo?: unknown[]; error?: { code: string; message: string } };
  const op = async (id: string, body: unknown) => {
    const res = await call(`/api/projects/${id}/ops`, { method: "POST", body });
    return { status: res.status, body: (await res.json()) as OpReply };
  };
  const file = () => readFileSync(join(projectDir, ".konsora", "tasks.json"), "utf8");

  it("a deleted task comes back with its id, notes and the deps others had on it", async () => {
    mkdirSync(join(projectDir, ".konsora"));
    const withNote = plan();
    const first = withNote.tasks[0];
    if (first) first.notes = [{ id: "n1", at, by: "agent:claude", kind: "note", text: "A medias" }];
    writeFileSync(join(projectDir, ".konsora", "tasks.json"), serializeDocument(withNote));
    const before = file();
    const { body } = await link();
    const deleted = await op(body.project.id, { op: "delete", task: "BE-01" });
    expect(deleted.status).toBe(200);
    const after = JSON.parse(file()) as TasksDocument;
    expect(after.tasks.map((t) => t.id)).toEqual(["BE-02"]);
    // The deletion is recorded (CORE-17), and undoing it forgets it again.
    expect(after.deleted).toEqual([{ id: "BE-01", title: "First", at, by: "human" }]);
    expect(deleted.body.undo).toHaveLength(2);
    const undone = await op(body.project.id, { op: "undo", changes: deleted.body.undo });
    expect(undone.status).toBe(200);
    expect(undone.body.undo).toBeUndefined();
    expect(file()).toBe(before);
    // The restored state is the daemon's own write: no external change is flagged.
    const board = (await (await call(`/api/projects/${body.project.id}/board`)).json()) as {
      external: unknown[];
    };
    expect(board.external).toEqual([]);
  });

  it("refuses with a conflict, writing nothing, if the task changed in between", async () => {
    mkdirSync(join(projectDir, ".konsora"));
    writeFileSync(join(projectDir, ".konsora", "tasks.json"), serializeDocument(plan()));
    const { body } = await link();
    const deleted = await op(body.project.id, { op: "delete", task: "BE-01" });
    await op(body.project.id, { op: "note", task: "BE-02", text: "Después" });
    const after = file();
    const undone = await op(body.project.id, { op: "undo", changes: deleted.body.undo });
    expect(undone.status).toBe(409);
    expect(undone.body.error?.code).toBe("conflict");
    expect(file()).toBe(after);
  });
});
