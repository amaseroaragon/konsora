import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDaemon } from "@konsora/daemon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, main } from "../src/main.ts";
import { bundleIsStale, uiUrl } from "../src/ui.ts";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "konsora-ui-"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
  let out = "";
  let err = "";
  return main(argv, {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    cwd,
    env,
  }).then((code) => ({ code, out, err }));
}

describe("bundleIsStale", () => {
  it("is stale without a build, fresh after it, stale again when a source changes", () => {
    const pkg = join(base, "web");
    mkdirSync(join(pkg, "src", "app"), { recursive: true });
    writeFileSync(join(pkg, "index.html"), "x");
    writeFileSync(join(pkg, "src", "app", "A.tsx"), "x");
    expect(bundleIsStale(pkg)).toBe(true);
    mkdirSync(join(pkg, "dist"));
    writeFileSync(join(pkg, "dist", "index.html"), "built");
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(pkg, "index.html"), past, past);
    utimesSync(join(pkg, "src", "app", "A.tsx"), past, past);
    expect(bundleIsStale(pkg)).toBe(false);
    writeFileSync(join(pkg, "src", "app", "A.tsx"), "changed");
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(pkg, "src", "app", "A.tsx"), future, future);
    expect(bundleIsStale(pkg)).toBe(true);
  });
});

