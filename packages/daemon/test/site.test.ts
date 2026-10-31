import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { Registry } from "../src/registry.ts";
import { WEB_MISSING } from "../src/site.ts";

const token = "a".repeat(64);
const port = 4871;
let data: string;
let web: string;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "konsora-data-"));
  web = mkdtempSync(join(tmpdir(), "konsora-web-"));
  mkdirSync(join(web, "assets"));
  writeFileSync(join(web, "index.html"), "<!doctype html><title>Konsora</title>");
  writeFileSync(join(web, "assets", "index-abc.js"), "console.log(1)");
});
afterEach(() => {
  rmSync(data, { recursive: true, force: true });
  rmSync(web, { recursive: true, force: true });
});

const app = (webDir?: string) =>
  createApp({ token, port, registry: new Registry(data), ...(webDir ? { webDir } : {}) });
const get = (a: ReturnType<typeof createApp>, path: string, host = `127.0.0.1:${port}`) =>
  a.request(`http://127.0.0.1:${port}${path}`, { headers: { host } });

describe("web UI static files", () => {
  it("serves the shell without a token, with a strict CSP and no caching", async () => {
    const res = await get(app(web), "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Konsora</title>");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain(`connect-src 'self' ws://127.0.0.1:${port}`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("serves hashed bundles as immutable", async () => {
    const res = await get(app(web), "/assets/index-abc.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("checks Host against DNS rebinding", async () => {
    expect((await get(app(web), "/", "evil.example:80")).status).toBe(403);
    expect((await get(app(web), "/", `localhost:${port}`)).status).toBe(200);
  });

  it("does not escape the web folder", async () => {
    const res = await get(app(web), "/../../etc/passwd");
    expect(res.status).toBe(404);
    expect((await get(app(web), "/%2e%2e/%2e%2e/etc/passwd")).status).toBe(404);
  });

  it("keeps the API behind the token", async () => {
    expect((await get(app(web), "/api/projects")).status).toBe(403);
  });

  it("explains how to build the UI when it is missing", async () => {
    const res = await get(app(join(web, "nope")), "/");
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(WEB_MISSING);
    expect((await get(app(), "/")).status).toBe(503);
  });
});
