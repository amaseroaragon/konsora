import { ApiError } from "../api/client.ts";
import { useBoard } from "../api/projects.ts";
import { t } from "../i18n/index.ts";
import { Panel, StateBadge, type TaskState, taskStates } from "../ui/index.ts";
import { Rich } from "./Rich.tsx";
import { QueryError } from "./Shell.tsx";

/** A project's plan at a glance; UI-02 replaces the counts with the interactive board. */
export function ProjectPage({ id }: { id: string }) {
  const board = useBoard(id);
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
  if (data.status !== "ok") {
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
  const counts = new Map<string, number>();
  for (const task of data.tasks) counts.set(task.state, (counts.get(task.state) ?? 0) + 1);
  return (
    <Panel title={data.project.name} eyebrow={data.project.path} actions={back}>
      <h3 className="k-label">{t("project.tasks")}</h3>
      <ul className="s-counts">
        {taskStates.map((state: TaskState) => (
          <li key={state}>
            <StateBadge kind={state} />
            <span className="s-counts__n">{counts.get(state) ?? 0}</span>
          </li>
        ))}
      </ul>
      <p className="s-text s-muted">{t("project.boardSoon")}</p>
    </Panel>
  );
}
