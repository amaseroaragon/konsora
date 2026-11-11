import { deriveFlags, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { actionBody, type BoardTask } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { confirmWithdraw } from "../src/shell/board-model.ts";
import { TaskPanel } from "../src/shell/TaskPanel.tsx";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-02T10:00:00Z";
const proposal: Task = {
  id: "BE-05",
  title: "Propuesta de caché",
  state: "proposed",
  group: "BE",
  rank: "a",
  created: { at, by: "agent:claude" },
  updated_at: at,
};
const approved: Task = { ...proposal, id: "BE-06", title: "Ya aprobada", state: "todo" };
const doc: TasksDocument = {
  schema: "konsora/3",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 6 },
  tasks: [proposal, approved],
};
const boardTask = (task: Task): BoardTask =>
  ({
    ...task,
    ...(deriveFlags(doc).get(task.id) as object),
    hash: taskHash(task),
  }) as BoardTask;

/** A fetch that records each request and answers 200 with an empty body. */
function recorder() {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { calls, api: createApi("ab".repeat(32), { fetch }) };
}

function panel(task: Task) {
  return renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <TaskPanel
            projectId="p"
            task={boardTask(task)}
            doc={doc}
            groupName="Backend"
            external={[]}
            readOnly={false}
            onClose={() => {}}
            onOpen={() => {}}
          />
        </ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
}

describe("rejecting a proposal (UI-33 ac1)", () => {
  it("sends withdraw on the proposal, conditioned on the version the panel showed", async () => {
    const task = boardTask(proposal);
    expect(actionBody({ task, action: "withdraw" })).toEqual({
      op: "withdraw",
      task: "BE-05",
      expect: { "BE-05": task.hash },
    });

    const { calls, api } = recorder();
    await api.post("/projects/p/ops", actionBody({ task, action: "withdraw" }));
    expect(calls).toEqual([
      {
        url: "/api/projects/p/ops",
        body: { op: "withdraw", task: "BE-05", expect: { "BE-05": task.hash } },
      },
    ]);
  });

  it("offers Rechazar on a proposal only", () => {
    expect(panel(proposal)).toContain("Rechazar");
    expect(panel(approved)).not.toContain("Rechazar");
  });
});

describe("confirming a rejection (UI-33 ac2)", () => {
  it("asks first and sends nothing when the human declines", () => {
    const questions: string[] = [];
    expect(
      confirmWithdraw("BE-05", (question) => {
        questions.push(question);
        return false;
      }),
    ).toBe(false);
    expect(questions).toEqual(["¿Rechazar la propuesta BE-05? Se borrará del plan."]);
  });

  it("goes ahead when the human confirms", () => {
    expect(confirmWithdraw("BE-05", () => true)).toBe(true);
  });
});
