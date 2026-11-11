import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDaemon } from "@konsora/daemon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, main } from "../src/main.ts";
import { bundleIsStale } from "../src/ui.ts";

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
