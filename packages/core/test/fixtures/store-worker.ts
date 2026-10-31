// Child process for the concurrency test: proposes `count` tasks titled `<name>-<i>`.
// Usage: node store-worker.ts <root> <name> <count>
import { mutate } from "../../src/store.ts";

const [root, name, count] = process.argv.slice(2) as [string, string, string];
let failures = 0;
for (let i = 0; i < Number(count); i++) {
  const result = await mutate(
    root,
    { op: "propose", title: `${name}-${i}`, group: "BE" },
    { actor: `agent:${name}`, at: "2026-11-02T10:00:00Z" },
    { lockTimeoutMs: 20_000, lockPollMs: 2 },
  );
  if (!result.ok) {
    failures++;
    console.error(JSON.stringify(result.error));
  }
}
process.exit(failures === 0 ? 0 : 1);
