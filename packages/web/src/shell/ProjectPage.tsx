import { useEffect, useRef } from "react";
import { type BoardOk, type Issue, useBoard, useBoardEvents } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { t } from "../i18n/index.ts";
import { Panel } from "../ui/index.ts";
import { Board } from "./Board.tsx";
import { Rich } from "./Rich.tsx";
import { QueryError } from "./Shell.tsx";

function IssueList({ issues }: { issues: readonly Issue[] }) {
  return (
    <ul className="s-issues">
      {issues.map((issue) => (
        <li key={`${issue.path}:${issue.code}:${issue.message}`}>
          <code>{issue.path || "/"}</code> {issue.message}
        </li>
      ))}
    </ul>
  );
}

/**
 * A project's board, kept live over the daemon's WebSocket (also while the plan is unreadable).
 * An invalid plan puts the page in read-only mode: its errors on top and, if this page saw one,
 * the last valid board below without drag or actions. Nothing can be written until it is fixed.
 */
export function ProjectPage({ id }: { id: string }) {
  const board = useBoard(id);
  const live = useBoardEvents(id);
  const lastValid = useRef<BoardOk | null>(null);
  useEffect(() => {
    if (board.data?.status === "ok") lastValid.current = board.data;
  }, [board.data]);
  const back = (
    <a className="s-nav__link" href="#/">
      {t("project.back")}
    </a>
  );
  if (board.isPending) return <p className="s-text s-muted">{t("project.loading")}</p>;
  if (board.isError) {
    if (board.error instanceof ApiError && board.error.status === 404)
      return (
        <Panel title={t("project.notLinked")} actions={back}>
          {null}
        </Panel>
      );
    return <QueryError error={board.error} retry={() => board.refetch()} />;
  }
  const data = board.data;
  if (data.status === "ok") return <Board board={data} live={live} />;
  if (data.status === "missing")
    return (
      <Panel title={data.project.name} actions={back}>
        <p className="s-text">
          <Rich text={t("project.missing.text")} />
        </p>
      </Panel>
    );
  const last = lastValid.current;
  return (
    <div className="b-board">
      <section className="a-callout b-readonly" role="alert" aria-label={t("readonly.title")}>
        <p className="a-callout__text">
          <b>{t("readonly.title")}</b> {last ? t("readonly.text") : t("project.invalid.text")}
        </p>
        {data.issues.length > 0 ? (
          <IssueList issues={data.issues} />
        ) : (
          <p className="s-text">{data.message}</p>
        )}
        {!last && <p className="s-text">{back}</p>}
      </section>
      {last && <Board board={last} live={live} readOnly />}
    </div>
  );
}
