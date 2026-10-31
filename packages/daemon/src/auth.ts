/**
 * Request guard for the loopback daemon (docs/arquitectura.md §4). CORS is not authentication:
 * every API request must pass all three checks.
 * 1. Host is exactly 127.0.0.1:<port> or localhost:<port> — blocks DNS rebinding.
 * 2. Origin, when the browser sends one, is one of the allowed origins.
 * 3. Authorization: Bearer <token>, compared in constant time.
 */
import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

export type AuthConfig = { token: string; port: number; extraOrigins?: readonly string[] };

export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

export function allowedOrigins(config: AuthConfig): Set<string> {
  return new Set([
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    ...(config.extraOrigins ?? []),
  ]);
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Denial = "host" | "origin" | "token";

/** Pure check, exported for tests and for the WebSocket handshake (DMN-03). */
export function checkRequest(
  headers: {
    host?: string | null | undefined;
    origin?: string | null | undefined;
    authorization?: string | null | undefined;
  },
  config: AuthConfig,
): Denial | null {
  if (!headers.host || !allowedHosts(config.port).has(headers.host.toLowerCase())) return "host";
  if (headers.origin && !allowedOrigins(config).has(headers.origin)) return "origin";
  const match = /^Bearer ([0-9a-f]{64})$/.exec(headers.authorization ?? "");
  if (!match?.[1] || !sameToken(match[1], config.token)) return "token";
  return null;
}

const MESSAGES: Record<Denial, string> = {
  host: "Forbidden: unexpected Host header",
  origin: "Forbidden: origin not allowed",
  token: "Forbidden: missing or invalid token",
};

export function guard(config: AuthConfig): MiddlewareHandler {
  return async (c, next) => {
    const denial = checkRequest(
      {
        host: c.req.header("host"),
        origin: c.req.header("origin"),
        authorization: c.req.header("authorization"),
      },
      config,
    );
    if (denial)
      return c.json(
        { error: { code: "forbidden", reason: denial, message: MESSAGES[denial] } },
        403,
      );
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  };
}
