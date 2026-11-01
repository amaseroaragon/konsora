/**
 * A stand-in for `codex` in tests.
 *
 * - `--version` prints `codex-cli $FAKE_CODEX_VERSION` (default 0.166.0); FAKE_CODEX_FAIL makes
 *   it exit 1.
 * - `app-server` replays a recording of `fixtures/codex/` (FAKE_CODEX_FIXTURE): it waits for each
 *   message the client sent in the recording (by method, or by id for replies to the server's
 *   requests), maps the request ids, and writes what the server wrote. FAKE_CODEX_SKIP lists
 *   client methods to drop from the recording (with their replies). FAKE_CODEX_DUMP is a file
 *   where it records its argv, environment, cwd and every message it received.
 * - FAKE_CODEX_MODE: `malformed` writes a non-JSON line after the first reply; `die` exits 3 after
 *   the first reply; `reject` answers `thread/start` with an error.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.FAKE_CODEX_FAIL) process.exit(1);
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? "0.166.0"}\n`);
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.stderr.write("fake codex: unsupported arguments\n");
  process.exit(2);
}

type Json = Record<string, unknown>;
type Entry = { c?: Json; s?: Json; exit?: { code: number } };

const mode = process.env.FAKE_CODEX_MODE ?? "replay";
const skip = new Set((process.env.FAKE_CODEX_SKIP ?? "").split(",").filter(Boolean));
const received: Json[] = [];
const dump = () => {
  const file = process.env.FAKE_CODEX_DUMP;
  if (file) {
    writeFileSync(file, JSON.stringify({ args, env: process.env, cwd: process.cwd(), received }));
  }
};
dump();

// The recordings were made in /work/repo; replay them in the run's worktree.
let entries: Entry[] = readFileSync(process.env.FAKE_CODEX_FIXTURE as string, "utf8")
  .replaceAll('"/work/repo', JSON.stringify(process.cwd()).slice(0, -1))
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Entry);
// Drop skipped client requests and the server's replies to them.
const skippedIds = new Set(
  entries.filter((e) => e.c && skip.has(e.c.method as string)).map((e) => e.c?.id),
);
entries = entries.filter(
  (e) =>
    !(e.c && skip.has(e.c.method as string)) &&
    !(e.s && e.s.method === undefined && skippedIds.has(e.s.id)),
);

const inbox: Json[] = [];
let wake: (() => void) | null = null;
let ended = false;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as Json;
  received.push(message);
  dump();
  inbox.push(message);
  wake?.();
});
process.stdin.on("end", () => {
  ended = true;
  wake?.();
});

async function next(match: (m: Json) => boolean): Promise<Json | null> {
  for (;;) {
    const index = inbox.findIndex(match);
    if (index !== -1) return inbox.splice(index, 1)[0] as Json;
    if (ended) return null;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
    wake = null;
  }
}

const write = (message: Json) =>
  new Promise<void>((resolve) =>
    process.stdout.write(`${JSON.stringify(message)}\n`, () => resolve()),
  );

const ids = new Map<unknown, unknown>();
let replies = 0;
let code = 0;
for (const entry of entries) {
  if (entry.c) {
    const recorded = entry.c;
    const got =
      recorded.method !== undefined
        ? await next((m) => m.method === recorded.method)
        : await next((m) => m.method === undefined && m.id === recorded.id);
    if (!got) break; // the client closed its input
    if (recorded.method !== undefined && recorded.id !== undefined) ids.set(recorded.id, got.id);
  } else if (entry.s) {
    const message = { ...entry.s };
    const isReply = message.method === undefined && message.id !== undefined;
    if (isReply) message.id = ids.get(message.id);
    if (isReply && mode === "reject" && "thread" in ((message.result as Json) ?? {})) {
      await write({ id: message.id, error: { code: -32600, message: "thread/start rejected" } });
      continue;
    }
    await write(message);
    if (isReply && ++replies === 1) {
      if (mode === "malformed") process.stdout.write("not json\n");
      if (mode === "die") {
        process.stderr.write("\x1b[31mERROR\x1b[0m fake codex crashed\n");
        process.exit(3);
      }
    }
  } else if (entry.exit) {
    code = entry.exit.code;
  }
}
// Like the real server: it ends when its input does.
await next(() => false);
process.exit(code);
