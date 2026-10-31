import { type MessageKey, t } from "../i18n/index.ts";

export type RunLogEventKind =
  | "start"
  | "read"
  | "edit"
  | "bash"
  | "permission"
  | "check"
  | "message"
  | "end"
  | "error";
export type RunLogEvent = { at: string; kind: RunLogEventKind; text: string };

const kindKey: Record<RunLogEventKind, MessageKey> = {
  start: "log.start",
  read: "log.read",
  edit: "log.edit",
  bash: "log.bash",
  permission: "log.permission",
  check: "log.check",
  message: "log.message",
  end: "log.end",
  error: "log.error",
};

/** Normalized run events as a mono table-like list. `live` announces new lines politely. */
export function RunLog({
  events,
  live = false,
}: {
  events: readonly RunLogEvent[];
  live?: boolean;
}) {
  return (
    <ol className="k-log" aria-live={live ? "polite" : undefined}>
      {events.map((event, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: events are append-only.
        <li key={index} className="k-log__row">
          <span className="k-log__at">{event.at}</span>
          <span className={`k-log__kind k-log__kind--${event.kind}`}>{t(kindKey[event.kind])}</span>
          <span className="k-log__text">{event.text}</span>
        </li>
      ))}
    </ol>
  );
}
