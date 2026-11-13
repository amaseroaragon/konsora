import type { Task } from "@konsora/core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingQuestions } from "../src/api/questions.ts";
import {
  questionAlerts,
  readNotify,
  titleWithCount,
  writeNotify,
} from "../src/shell/notify-model.ts";
import { NotifySettings } from "../src/shell/QuestionAlerts.tsx";

const at = "2026-11-12T10:00:00Z";
const pending = (...ids: [string, string][]): PendingQuestions => ({
  total: ids.length,
  projects: [
    {
      project: { id: "p-1", name: "Weather" },
      questions: ids.map(([task, note]) => ({
        task: { id: task, title: `Tarea ${task}` } as Task as never,
        question: { id: note, at, by: "agent:claude", kind: "question", text: `¿${task}?` },
      })),
    },
  ],
});
const on = { enabled: true, permission: "granted" as const, hidden: true };

function stubWindow(permission?: NotificationPermission, stored: Record<string, string> = {}) {
  const store = new Map(Object.entries(stored));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    ...(permission ? { Notification: { permission } } : {}),
  });
  return store;
}
afterEach(() => vi.unstubAllGlobals());

describe("notices of new questions (UI-15)", () => {
  it("notifies only questions that arrive after the first look", () => {
    const first = questionAlerts(null, pending(["BE-01", "n1"]), on);
    expect(first.notify).toEqual([]);
    const next = questionAlerts(first.seen, pending(["BE-01", "n1"], ["BE-02", "n4"]), on);
    expect(next.notify).toEqual([
      {
        project: "p-1",
        projectName: "Weather",
        task: "BE-02",
        title: "Tarea BE-02",
        text: "¿BE-02?",
      },
    ]);
    // A second question on the same task is news too.
    expect(questionAlerts(next.seen, pending(["BE-02", "n6"]), on).notify).toHaveLength(1);
  });

  it("stays quiet when off, without permission or with the tab in front", () => {
    const seen = questionAlerts(null, pending(), on).seen;
    const data = pending(["BE-02", "n4"]);
    expect(questionAlerts(seen, data, { ...on, enabled: false }).notify).toEqual([]);
    expect(questionAlerts(seen, data, { ...on, permission: "default" }).notify).toEqual([]);
    expect(questionAlerts(seen, data, { ...on, permission: "denied" }).notify).toEqual([]);
    expect(questionAlerts(seen, data, { ...on, hidden: false }).notify).toEqual([]);
  });

  it("puts the number of pending questions in the tab title", () => {
    expect(titleWithCount("Konsora", 0)).toBe("Konsora");
    expect(titleWithCount("Konsora", 3)).toBe("(3) Konsora");
  });

  it("remembers the preference in this browser", () => {
    const store = stubWindow("granted");
    expect(readNotify()).toBe(false);
    writeNotify(true);
    expect(store.get("konsora.notify")).toBe("on");
    expect(readNotify()).toBe(true);
    writeNotify(false);
    expect(readNotify()).toBe(false);
  });

  it("Ajustes explains each case: on, off, blocked and unsupported", () => {
    stubWindow("granted", { "konsora.notify": "on" });
    expect(renderToStaticMarkup(<NotifySettings />)).toContain("Activados");
    stubWindow("default");
    const off = renderToStaticMarkup(<NotifySettings />);
    expect(off).toContain("Desactivados.");
    expect(off).toMatch(/<button[^>]*>Activar avisos/);
    stubWindow("denied", { "konsora.notify": "on" });
    const denied = renderToStaticMarkup(<NotifySettings />);
    expect(denied).toContain("tiene bloqueados los avisos");
    expect(denied).toMatch(/<button[^>]*disabled[^>]*>Activar avisos/);
    stubWindow();
    expect(renderToStaticMarkup(<NotifySettings />)).toContain("no admite avisos");
  });
});
