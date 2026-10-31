/**
 * The web UI as static files (UI-01). The page itself is not secret, so it needs no token (the
 * token arrives in the URL fragment, which browsers never send), but the Host check still applies
 * against DNS rebinding, and a strict CSP keeps the page to its own scripts and this daemon.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { type AuthConfig, allowedHosts } from "./auth.ts";

export const WEB_MISSING =
  "The Konsora web UI is not built. Run `npm run build -w @konsora/web`, or start it with `konsora ui`.";

export function contentSecurityPolicy(port: number): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    // React sets style attributes; no inline <style> or scripts are needed beyond that.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

export function site(options: AuthConfig & { webDir?: string }): Hono {
  const app = new Hono();
  const hosts = allowedHosts(options.port);
  app.use("*", async (c, next) => {
    const host = c.req.header("host")?.toLowerCase();
    if (!host || !hosts.has(host)) return c.text("Forbidden: unexpected Host header", 403);
    await next();
    c.header("Content-Security-Policy", contentSecurityPolicy(options.port));
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    // The shell must always be fresh (it names the hashed bundles); bundles are immutable.
    const path = c.req.path;
    c.header(
      "Cache-Control",
      path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    );
  });
  const webDir = options.webDir;
  if (webDir && existsSync(join(webDir, "index.html"))) {
    app.get("*", serveStatic({ root: webDir }));
  } else {
    app.get("/", (c) => c.text(WEB_MISSING, 503));
  }
  return app;
}
