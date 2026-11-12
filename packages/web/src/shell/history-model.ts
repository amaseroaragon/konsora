/**
 * The History view's model (UI-04): core's completion log grouped by local day, with the time,
 * who finished each task and the first line of its summary as plain text.
 */
import type { LogEntry } from "@konsora/core";
import { t } from "../i18n/index.ts";
import { type Inline, parseInline } from "./md-parse.ts";

export type HistoryDay = {
  /** Local calendar day, `YYYY-MM-DD`. */
  key: string;
  label: string;
  entries: { entry: LogEntry; time: string }[];
};

/** `YYYY-MM-DD` of an instant in a time zone (the browser's when none is given). */
function dayKey(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Splits the log (already newest first) into local days. Today and yesterday are named as such;
 * other days get their full date ("lunes, 9 de noviembre de 2026").
 */
export function groupByDay(
  entries: readonly LogEntry[],
  { now = new Date(), timeZone }: { now?: Date; timeZone?: string } = {},
): HistoryDay[] {
  const today = dayKey(now, timeZone);
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000), timeZone);
  const full = new Intl.DateTimeFormat("es", { timeZone, dateStyle: "full" });
  const clock = new Intl.DateTimeFormat("es", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const days: HistoryDay[] = [];
  for (const entry of entries) {
    const date = new Date(entry.at);
    const key = dayKey(date, timeZone);
    let day = days.at(-1);
    if (day?.key !== key) {
      const label =
        key === today
          ? t("history.today")
          : key === yesterday
            ? t("history.yesterday")
            : full.format(date);
      day = { key, label, entries: [] };
      days.push(day);
    }
    day.entries.push({ entry, time: clock.format(date) });
  }
  return days;
}

function plain(nodes: readonly Inline[]): string {
  return nodes
    .map((node) =>
      node.type === "text" || node.type === "code"
        ? node.text
        : node.type === "break"
          ? " "
          : plain(node.children),
    )
    .join("");
}

/** The first non-empty line of a summary as plain text (markdown marks removed), shortened. */
export function summaryLine(summary: string, max = 160): string {
  const line =
    summary
      .split("\n")
      .map((raw) => raw.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "").trim())
      .find((raw) => raw.length > 0) ?? "";
  const text = plain(parseInline(line)).trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** "tú" for the human, the agent's name for an agent, "Konsora" for Konsora itself. */
export function actorName(actor: string): string {
  if (actor === "human") return t("detail.you");
  if (actor === "konsora") return "Konsora";
  return actor.replace(/^agent:/, "");
}
