import {
  type ChecksFile,
  deriveFlags,
  type Run,
  type Task,
  type TasksDocument,
  taskHash,
} from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardTask } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { applyRunMessage, runChecksKey, runDiffKey, runEventsKey } from "../src/api/runs.ts";
import { ChecksList } from "../src/shell/ChecksHistory.tsx";
import {
  checkOutcome,
  confirmAccept,
  criterionResults,
  failingReviews,
  formatDuration,
} from "../src/shell/checks-model.ts";
import { logRows } from "../src/shell/run-model.ts";
import { TaskPanel } from "../src/shell/TaskPanel.tsx";
import { TaskCard, ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-02T10:00:00Z";
const runId = "r-01JC8Z3K2QX7M4V9T0B6N5R8PW";

const file: ChecksFile = {
  run: runId,
  attempts: [
    {
      attempt: 1,
      started_at: at,
      results: [
        {
          id: "unit",
          source: "project",
          command: "npm test",
          exit_code: 1,
          duration_ms: 8123,
          timed_out: false,
          output: "FAIL cache.test.ts\n",
        },
      ],
    },
    {
      attempt: 2,
      started_at: at,
      results: [
        {
          id: "unit",
          source: "project",
          command: "npm test",
          exit_code: 0,
          duration_ms: 950,
          timed_out: false,
          output: "",
        },
        {
          id: "ac1",
          source: "acceptance",
          command: "npm test -- cache",
          exit_code: null,
          duration_ms: 600_000,
          timed_out: true,
          output: "…still waiting <script>\n",
          output_truncated: true,
        },
      ],
    },
  ],
};

const task: Task = {
  id: "BE-01",
  title: "Caché",
  state: "review",
  group: "BE",
  rank: "a",
  acceptance: [
    { id: "ac1", text: "Cachea", check: "npm test -- cache" },
    { id: "ac2", text: "Se lee bien" },
    { id: "ac3", text: "Sin regresiones", check: "npm test" },
  ],
  created: { at, by: "human" },
  updated_at: at,
};
const doc: TasksDocument = {
  schema: "konsora/2",
  project: { name: "P", base_branch: "main" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 1 },
  tasks: [task],
};
const boardTask = {
  ...task,
  ...(deriveFlags(doc).get("BE-01") as object),
  hash: taskHash(task),
} as BoardTask;
const run: Run = {
  id: runId,
  task: "BE-01",
  task_hash: `sha256:${"a".repeat(64)}`,
  agent: { provider: "claude", model: "sonnet", permissions: "default" },
  state: "succeeded",
  started_at: at,
  finished_at: at,
  check_attempts: 2,
  checks: [
    { id: "unit", source: "project", exit_code: 0, duration_ms: 950, timed_out: false },
    { id: "ac1", source: "acceptance", exit_code: null, duration_ms: 600_000, timed_out: true },
  ],
};

function panel(r: Run) {
  const client = new QueryClient();
  client.setQueryData(runDiffKey("p", r.id), "");
  client.setQueryData(runEventsKey("p", r.id), []);
  client.setQueryData(runChecksKey("p", r.id), file);
  return renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <TaskPanel
            projectId="p"
            task={boardTask}
            doc={doc}
            groupName="Backend"
            external={[]}
            readOnly={false}
            runs={[r]}
            onClose={() => {}}
            onOpen={() => {}}
          />
        </ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
}

describe("check history in the review (UI-16 ac1)", () => {
  it("shows every attempt, latest first, each check green or red with exit, duration, timeout and output", () => {
    const html = renderToStaticMarkup(<ChecksList file={file} />);
    expect(html.indexOf("Intento 2")).toBeLessThan(html.indexOf("Intento 1"));
    expect(html).toContain('Intento 2 · <span class="b-checks__fail">con fallos</span>');
    expect(html).toContain("superó su tiempo");
    expect(html).toContain("salió con 1");
    expect(html).toContain("8,1 s");
    expect(html).toContain("10 min 00 s");
    expect(html).toContain("Criterio");
    expect(html).toContain("Salida (solo el final)");
    // The output is a disclosure, open for the latest attempt's failures, and escaped.
    expect(html).toContain('<details class="b-check__output" open="">');
    expect(html).toContain("still waiting &lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html.match(/<summary>/g)).toHaveLength(3);
    expect(html).toContain("Sin salida");
  });

  it("the review panel shows the history and warns that the checks are red", () => {
    const html = panel(run);
    expect(html).toContain("Los checks del último intento están en rojo");
    expect(html).toContain("Intento 1");
    expect(html).toContain(">Aceptar<");
  });

  it("a check ending or a retry refreshes the run's checks", () => {
    const client = new QueryClient();
    client.setQueryData(runChecksKey("p", runId), file);
    applyRunMessage(client, "p", {
      type: "run.event",
      run: runId,
      event: { at, t: "check", phase: "end", id: "unit" },
    });
    expect(client.getQueryState(runChecksKey("p", runId))?.isInvalidated).toBe(true);
  });
});

describe("each criterion's last check in the detail (UI-16 ac2)", () => {
  it("shows the result next to criteria with a check", () => {
    expect([...criterionResults(run).keys()]).toEqual(["ac1"]);
    const html = panel(run);
    expect(html).toContain("✕ Último check: superó su tiempo");
    // ac3 has a check that this run's last attempt did not report.
    expect(html).toContain("Su check aún no se ha ejecutado.");
    expect(html.match(/a-criteria__result/g)).toHaveLength(2);
  });
});

describe("red checks on the board and when accepting (UI-16 ac3)", () => {
  it("marks cards in review whose latest run has red checks", () => {
    expect(failingReviews([{ id: "BE-01", state: "review" }], [run])).toEqual(new Set(["BE-01"]));
    expect(failingReviews([{ id: "BE-01", state: "done" }], [run]).size).toBe(0);
    const green = { ...run, checks: [{ id: "unit", exit_code: 0, duration_ms: 1 }] };
    expect(failingReviews([{ id: "BE-01", state: "review" }], [green]).size).toBe(0);
    const html = renderToStaticMarkup(
      <TaskCard id="BE-01" title="Caché" state="review" checksFailed />,
    );
    expect(html).toContain("k-card--checks");
    expect(html).toContain("Checks en rojo");
  });

  it("accepting with red checks asks first; with green ones it does not", () => {
    const asked: string[] = [];
    const no = (q: string) => {
      asked.push(q);
      return false;
    };
    expect(confirmAccept("BE-01", true, no)).toBe(false);
    expect(asked).toEqual([
      "Los checks de BE-01 están en rojo. ¿Aceptar e integrar su trabajo de todos modos?",
    ]);
    expect(confirmAccept("BE-01", true, () => true)).toBe(true);
    expect(confirmAccept("BE-01", false, no)).toBe(true);
    expect(asked).toHaveLength(1);
  });
});

describe("checks in the live log", () => {
  it("shows setup, each check and the retries", () => {
    const rows = logRows([
      { at, t: "setup", phase: "start", command: "npm ci" },
      { at, t: "setup", phase: "end", exit_code: 0, timed_out: false },
      { at, t: "check", phase: "start", id: "unit", command: "npm test" },
      { at, t: "check", phase: "end", id: "unit", exit_code: 1, timed_out: false },
      { at, t: "retry", attempt: 1, of: 2 },
      { at, t: "check", phase: "end", id: "unit", exit_code: 0, timed_out: false },
    ]);
    expect(rows.map((r) => [r.kind, r.text])).toEqual([
      ["bash", "Preparando el worktree · npm ci"],
      ["check", "Worktree preparado"],
      ["check", "Check unit · npm test"],
      ["error", "Check unit falló: salió con 1"],
      ["message", "Checks en rojo: el agente los recibe para corregirlos (reintento 1 de 2)"],
      ["check", "Check unit correcto"],
    ]);
    expect(checkOutcome({ exit_code: 0 })).toBe("correcto");
    expect(formatDuration(850)).toBe("850 ms");
  });
});
