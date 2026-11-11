import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeDocument, type Task, type TasksDocument } from "@konsora/core";
import { readTasks } from "@konsora/core/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { currentBranch, localBranches } from "../src/git.ts";
import { Registry } from "../src/registry.ts";

const token = "c".repeat(64);
const port = 4872;
const at = "2026-11-11T10:00:00Z";

let dir: string;
let repo: string;
let app: ReturnType<typeof createApp>;
let project: string;

const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  }).trim();

const task = (id: string, state: Task["state"], extra: Partial<Task> = {}): Task => ({
  id,
  title: `Title ${id}`,
  state,
  group: "BE",
  rank: id.slice(-1),
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});

function plan(states: Task["state"][]): TasksDocument {
  return {
    schema: "konsora/4",
    project: { name: "Repo" },
    groups: [{ id: "BE", name: "Backend" }],
    seq: { BE: states.length },
    blocks: [
      {
        id: "cache",
        name: "Forecast cache",
        branch: "konsora/cache",
        base: "main",
        created: { at, by: "agent:claude" },
      },
    ],
    tasks: states.map((state, i) =>
      task(`BE-0${i + 1}`, state, { block: "cache", ...(i ? { deps: [`BE-0${i}`] } : {}) }),
    ),
  };
}

function writePlan(doc: TasksDocument) {
  writeFileSync(join(repo, ".konsora", "tasks.json"), serializeDocument(doc));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "konsora-merge-"));
  repo = join(dir, "repo");
  mkdirSync(join(repo, ".konsora"), { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  // The plan is not part of these fixtures' history.
  appendFileSync(join(repo, ".git", "info", "exclude"), ".konsora/\n");
  writeFileSync(join(repo, "app.txt"), "one\n");
  git("add", "app.txt");
  git("commit", "-q", "-m", "init");
  git("switch", "-q", "-c", "konsora/cache");
  writeFileSync(join(repo, "cache.txt"), "cache\n");
  git("add", "cache.txt");
  git("commit", "-q", "-m", "BE-01");
  appendFileSync(join(repo, "cache.txt"), "ttl\n");
  git("commit", "-q", "-am", "BE-02");
  writePlan(plan(["done", "done"]));
  const registry = new Registry(join(dir, "data"));
  app = createApp({ token, port, registry, now: () => new Date(at) });
  project = (await registry.add(repo, undefined, at)).id;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const headers = {
  host: `127.0.0.1:${port}`,
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};
async function merge(strategy?: "squash" | "merge") {
  const response = await app.request(
    `http://127.0.0.1:${port}/api/projects/${project}/blocks/cache/merge`,
    { method: "POST", headers, body: JSON.stringify(strategy ? { strategy } : {}) },
  );
  // biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary JSON bodies.
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

describe("merging a block (M12)", () => {
  it("squashes the branch into main without touching the worktree when main is not checked out", async () => {
    const main = git("rev-parse", "main");
    const r = await merge();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const commit = git("rev-parse", "main");
    expect(r.body.commit).toBe(commit);
    expect(git("rev-list", "--parents", "-n", "1", "main").split(" ")).toEqual([commit, main]);
    expect(git("show", "main:cache.txt")).toBe("cache\nttl");
    expect(git("log", "-1", "--format=%B", "main")).toBe(
      "Forecast cache\n\nTasks:\n- BE-01 Title BE-01\n- BE-02 Title BE-02\n\nKonsora-Block: cache",
    );
    expect(await currentBranch(repo)).toBe("konsora/cache");
    const after = await readTasks(repo);
    expect(after.ok && after.document.blocks?.[0]?.merged).toEqual({
      at,
      by: "human",
      commit,
      strategy: "squash",
    });
    expect((await merge()).body.error.code).toBe("block_merged");
  });

  it("fast-forwards a checked-out main with a merge commit when asked", async () => {
    git("switch", "-q", "main");
    const r = await merge("merge");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(git("rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(readFileSync(join(repo, "cache.txt"), "utf8")).toBe("cache\nttl\n");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("refuses an unfinished block, a conflict and local changes, changing nothing", async () => {
    const main = git("rev-parse", "main");
    writePlan(plan(["done", "doing"]));
    expect((await merge()).body.error.code).toBe("block_not_ready");
    writePlan(plan(["done", "done"]));

    git("switch", "-q", "main");
    writeFileSync(join(repo, "cache.txt"), "other\n");
    git("add", "cache.txt");
    git("commit", "-q", "-m", "clash");
    const clashed = git("rev-parse", "main");
    const conflict = await merge();
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({ code: "git_conflict", files: ["cache.txt"] });
    expect(git("rev-parse", "main")).toBe(clashed);
    git("reset", "-q", "--hard", main);

    writeFileSync(join(repo, "cache.txt"), "uncommitted\n");
    const dirty = await merge();
    expect(dirty.body.error.code).toBe("git_dirty");
    expect(git("rev-parse", "main")).toBe(main);
    expect(readFileSync(join(repo, "cache.txt"), "utf8")).toBe("uncommitted\n");
    const after = await readTasks(repo);
    expect(after.ok && after.document.blocks?.[0]?.merged).toBeUndefined();
  });

  it("reports the branch and the local branches", async () => {
    expect(await localBranches(repo)).toEqual(["konsora/cache", "main"]);
    const response = await app.request(`http://127.0.0.1:${port}/api/projects/${project}/git`, {
      headers,
    });
    expect(await response.json()).toEqual({
      branch: "konsora/cache",
      branches: ["konsora/cache", "main"],
    });
  });
});
