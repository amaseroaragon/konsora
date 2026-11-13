/**
 * The AI panel's planning chats (one per project). With `storeDir` (the daemon's data dir, never
 * a project) each chat is also kept in `projects/<id>/chat.json` (0600), so a restart of the
 * daemon neither loses the conversation nor its Claude Code session (DMN-05). Each message of the human runs
 * one turn of the user's own Claude Code in headless mode (`claude -p`, stream-json), with the
 * interview prompt from core on the first turn and `--resume` on the next ones. The agent gets
 * only Konsora's MCP server, in plan mode (KONSORA_PLAN=1): it reads the plan and can only create,
 * revise or delete tasks nobody started, which reach the board like any other change. Of Claude
 * Code's own tools it only has those that read the code (PLAN_BUILTIN_TOOLS).
 *
 * Konsora uses the official CLI with the user's login, never an API key, and never passes a
 * permission-bypassing flag. It pins `--permission-mode default` and also denies the tools that
 * write (PLAN_DENIED_TOOLS), so neither the user's default mode nor the project's allow rules let
 * the panel change files.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { buildPlanPrompt, PLAN_BUILTIN_TOOLS, PLAN_DENIED_TOOLS, PLAN_TOOLS } from "@konsora/core";
import { readTasks } from "@konsora/core/store";
import { readJson, writePrivateFile } from "./files.ts";
import { mcpCommand } from "./paths.ts";
import type { Project } from "./registry.ts";

/** `stopped`: the human stopped the answer (its text is for logs; the UI shows its own). */
export type ChatRole = "human" | "agent" | "tool" | "error" | "stopped";

export type ChatMessage = { id: number; role: ChatRole; text: string; at: string };

export type ChatView = { messages: ChatMessage[]; busy: boolean };

export class ChatError extends Error {
  readonly code: "not_found" | "busy" | "invalid_plan" | "unavailable" | "bad_request";
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
  /** Where chats are kept between restarts (the daemon's data dir); without it, memory only. */
  storeDir?: string;
};

/** What `chat.json` holds: the conversation, the session to resume and whether a turn ran. */
type StoredChat = { session?: string; next: number; messages: ChatMessage[]; busy?: boolean };

const ROLES: readonly ChatRole[] = ["human", "agent", "tool", "error", "stopped"];

function isStoredChat(value: unknown): value is StoredChat {
  const chat = value as StoredChat | undefined;
  return (
    typeof chat === "object" &&
    chat !== null &&
    Number.isInteger(chat.next) &&
    (chat.session === undefined || typeof chat.session === "string") &&
    Array.isArray(chat.messages) &&
    chat.messages.every(
      (m) =>
        Number.isInteger(m?.id) &&
        ROLES.includes(m.role) &&
        typeof m.text === "string" &&
        typeof m.at === "string",
    )
  );
}

type Chat = {
  messages: ChatMessage[];
  session?: string;
  child?: ChildProcess | undefined;
  next: number;
};

/**
 * A model for `claude --model` (DMN-06): an alias such as `sonnet` or a full id such as
 * `claude-sonnet-4-5`. Never starts with a dash, so it cannot pass for another flag.
 */
export const CHAT_MODEL = /^[a-z][a-z0-9.[\]-]{0,63}$/i;

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
  /** Per project: the save in progress, and whether another one is due after it. */
  readonly #saves = new Map<string, { running: Promise<void>; again: boolean }>();
  /** Closing: what is on disk stays as it is (a turn cut short is marked when loaded again). */
  #closed = false;
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
    this.#save(project);
  }

  #file(project: string): string | undefined {
    const dir = this.#options.storeDir;
    // Project ids come from the registry; never let one reach outside the data dir.
    if (!dir || !/^[A-Za-z0-9_-]+$/.test(project)) return undefined;
    return join(dir, "projects", project, "chat.json");
  }

  /**
   * Loads the project's saved chat, once, before it is shown or continued. A turn that was
   * running when the daemon stopped is over: it is marked as stopped.
   */
  async load(project: string): Promise<void> {
    const file = this.#file(project);
    if (!file || this.#chats.has(project)) return;
    await this.#saves.get(project)?.running;
    const stored = await readJson<unknown>(file).catch(() => undefined);
    if (this.#chats.has(project) || !isStoredChat(stored)) return;
    const chat: Chat = {
      messages: stored.messages.slice(-MAX_MESSAGES),
      next: stored.next,
      ...(stored.session ? { session: stored.session } : {}),
    };
    this.#chats.set(project, chat);
    if (stored.busy) {
      this.#add(project, "stopped", "Interrupted when the Konsora daemon stopped.");
      this.#save(project);
    }
  }

  /** Writes the chat as it is now; saves never overlap and the last state always lands. */
  #save(project: string) {
    const file = this.#file(project);
    if (!file || this.#closed) return;
    const pending = this.#saves.get(project);
    if (pending) {
      pending.again = true;
      return;
    }
    const entry = { running: Promise.resolve(), again: false };
    const run = async () => {
      do {
        entry.again = false;
        const chat = this.#chats.get(project);
        if (!chat) await unlink(file).catch(() => undefined);
        else {
          const stored: StoredChat = {
            ...(chat.session ? { session: chat.session } : {}),
            next: chat.next,
            messages: chat.messages,
            ...(chat.child ? { busy: true } : {}),
          };
          await writePrivateFile(file, JSON.stringify(stored)).catch(() => undefined);
        }
      } while (entry.again);
      this.#saves.delete(project);
    };
    entry.running = run();
    this.#saves.set(project, entry);
  }

  /** Waits for the pending saves (tests, shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.#saves.values()].map((entry) => entry.running));
  }

  #add(project: string, role: ChatRole, text: string) {
    const body = text.trim();
    if (!body) return;
    const chat = this.#chat(project);
    chat.messages.push({ id: chat.next++, role, text: body.slice(0, MAX_TEXT), at: this.#now() });
    if (chat.messages.length > MAX_MESSAGES)
      chat.messages.splice(0, chat.messages.length - MAX_MESSAGES);
  }

  /**
   * Runs one turn with the human's `text`, with `model` when given (else Claude Code's default);
   * the answer arrives through `publish`.
   */
  async send(project: Project, text: string, options: { model?: string } = {}): Promise<ChatView> {
    if (options.model !== undefined && !CHAT_MODEL.test(options.model))
      throw new ChatError("bad_request", `Invalid model "${options.model}"`);
    await this.load(project.id);
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
      // Reading the code is fine; writing is not, whatever the user's default mode or allow rules.
      `--tools=${PLAN_BUILTIN_TOOLS.join(",")}`,
      `--disallowedTools=${PLAN_DENIED_TOOLS.join(",")}`,
      "--permission-mode",
      "default",
      ...(options.model ? ["--model", options.model] : []),
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
      if (typeof event.session_id === "string" && chat.session !== event.session_id) {
        chat.session = event.session_id;
        this.#save(project.id);
      }
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

  /** Stops the agent and forgets the conversation, on disk too. */
  async reset(project: string): Promise<void> {
    const chat = this.#chats.get(project);
    if (chat?.child) {
      const child = chat.child;
      chat.child = undefined;
      child.kill("SIGTERM");
    }
    this.#chats.delete(project);
    this.#publish(project);
    await this.#saves.get(project)?.running;
    const file = this.#file(project);
    if (file) await unlink(file).catch(() => undefined);
  }

  close() {
    this.#closed = true;
    for (const chat of this.#chats.values()) chat.child?.kill("SIGTERM");
    this.#chats.clear();
  }
}
