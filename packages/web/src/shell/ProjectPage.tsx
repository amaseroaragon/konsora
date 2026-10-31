import { useBoard, useBoardEvents } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { t } from "../i18n/index.ts";
import { Panel } from "../ui/index.ts";
import { Board } from "./Board.tsx";
import { Rich } from "./Rich.tsx";
import { QueryError } from "./Shell.tsx";

/** A project's board, kept live over the daemon's WebSocket (also while the plan is unreadable). */
export function ProjectPage({ id }: { id: string }) {
  const board = useBoard(id);
  const live = useBoardEvents(id);
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
  return (
    <Panel
      title={data.project.name}
      {...(data.status === "invalid" ? { eyebrow: t("project.invalid.title") } : {})}
      actions={back}
    >
      {data.status === "missing" ? (
        <p className="s-text">
          <Rich text={t("project.missing.text")} />
        </p>
      ) : (
        <>
          <p className="s-text">{t("project.invalid.text")}</p>
          <ul className="s-issues">
            {data.issues.map((issue) => (
              <li key={`${issue.path}:${issue.code}`}>
                <code>{issue.path || "/"}</code> {issue.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
