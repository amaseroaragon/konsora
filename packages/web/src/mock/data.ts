/**
 * Fake project for the mock app (UI-04 phase 3). Task ids, titles and dependencies mirror
 * this repo's real backlog; states, runs, logs and diffs are invented to show every UI case.
 */
import type { Project, Run, Task } from "../app/model.ts";

const claude = { provider: "claude", model: "opus", effort: "alto" } as const;
const codex = { provider: "codex", model: "gpt-5.5", effort: "medio" } as const;
const check = { id: "ac9", text: "Workspace checks pass", check: "npm run check" };

function task(t: Partial<Task> & Pick<Task, "id" | "title" | "state">): Task {
  return {
    group: t.id.split("-")[0] ?? "",
    deps: [],
    desc: "",
    acceptance: [],
    createdBy: "agent:claude",
    notes: [],
    ...t,
  };
}

const tasks: Task[] = [
  task({
    id: "CORE-01",
    title: "Define schema v2 with zod and generate JSON Schema",
    state: "done",
    agent: claude,
    desc: "Structural schema of `konsora/2` as in docs/esquema-tareas.md §1, plus a generated JSON Schema with a freshness test.",
    acceptance: [
      { id: "ac1", text: "All field constraints of §1 are enforced", result: "pass" },
      { id: "ac2", text: "Committed JSON Schema matches the generated one", result: "pass" },
      { ...check, result: "pass" },
    ],
  }),
  task({
    id: "CORE-02",
    title: "Semantic validation with JSON Pointer errors",
    state: "done",
    deps: ["CORE-01"],
    agent: claude,
    desc: "Unique ids, existing deps, no cycles (iterative Kahn), seq monotonic. Errors as {path, code, message}.",
    acceptance: [
      { id: "ac1", text: "Each rule has a failing-fixture test", result: "pass" },
      { id: "ac2", text: "2000-task document validates in < 200 ms", result: "pass" },
    ],
  }),
  task({
    id: "CORE-03",
    title: "Canonical serializer",
    state: "doing",
    deps: ["CORE-01"],
    agent: claude,
    desc: "Fixed key order, omitted empty optionals, 2-space indent, natural id order. Property test: serialize(parse(x)) === x.",
    acceptance: [
      { id: "ac1", text: "Property test: serialize(parse(x)) === x" },
      { id: "ac2", text: "Adding one task changes a single contiguous hunk" },
      check,
    ],
  }),
  task({
    id: "CORE-04",
    title: "Graph derivations: blocked, ready, waiting, topo order, YOLO chain",
    state: "review",
    deps: ["CORE-02"],
    agent: codex,
    desc: "Pure functions over a validated document: blocked, ready, waiting, topological order, transitive deps and the YOLO chain of a task.",
    acceptance: [
      {
        id: "ac1",
        text: "Review deps do not unblock dependents",
        check: "npx vitest run graph",
        result: "pass",
      },
      { id: "ac2", text: "Topological order is stable for equal ranks", result: "pass" },
      { ...check, result: "pass" },
    ],
    notes: [
      {
        id: "n1",
        at: "2026-11-02T12:41:00Z",
        by: "agent:codex",
        kind: "note",
        text: "Using iterative DFS for transitive deps to avoid recursion limits.",
        run: "r-01JD4C",
      },
      {
        id: "n2",
        at: "2026-11-02T12:49:00Z",
        by: "agent:codex",
        kind: "summary",
        text: "Added graph.ts with blocked/ready/waiting/topoOrder/yoloChain and 24 tests, including property tests on random DAGs.",
        run: "r-01JD4C",
      },
    ],
  }),
  task({
    id: "CORE-05",
    title: "State machine and semantic operations",
    state: "todo",
    deps: ["CORE-03", "CORE-04"],
    agent: claude,
    desc: "Transitions and role table of §2 as semantic ops with per-task preconditions.",
  }),
  task({
    id: "CORE-06",
    title: "File store: PID lock, atomic write, fsync and watcher",
    state: "todo",
    deps: ["CORE-05"],
    desc: "O_EXCL lock with PID, atomic write with fsync, watcher with hash comparison.",
  }),
  task({
    id: "CLI-01",
    title: "CLI skeleton, init and read commands",
    state: "todo",
    deps: ["CORE-06"],
    desc: "konsora init/status/list/show/ready/blocked/check with --json.",
  }),
  task({
    id: "CLI-02",
    title: "Agent write commands",
    state: "todo",
    deps: ["CLI-01"],
    desc: "propose, batch, start, note, ask, finish… No human transitions.",
  }),
  task({
    id: "CLI-05",
    title: "Export the board as a read-only HTML snapshot",
    state: "proposed",
    createdBy: "agent:claude",
    desc: "A `konsora export` command that writes a single self-contained HTML file with the board and graph, for sharing a status without running Konsora.",
    acceptance: [{ id: "ac1", text: "Exported file opens offline and shows every task" }],
  }),
  task({
    id: "DMN-01",
    title: "Daemon: loopback, token, Host/Origin checks",
    state: "todo",
    deps: ["CORE-06"],
    agent: codex,
  }),
  task({
    id: "DMN-02",
    title: "Ops endpoint, approvals ledger and external-change detection",
    state: "todo",
    deps: ["CORE-05", "DMN-01"],
  }),
  task({
    id: "UI-04",
    title: "Visual direction and design system",
    state: "doing",
    agent: claude,
    desc: "Visual direction, tokens and base components, and a navigable mock app.",
    notes: [
      {
        id: "n1",
        at: "2026-11-02T13:02:00Z",
        by: "agent:claude",
        kind: "question",
        text: "¿Prefieres que la vista de grafo agrupe los nodos por grupo o solo por profundidad?",
      },
    ],
  }),
  task({
    id: "UI-01",
    title: "Web app scaffold, i18n and konsora ui",
    state: "todo",
    deps: ["DMN-01", "UI-04"],
  }),
  task({
    id: "UI-06",
    title: "Empty states and first-run copy",
    state: "todo",
    agent: claude,
    desc: "Copy and layout for: no projects linked, project without tasks.json, invalid file, no runs yet.",
    acceptance: [{ id: "ac1", text: "Every empty state explains the next action in one sentence" }],
  }),
  task({
    id: "DOC-01",
    title: "Development guide: setup, commands and conventions",
    state: "todo",
    agent: codex,
    desc: "docs/desarrollo.md for the new monorepo: requirements, commands, how to add a package, how to regenerate tokens.",
    acceptance: [
      { id: "ac1", text: "A fresh clone reaches a green `npm run check` following only the guide" },
    ],
  }),
  task({
    id: "UI-05",
    title: "Command palette with keyboard actions",
    state: "proposed",
    createdBy: "agent:codex",
    desc: "Ctrl+K palette to jump to a task, switch view, run the selection or approve proposals.",
  }),
];