describe("konsora ui", () => {
  it("starts a detached daemon, links the project, serves the page, then reuses the daemon", async () => {
    const data = join(base, "data");
    const web = join(base, "web-dist");
    const project = join(base, "proj");
    mkdirSync(web);
    mkdirSync(project);
    writeFileSync(join(web, "index.html"), "<!doctype html><title>Konsora</title>");
    const env = {
      ...process.env,
      KONSORA_DATA_DIR: data,
      KONSORA_WEB_DIR: web,
      XDG_STATE_HOME: join(base, "state"),
    };
    expect((await run(["init", "--no-claude"], project, env)).code).toBe(EXIT.ok);

    const first = await run(["ui", "--no-open"], project, env);
    const info = await findDaemon(data);
    const stale: (number | undefined)[] = [];
    try {
      expect(first.err).toBe("");
      expect(first.code).toBe(EXIT.ok);
      expect(info?.pid).not.toBe(process.pid);
      expect(first.out).toContain(`Started the Konsora daemon at ${info?.url}`);
      expect(first.out).toContain('Linked project "proj"');
      const url = /\s(http:\/\/127\.0\.0\.1:\d+\/#\S+)/.exec(first.out)?.[1] ?? "";
      const fragment = new URLSearchParams(new URL(url).hash.slice(1));
      expect(fragment.get("token")).toBe(info?.token);
      expect(fragment.get("project")).toMatch(/^p-[0-9a-f]{12}$/);

      const page = await fetch(new URL("/", url));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("<title>Konsora</title>");
      const listed = (await (
        await fetch(new URL("/api/projects", url), {
          headers: { authorization: `Bearer ${info?.token}` },
        })
      ).json()) as { projects: { id: string; plan: { status: string } }[] };
      expect(listed.projects).toEqual([
        expect.objectContaining({
          id: fragment.get("project"),
          plan: expect.objectContaining({ status: "ok" }),
        }),
      ]);

      const second = await run(["ui", "--no-open", "--no-link"], base, env);
      expect(second.code).toBe(EXIT.ok);
      expect(second.out).toContain(`Using the Konsora daemon at ${info?.url}`);
      expect(second.out).not.toContain("project=");
      expect(readFileSync(join(base, "state", "konsora", "logs", "daemon.log"), "utf8")).toContain(
        "listening on",
      );

      // A daemon that runs code older than the checkout (here: daemon.json says so) is restarted.
      const file = join(data, "daemon.json");
      writeFileSync(file, JSON.stringify({ ...info, code: 1 }), { mode: 0o600 });
      const third = await run(["ui", "--no-open", "--no-link"], base, env);
      const restarted = await findDaemon(data);
      stale.push(restarted?.pid);
      expect(third.code).toBe(EXIT.ok);
      expect(third.out).toContain("it ran code older than this checkout");
      expect(restarted?.pid).not.toBe(info?.pid);
      expect(third.out).toContain(`Started the Konsora daemon at ${restarted?.url}`);
      const health = (await (
        await fetch(`${restarted?.url}/api/health`, {
          headers: { authorization: `Bearer ${restarted?.token}` },
        })
      ).json()) as { ok: boolean };
      expect(health.ok).toBe(true);

      // A fresh daemon is reused; --restart restarts it anyway.
      expect((await run(["ui", "--no-open", "--no-link"], base, env)).out).toContain(
        `Using the Konsora daemon at ${restarted?.url}`,
      );
      const fourth = await run(["ui", "--no-open", "--no-link", "--restart"], base, env);
      const again = await findDaemon(data);
      stale.push(again?.pid);
      expect(fourth.out).toContain("Stopped the Konsora daemon.");
      expect(again?.pid).not.toBe(restarted?.pid);
    } finally {
      for (const pid of stale) {
        try {
          if (pid) process.kill(pid, "SIGTERM");
        } catch {
          // gone
        }
      }
      if (info) {
        try {
          process.kill(info.pid, "SIGTERM");
        } catch {
          // already restarted
        }
      }
      for (let i = 0; i < 50 && (await findDaemon(data)); i++)
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await findDaemon(data)).toBeUndefined();
  }, 40_000);
});

describe("konsora ui --status and --stop (DMN-07)", () => {
  it("reports a real daemon with its projects, stops it, and is fine when none runs", async () => {
    const data = join(base, "data");
    const web = join(base, "web-dist");
    const project = join(base, "proj");
    mkdirSync(web);
    mkdirSync(project);
    writeFileSync(join(web, "index.html"), "<!doctype html><title>Konsora</title>");
    const env = {
      ...process.env,
      KONSORA_DATA_DIR: data,
      KONSORA_WEB_DIR: web,
      XDG_STATE_HOME: join(base, "state"),
    };
    const none = await run(["ui", "--status"], base, env);
    expect(none.code).toBe(EXIT.ok);
    expect(none.out).toBe("The Konsora daemon is not running. Start it with `konsora ui`.\n");

    expect((await run(["init", "--no-claude"], project, env)).code).toBe(EXIT.ok);
    expect((await run(["ui", "--no-open"], project, env)).code).toBe(EXIT.ok);
    const info = await findDaemon(data);
    try {
      const status = await run(["ui", "--status"], base, env);
      expect(status.code).toBe(EXIT.ok);
      expect(status.out).toContain(
        `The Konsora daemon is running at ${info?.url} (pid ${info?.pid}, version 0.0.0`,
      );
      expect(status.out).toMatch(
        /Linked projects \(1\):\n {2}p-[0-9a-f]{12} {2}proj {2}.+\(0 tasks\)/,
      );
      expect(status.out).not.toContain(info?.token);

      const stopped = await run(["ui", "--stop"], base, env);
      expect(stopped.code).toBe(EXIT.ok);
      expect(stopped.out).toBe(`Stopped the Konsora daemon (pid ${info?.pid}).\n`);
      expect(await findDaemon(data)).toBeUndefined();
      expect(existsSync(join(data, "daemon.json"))).toBe(false);

      const again = await run(["ui", "--stop"], base, env);
      expect(again.code).toBe(EXIT.ok);
      expect(again.out).toBe("The Konsora daemon is not running.\n");
      // A leftover daemon.json of a dead process is cleaned up.
      writeFileSync(join(data, "daemon.json"), JSON.stringify({ ...info, pid: 2 ** 22 + 7 }));
      expect((await run(["ui", "--stop"], base, env)).code).toBe(EXIT.ok);
      expect(existsSync(join(data, "daemon.json"))).toBe(false);
      expect((await run(["ui", "--status", "--stop"], base, env)).code).toBe(EXIT.usage);
    } finally {
      try {
        if (info) process.kill(info.pid, "SIGTERM");
      } catch {
        // already stopped
      }
    }
  }, 30_000);
});

describe("konsora ui <id> (CLI-11)", () => {
  it("builds the URL with the project and the task after the token", () => {
    const token = "ab".repeat(32);
    expect(
      uiUrl("http://127.0.0.1:4545", token, { project: "p-0123456789ab", task: "BE-04" }),
    ).toBe(`http://127.0.0.1:4545/#token=${token}&project=p-0123456789ab&task=BE-04`);
    expect(uiUrl("http://127.0.0.1:4545", token, { task: "BE-04" })).toBe(
      `http://127.0.0.1:4545/#token=${token}`,
    );
    expect(uiUrl("http://127.0.0.1:4545", token)).toBe(`http://127.0.0.1:4545/#token=${token}`);
  });

  it("an unknown or archived id is an actionable error and starts nothing", async () => {
    const data = join(base, "data");
    const project = join(base, "proj");
    mkdirSync(project);
    const env = { ...process.env, KONSORA_DATA_DIR: data, KONSORA_WEB_DIR: join(base, "nowhere") };
    expect((await run(["init", "--no-claude"], project, env)).code).toBe(EXIT.ok);
    const unknown = await run(["ui", "TASK-99", "--no-open"], project, env);
    expect(unknown.code).toBe(EXIT.failure);
    expect(unknown.err).toContain("Error: Task TASK-99 does not exist.");
    expect(unknown.err).toContain("Hint: Use `konsora list` to see task ids.");
    expect(unknown.out).toBe("");
    expect(existsSync(data)).toBe(false);
    for (const flags of [["--status"], ["--stop"], ["--no-link"]]) {
      const r = await run(["ui", "TASK-01", ...flags], project, env);
      expect(r.code, flags.join(" ")).toBe(EXIT.usage);
    }
    const outside = await run(["ui", "TASK-01", "--no-open"], base, env);
    expect(outside.code).toBe(EXIT.failure);
    expect(outside.err).toContain("No .konsora/ folder found");
    expect(existsSync(data)).toBe(false);
  });

  it("--no-open prints the URL that opens the task's panel", async () => {
    const data = join(base, "data");
    const web = join(base, "web-dist");
    const project = join(base, "proj");
    mkdirSync(web);
    mkdirSync(project);
    writeFileSync(join(web, "index.html"), "<!doctype html><title>Konsora</title>");
    const env = {
      ...process.env,
      KONSORA_DATA_DIR: data,
      KONSORA_WEB_DIR: web,
      XDG_STATE_HOME: join(base, "state"),
    };
    expect((await run(["init", "--no-claude"], project, env)).code).toBe(EXIT.ok);
    expect(
      (await run(["propose", "Add a cache", "--group", "TASK", "--as", "claude"], project, env))
        .code,
    ).toBe(EXIT.ok);
    const r = await run(["ui", "task-01", "--no-open"], project, env);
    const info = await findDaemon(data);
    try {
      expect(r.code).toBe(EXIT.ok);
      expect(r.out).toContain("Open this URL in your browser (it opens TASK-01)");
      const url = /\s(http:\/\/127\.0\.0\.1:\d+\/#\S+)/.exec(r.out)?.[1] ?? "";
      const fragment = new URLSearchParams(new URL(url).hash.slice(1));
      expect(fragment.get("token")).toBe(info?.token);
      expect(fragment.get("project")).toMatch(/^p-[0-9a-f]{12}$/);
      expect(fragment.get("task")).toBe("TASK-01");
    } finally {
      if (info) process.kill(info.pid, "SIGTERM");
      for (let i = 0; i < 50 && (await findDaemon(data)); i++)
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 20_000);
});
