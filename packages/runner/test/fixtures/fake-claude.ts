/**
 * A stand-in for `claude` in tests. FAKE_CLAUDE_MODE picks the behaviour; FAKE_CLAUDE_DUMP is a
 * file where it records its argv, environment and the MCP config it was given.
 */
import { spawn } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_CLAUDE_MODE ?? "replay";
const args = process.argv.slice(2);

if (args[0] === "--version") {
  process.stdout.write("2.1.316 (Claude Code)\n");
  process.exit(0);
}

const dump = process.env.FAKE_CLAUDE_DUMP;
if (dump) {
  const configPath = args[args.indexOf("--mcp-config") + 1] as string;
  writeFileSync(
    dump,
    JSON.stringify({
      args,
      env: process.env,
      cwd: process.cwd(),
      config: JSON.parse(readFileSync(configPath, "utf8")),
      configMode: statSync(configPath).mode & 0o777,
    }),
  );
}

const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const result = (text: string) =>
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: "s-fake",
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 2 },
  });

if (mode === "stubborn") process.on("SIGTERM", () => undefined);
if (mode === "ignore-int") {
  // Ignores SIGINT and leaves a grandchild in its process group; only a group kill ends both.
  process.on("SIGINT", () => undefined);
  setInterval(() => undefined, 1000);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(
    process.env.FAKE_CLAUDE_PIDS as string,
    JSON.stringify({ self: process.pid, child: child.pid }),
  );
}

const input = createInterface({ input: process.stdin });
const messages: string[] = [];
input.on("line", (line) => {
  const text = JSON.parse(line).message.content[0].text as string;
  messages.push(text);
  if (mode === "replay") {
    const fixture = process.env.FAKE_CLAUDE_FIXTURE as string;
    process.stdout.write(readFileSync(fixture, "utf8"));
    process.exit(0);
  } else if (mode === "echo") {
    out({ type: "system", subtype: "init", session_id: "s-fake", model: "fake" });
    out({ type: "assistant", message: { content: [{ type: "text", text: `got: ${text}` }] } });
    result(`turn ${messages.length}`);
  } else if (mode === "garbage") {
    process.stdout.write("this is not json\n");
    out({ type: "system", subtype: "init", session_id: "s-fake", model: "fake" });
    result("done");
    process.exit(0);
  } else if (mode === "die") {
    out({ type: "system", subtype: "init", session_id: "s-fake", model: "fake" });
    process.stderr.write("fatal: something broke\n");
    process.kill(process.pid, "SIGKILL");
  } else if (mode === "ignore-int") {
    out({ type: "system", subtype: "init", session_id: "s-int", model: "fake" });
  } else if (mode === "crash") {
    process.stderr.write("Error: bad things\n");
    process.exit(3);
  }
  // "hang" and "stubborn": never answer; "stubborn" also ignores SIGTERM.
});
input.on("close", () => {
  if (mode === "echo") process.exit(0);
  // "ignore-int" keeps running without input, like an agent stuck in a tool.
});