const graphDiff: Run["diff"] = [
  {
    path: "packages/core/src/graph.ts",
    added: 64,
    removed: 0,
    lines: [
      { kind: "hunk", text: "@@ -0,0 +1,64 @@" },
      {
        kind: "add",
        text: "+/** Unfinished dependencies of a todo task; only `done` unblocks. */",
      },
      { kind: "add", text: "+export function blockers(task: Task, index: TaskIndex): TaskId[] {" },
      { kind: "add", text: '+  if (task.state !== "todo") return [];' },
      {
        kind: "add",
        text: '+  return (task.deps ?? []).filter((id) => index.get(id)?.state !== "done");',
      },
      { kind: "add", text: "+}" },
      { kind: "add", text: "+" },
      { kind: "add", text: "+export const isReady = (task: Task, index: TaskIndex) =>" },
      { kind: "add", text: '+  task.state === "todo" && blockers(task, index).length === 0;' },
    ],
  },
  {
    path: "packages/core/src/index.ts",
    added: 1,
    removed: 1,
    lines: [
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      { kind: "ctx", text: ' export * from "./schema.ts";' },
      { kind: "del", text: '-export const packageName = "@konsora/core";' },
      { kind: "add", text: '+export * from "./graph.ts";' },
    ],
  },
];

const runs: Run[] = [
  {
    id: "r-01JD5A",
    task: "CORE-03",
    agent: claude,
    state: "running",
    startedAt: new Date(Date.now() - 252_000).toISOString(),
    events: [
      { at: "13:20:02", kind: "start", text: "opus · worktree konsora/CORE-03/01JD5A" },
      { at: "13:20:05", kind: "read", text: "docs/esquema-tareas.md §4" },
      { at: "13:21:40", kind: "edit", text: "packages/core/src/serialize.ts (+88)" },
      { at: "13:22:31", kind: "bash", text: "npx vitest run serialize → 9 passed, 1 failed" },
      {
        at: "13:23:10",
        kind: "message",
        text: "Natural id order breaks for ids without a number; adding a fallback.",
      },
      { at: "13:24:02", kind: "edit", text: "packages/core/src/serialize.ts (+6 −2)" },
    ],
    checks: [],
    diff: [],
  },
  {
    id: "r-01JD4C",
    task: "CORE-04",
    agent: codex,
    state: "succeeded",
    startedAt: "2026-11-02T12:40:11Z",
    durationS: 548,
    tokens: { input: 38200, output: 6100 },
    events: [
      { at: "12:40:11", kind: "start", text: "gpt-5.5 · worktree konsora/CORE-04/01JD4C" },
      { at: "12:40:15", kind: "read", text: "packages/core/src/schema.ts" },
      { at: "12:42:02", kind: "edit", text: "packages/core/src/graph.ts (+64)" },
      { at: "12:44:30", kind: "edit", text: "packages/core/test/graph.test.ts (+141)" },
      { at: "12:46:12", kind: "bash", text: "npx vitest run graph → 24 passed" },
      {
        at: "12:47:01",
        kind: "permission",
        text: 'git commit -m "feat(core): graph derivations" → aprobado',
      },
      { at: "12:49:18", kind: "check", text: "lint ✓ typecheck ✓ test ✓" },
      { at: "12:49:19", kind: "end", text: "resumen enviado · tarea → revisión" },
    ],
    checks: [
      { id: "lint", ok: true, detail: "biome check" },
      { id: "typecheck", ok: true, detail: "tsc --noEmit" },
      { id: "test", ok: true, detail: "71 + 24 passed" },
      { id: "ac1", ok: true, detail: "npx vitest run graph" },
    ],
    diff: graphDiff,
    summary:
      "Added graph.ts with blocked/ready/waiting/topoOrder/yoloChain and 24 tests, including property tests on random DAGs.",
  },
  {
    id: "r-01JD3Z",
    task: "CORE-02",
    agent: claude,
    state: "succeeded",
    startedAt: "2026-11-02T11:05:40Z",
    durationS: 731,
    tokens: { input: 52900, output: 8800 },
    events: [{ at: "11:05:40", kind: "start", text: "opus · retry after failed checks" }],
    checks: [{ id: "test", ok: true, detail: "61 passed" }],
    diff: [],
    summary: "Semantic validation with JSON Pointer errors.",
    integrated: true,
  },
  {
    id: "r-01JD3P",
    task: "CORE-02",
    agent: claude,
    state: "failed",
    startedAt: "2026-11-02T10:41:03Z",
    durationS: 902,
    tokens: { input: 47100, output: 7400 },
    events: [
      { at: "10:41:03", kind: "start", text: "opus · worktree konsora/CORE-02/01JD3P" },
      {
        at: "10:55:51",
        kind: "check",
        text: "test ✗ cycle detection recursed past the stack limit",
      },
      { at: "10:56:05", kind: "error", text: "checks failed · devuelto al agente (reintento 1/2)" },
    ],
    checks: [{ id: "test", ok: false, detail: "RangeError: Maximum call stack size exceeded" }],
    diff: [],
  },
];

export const mockProject: Project = {
  id: "konsora",
  name: "konsora",
  path: "~/Personal/konsora",
  groups: [
    { id: "CORE", name: "Núcleo" },
    { id: "CLI", name: "CLI" },
    { id: "DMN", name: "Daemon" },
    { id: "UI", name: "Interfaz" },
    { id: "DOC", name: "Docs" },
  ],
  tasks,
  runs,
};

export const otherProjects = [
  { id: "weather", name: "weather-app", path: "~/code/weather-app" },
  { id: "dotfiles", name: "dotfiles", path: "~/dotfiles" },
];

/** Rate-limit usage shown in the header (fake). */
export const usage = { claude: 18, codex: 42 };
