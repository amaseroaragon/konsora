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
    schema: "konsora/2",
    project: { name: "Weather", base_branch: "main" },
    groups: [{ id: "BE", name: "Backend" }],
    seq: { BE: 2 },
    tasks: [
      {
        id: "BE-01",
        title: "First",
        state: "review",
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
    expect(board.tasks[1]).toMatchObject({
      blocked: true,
      blockers: ["BE-01"],
      hash: expect.stringMatching(/^sha256:/),
    });
    const list = (await (await call("/api/projects")).json()) as { projects: { plan: object }[] };
    expect(list.projects[0]?.plan).toMatchObject({ status: "ok", tasks: 2 });
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
      task: { id: "BE-01", state: "review" },
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
        { ok: true, service: "konsora-daemon", version: "0.0.0", live_runs: 0 },
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
});
