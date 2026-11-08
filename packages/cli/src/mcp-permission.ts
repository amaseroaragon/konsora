/**
 * The `permission` tool of `konsora mcp` in run mode (MCP-04), for Claude Code's
 * `--permission-prompt-tool mcp__konsora__permission`. Claude sends the tool it wants to use and
 * its input; the request goes to the daemon, which waits for the human, and the answer goes back
 * in Claude's format: `{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny","message":…}`.
 *
 * It never allows by default: no daemon, a rejected token, no decision in time or any other
 * failure is a deny with the reason.
 *
 * The runner passes KONSORA_DAEMON_URL (loopback only) and KONSORA_RUN_TOKEN, a token for this
 * run that can ask for permissions but never decide them.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { RunScope } from "./shared.ts";

const DEFAULT_WAIT_S = 300;
const MAX_WAIT_S = 3600;

const Reply = z.object({
  behavior: z.enum(["allow", "deny"]),
  message: z.string().optional(),
});

export type PermissionDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** Only a daemon on this machine may receive the run token. */
function loopbackUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    return url.protocol === "http:" && loopback && url.port ? url : undefined;
  } catch {
    return undefined;
  }
}

function waitSeconds(env: NodeJS.ProcessEnv): number {
  const value = Number(env.KONSORA_PERMISSION_TIMEOUT_S);
  return Number.isInteger(value) && value >= 1 ? Math.min(value, MAX_WAIT_S) : DEFAULT_WAIT_S;
}

/** Asks the daemon; resolves to Claude's decision format and never throws. */
export async function askDaemon(
  env: NodeJS.ProcessEnv,
  run: string,
  request: { tool_name: string; input: Record<string, unknown>; tool_use_id?: string | undefined },
): Promise<PermissionDecision> {
  const deny = (message: string): PermissionDecision => ({
    behavior: "deny",
    message: `Konsora denied ${request.tool_name}: ${message}`,
  });
  const base = loopbackUrl(env.KONSORA_DAEMON_URL);
  if (!base) return deny("no Konsora daemon is configured for this run (KONSORA_DAEMON_URL).");
  const token = env.KONSORA_RUN_TOKEN;
  if (!token) return deny("this run has no token for the Konsora daemon (KONSORA_RUN_TOKEN).");
  const wait = waitSeconds(env);
  let response: Response;
  try {
    response = await fetch(new URL(`/api/runs/${encodeURIComponent(run)}/permissions`, base), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...request, wait_s: wait }),
      // A little longer than the daemon's own wait, which answers deny when it runs out.
      signal: AbortSignal.timeout((wait + 10) * 1000),
    });
  } catch (error) {
    return (error as Error).name === "TimeoutError"
      ? deny("no decision arrived in time.")
      : deny("the Konsora daemon is not reachable.");
  }
  if (response.status === 403) return deny("the Konsora daemon rejected this run's token.");
  if (!response.ok) return deny(`the Konsora daemon answered ${response.status}.`);
  const reply = Reply.safeParse(await response.json().catch(() => null));
  if (!reply.success) return deny("the Konsora daemon sent an unexpected answer.");
  if (reply.data.behavior === "allow") return { behavior: "allow", updatedInput: request.input };
  return deny(reply.data.message ?? "the human said no.");
}

export function registerPermissionTool(server: McpServer, env: NodeJS.ProcessEnv, scope: RunScope) {
  server.registerTool(
    "permission",
    {
      title: "Ask the human for a permission",
      description:
        "Permission prompt for Claude Code inside a Konsora run: the human allows or denies the tool use.",
      inputSchema: {
        tool_name: z.string().min(1).describe("the tool Claude wants to use"),
        input: z.record(z.string(), z.unknown()).describe("the input of that tool use"),
        tool_use_id: z.string().optional(),
      },
      annotations: { openWorldHint: false },
    },
    async (args): Promise<CallToolResult> => {
      const decision = scope.review
        ? {
            behavior: "deny" as const,
            message: `Konsora denied ${args.tool_name}: this review run is read-only.`,
          }
        : scope.run
          ? await askDaemon(env, scope.run, args)
          : {
              behavior: "deny" as const,
              message: `Konsora denied ${args.tool_name}: this run has no id (KONSORA_RUN).`,
            };
      return { content: [{ type: "text", text: JSON.stringify(decision) }] };
    },
  );
}
