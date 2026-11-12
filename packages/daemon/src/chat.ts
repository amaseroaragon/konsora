/**
 * The AI panel's planning chats (one per project, in memory). Each message of the human runs
 * one turn of the user's own Claude Code in headless mode (`claude -p`, stream-json), with the
 * interview prompt from core on the first turn and `--resume` on the next ones. The agent gets
 * only Konsora's MCP server, in plan mode (KONSORA_PLAN=1): it reads the plan and can only
 * propose tasks or revise its proposals, which reach the board like any other change.
 *
 * Konsora uses the official CLI with the user's login, never an API key, and never passes a
 * permission-bypassing flag: tools outside the allowed list are simply refused in `-p` mode.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { buildPlanPrompt, PLAN_TOOLS } from "@konsora/core";
import { readTasks } from "@konsora/core/store";
import { mcpCommand } from "./paths.ts";
import type { Project } from "./registry.ts";

/** `stopped`: the human stopped the answer (its text is for logs; the UI shows its own). */
export type ChatRole = "human" | "agent" | "tool" | "error" | "stopped";

export type ChatMessage = { id: number; role: ChatRole; text: string; at: string };

export type ChatView = { messages: ChatMessage[]; busy: boolean };

export class ChatError extends Error {
  readonly code: "not_found" | "busy" | "invalid_plan" | "unavailable";
  constructor(code: ChatError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export type ChatManagerOptions = {
  /** Sends a payload to the project's WebSocket subscribers. */
  publish: (project: string, payload: unknown) => void;
  /** The Claude Code binary (tests pass a fake); default `claude` on PATH. */
  command?: string;
  /** How the agent launches Konsora's MCP server; default this checkout's CLI. */
  mcp?: { command: string; args: string[] };
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

type Chat = {
  messages: ChatMessage[];
  session?: string;
  child?: ChildProcess | undefined;
  next: number;
};

/** Longest text kept from one message, so a runaway answer cannot grow without bound. */
const MAX_TEXT = 32_768;
const MAX_MESSAGES = 500;

/** A short, readable line for a tool call: `propose "Add cache"`, `show CORE-01`… */
function toolLine(name: string, input: unknown): string {
  const tool = name.replace(/^mcp__konsora__/, "");
  const args = (input ?? {}) as Record<string, unknown>;
  if (typeof args.title === "string") return `${tool} "${args.title}"`;
  if (typeof args.id === "string") return `${tool} ${args.id}`;
  if (Array.isArray(args.tasks)) return `${tool} (${args.tasks.length} tasks)`;
  return tool;
}

export class ChatManager {
  readonly #chats = new Map<string, Chat>();
  /** Processes the human stopped, so their exit reads as stopped, not as a failure. */
  readonly #stopped = new WeakSet<ChildProcess>();
  readonly #options: ChatManagerOptions;

  constructor(options: ChatManagerOptions) {
    this.#options = options;
  }

  #chat(project: string): Chat {
    let chat = this.#chats.get(project);
    if (!chat) {
      chat = { messages: [], next: 1 };
      this.#chats.set(project, chat);
    }
    return chat;
  }

  #now(): string {
    return (this.#options.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  view(project: string): ChatView {
    const chat = this.#chats.get(project);
    return { messages: [...(chat?.messages ?? [])], busy: Boolean(chat?.child) };
  }

  #publish(project: string) {
    this.#options.publish(project, { type: "chat.updated", project, chat: this.view(project) });
  }

  #add(project: string, role: ChatRole, text: string) {
    const body = text.trim();
    if (!body) return;
    const chat = this.#chat(project);
    chat.messages.push({ id: chat.next++, role, text: body.slice(0, MAX_TEXT), at: this.#now() });
    if (chat.messages.length > MAX_MESSAGES)
      chat.messages.splice(0, chat.messages.length - MAX_MESSAGES);
  }

  /** Runs one turn with the human's `text`; the answer arrives through `publish`. */
  async send(project: Project, text: string): Promise<ChatView> {
    const chat = this.#chat(project.id);
    if (chat.child) throw new ChatError("busy", "The agent is still answering; wait or stop it");
    let prompt = text;
    if (!chat.session) {
      const plan = await readTasks(project.path);
      if (!plan.ok)
        throw new ChatError("invalid_plan", `The plan cannot be read: ${plan.error.message}`);
      prompt = buildPlanPrompt(plan.document, { goal: text });
    }
    this.#add(project.id, "human", text);

    const mcp = this.#options.mcp ?? mcpCommand();
    const server = {
      type: "stdio",
      command: mcp.command,
      args: [...mcp.args, "--root", project.path],
      env: { KONSORA_AGENT: "claude", KONSORA_PLAN: "1" },
    };
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      // Only this server: a konsora server of the user's own config would not be in plan mode.
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: { konsora: server } }),
      `--allowedTools=${PLAN_TOOLS.join(",")}`,
      ...(chat.session ? ["--resume", chat.session] : []),
    ];
    const child = spawn(this.#options.command ?? "claude", args, {
      cwd: project.path,
      env: this.#options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    chat.child = child;
    this.#publish(project.id);

    let stderr = "";
    let failed = false;
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    lines.on("line", (line) => {
      if (chat.child !== child) return; // reset meanwhile
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof event.session_id === "string") chat.session = event.session_id;
      if (event.type === "assistant") {
        const content = (event.message as { content?: unknown } | undefined)?.content;
        for (const block of Array.isArray(content) ? content : []) {
          const item = block as { type?: string; text?: string; name?: string; input?: unknown };
          if (item.type === "text" && item.text) this.#add(project.id, "agent", item.text);
          if (item.type === "tool_use" && item.name)
            this.#add(project.id, "tool", toolLine(item.name, item.input));
        }
        this.#publish(project.id);
      } else if (event.type === "result" && event.is_error === true) {
        failed = true;
        const result = typeof event.result === "string" ? event.result : "The agent failed";
        this.#add(project.id, "error", result);
        this.#publish(project.id);
      }
    });

    const finish = (message?: string, role: ChatRole = "error") => {
      if (chat.child !== child) return;
      chat.child = undefined;
      if (message && (!failed || role === "stopped")) this.#add(project.id, role, message);
      this.#publish(project.id);
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(
        error.code === "ENOENT"
          ? "Claude Code is not installed or not on PATH. Install it and log in with `claude`."
          : `Could not start Claude Code: ${error.message}`,
      );
    });
    child.once("close", (code, signal) => {
      lines.close();
      // Claude Code traps SIGTERM and exits with 143, so a stop is not always a signal.
      if (signal || this.#stopped.has(child)) finish("Stopped.", "stopped");
      else if (code !== 0)
        finish(
          `Claude Code exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`,
        );
      else finish();
    });
    return this.view(project.id);
  }

  /** Stops the answer in progress, if any; the conversation is kept. */
  stop(project: string): ChatView {
    const child = this.#chats.get(project)?.child;
    if (child) {
      this.#stopped.add(child);
      child.kill("SIGTERM");
    }
    return this.view(project);
  }

  /** Stops the agent and forgets the conversation. */
  reset(project: string) {
    const chat = this.#chats.get(project);
    if (chat?.child) {
      const child = chat.child;
      chat.child = undefined;
      child.kill("SIGTERM");
    }
    this.#chats.delete(project);
    this.#publish(project);
  }

  close() {
    for (const chat of this.#chats.values()) chat.child?.kill("SIGTERM");
    this.#chats.clear();
  }
}
