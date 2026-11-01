import type { Run } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type Approval,
  approvalsKey,
  decideRequest,
  withoutApproval,
} from "../src/api/approvals.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { runEventsKey } from "../src/api/runs.ts";
import { ApprovalCard, ApprovalNotice } from "../src/shell/Approvals.tsx";
import { approvalInputText, approvalSummary } from "../src/shell/approval-model.ts";
import { RunSection } from "../src/shell/RunSection.tsx";
import { ToastProvider } from "../src/ui/index.ts";

const approval = (extra: Partial<Approval> = {}): Approval => ({
  id: "p-1",
  run: "r-01JC8Z3K2QX7M4V9T0B6N5R8PW",
  project: "p",
  task: "BE-01",
  tool: "Bash",
  input: { command: "rm -rf build", description: "Clean the build" },
  requested_at: "2026-11-02T10:00:00Z",
  state: "pending",
  ...extra,
});
const run: Run = {
  id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PW",
  task: "BE-01",
  task_hash: `sha256:${"a".repeat(64)}`,
  agent: { provider: "claude", model: "sonnet", permissions: "default" },
  state: "waiting_approval",
};

function render(node: ReactNode, client = new QueryClient()) {
  return renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={client}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
}

describe("pending approvals (UI-11 ac1)", () => {
  it("appear live in the run's section and in the project's notice", () => {
    const client = new QueryClient();
    client.setQueryData(runEventsKey("p", run.id), []);
    expect(render(<RunSection projectId="p" run={run} readOnly={false} />, client)).not.toContain(
      "pide permiso",
    );
    // permission.requested refetches the list; here the refetched list arrives.
    client.setQueryData(approvalsKey, [approval(), approval({ id: "p-2", run: "r-other" })]);
    const out = render(<RunSection projectId="p" run={run} readOnly={false} />, client);
    expect(out).toContain("BE-01 pide permiso para usar");
    expect(out).toContain("rm -rf build");
    expect(out).toContain(">Permitir<");
    expect(out).toContain(">Denegar…<");
    expect(out.match(/b-approval\b/g)).toHaveLength(1); // only this run's

    const notice = render(<ApprovalNotice approvals={[approval()]} onOpen={() => {}} />);
    expect(notice).toContain("Un agente espera tu aprobación:");
    expect(notice).toContain(">BE-01</button>");
  });

  it("Allow and Deny send the decision, and the approval leaves the list", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const api = createApi("ab".repeat(32), { fetch });
    await decideRequest(api, { run: "r-1", id: "p-1", decision: "allow" });
    await decideRequest(api, { run: "r-1", id: "p-2", decision: "deny", message: "  Not now. " });
    await decideRequest(api, { run: "r-1", id: "p-3", decision: "deny", message: "   " });
    expect(calls).toEqual([
      { url: "/api/runs/r-1/permissions/p-1", body: { decision: "allow" } },
      { url: "/api/runs/r-1/permissions/p-2", body: { decision: "deny", message: "Not now." } },
      { url: "/api/runs/r-1/permissions/p-3", body: { decision: "deny" } },
    ]);
    expect(withoutApproval([approval(), approval({ id: "p-2" })], "p-1").map((a) => a.id)).toEqual([
      "p-2",
    ]);
  });

  it("shows no decision buttons in read-only mode", () => {
    const out = render(<ApprovalCard approval={approval()} readOnly />);
    expect(out).not.toContain(">Permitir<");
  });
});

describe("tool input (UI-11 ac2)", () => {
  it("is escaped: markup from the agent is shown as text", () => {
    const evil = approval({
      tool: "<img src=x onerror=alert(1)>",
      input: { command: "<script>alert('x')</script>", file_path: '"><b>bold</b>' },
    });
    const out = render(<ApprovalCard approval={evil} readOnly={false} />);
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img src=x");
    expect(out).not.toContain("<b>bold</b>");
    expect(out).toContain("&lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt;");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("is truncated by characters and lines, without splitting a character", () => {
    const long = approvalInputText({ content: "é".repeat(5000) }, 100, 40);
    expect(long.truncated).toBe(true);
    expect(Array.from(long.text)).toHaveLength(100);
    const tall = approvalInputText({ lines: Array.from({ length: 200 }, (_, i) => i) }, 10_000, 10);
    expect(tall.truncated).toBe(true);
    expect(tall.text.split("\n")).toHaveLength(10);
    const emoji = approvalInputText("🙂".repeat(50), 11);
    expect(emoji.text).toBe(`"${"🙂".repeat(10)}`);
    expect(approvalInputText({ a: 1 })).toEqual({ text: '{\n  "a": 1\n}', truncated: false });

    const out = render(
      <ApprovalCard
        approval={approval({ input: { content: "x".repeat(10_000) } })}
        readOnly={false}
      />,
    );
    expect(out).toContain("… (recortado)");
    expect(out.length).toBeLessThan(6000);
  });

  it("summarizes the most telling field on one line", () => {
    expect(approvalSummary({ command: "npm  test\n--watch" })).toBe("npm test --watch");
    expect(approvalSummary({ file_path: "src/a.ts", content: "x" })).toBe("src/a.ts");
    expect(approvalSummary({ other: 1 })).toBeNull();
    expect(Array.from(approvalSummary({ command: "y".repeat(500) }) ?? "")).toHaveLength(160);
  });
});
