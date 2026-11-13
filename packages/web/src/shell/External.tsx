import type { Task } from "@konsora/core";
import type { ExternalFlag } from "../api/board.ts";
import { useResolveExternal } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { t } from "../i18n/index.ts";
import { askConfirm, Button, useToast } from "../ui/index.ts";
import { confirmRevert, externalText } from "./board-model.ts";
import { clipped, externalDiff, FIELD_LABEL, lostContent } from "./external-model.ts";

/** A value that may be long: cut to its start, with the whole text one click away (ac3). */
function Clip({ text }: { text: string }) {
  if (!text) return <span className="s-muted">{t("external.empty")}</span>;
  const start = clipped(text);
  if (!start) return <span className="b-external__value">{text}</span>;
  return (
    <details className="b-external__clip">
      <summary>{start}</summary>
      <span className="b-external__value">{text}</span>
    </details>
  );
}

/**
 * What the change did (UI-22): each field that differs from the version kept for «Revertir», with
 * both values; for a deleted task, what it had and would be lost.
 */
function ExternalDetail({ flag, current }: { flag: ExternalFlag; current: Task | undefined }) {
  const previous = flag.previous ?? null;
  if (flag.kind === "deleted" && previous) {
    return (
      <div className="b-external__diff">
        <p className="b-external__caption">{t("external.lost")}</p>
        <dl className="b-external__lost">
          {lostContent(previous).map(({ field, value }) => (
            <div key={field} className="b-external__field">
              <dt className="k-label">{t(FIELD_LABEL[field])}</dt>
              <dd>
                <Clip text={value} />
              </dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }
  const rows = externalDiff(previous, current);
  if (rows.length === 0) return <p className="b-external__diff s-muted">{t("external.nodiff")}</p>;
  return (
    <table className="b-external__diff">
      <thead>
        <tr>
          <th scope="col">{t("external.diff.field")}</th>
          <th scope="col">{t("external.diff.before")}</th>
          <th scope="col">{t("external.diff.after")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.field}>
            <th scope="row" className="k-label">
              {t(FIELD_LABEL[row.field])}
            </th>
            <td className="b-external__before">
              <Clip text={row.before} />
            </td>
            <td>
              <Clip text={row.after} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One unapproved external change with its confirm / revert buttons (hidden when read-only). */
function ExternalRow({
  projectId,
  flag,
  current,
  readOnly,
  showTask,
}: {
  projectId: string;
  flag: ExternalFlag;
  /** The task as it is now; absent when it was deleted. */
  current: Task | undefined;
  readOnly: boolean;
  showTask: boolean;
}) {
  const resolve = useResolveExternal(projectId);
  const toast = useToast();
  const run = async (how: "confirm" | "revert") => {
    if (how === "revert" && !(await confirmRevert(flag.task, askConfirm))) return;
    resolve.mutate(
      { task: flag.task, how },
      {
        onSuccess: () =>
          toast.show(
            t(how === "confirm" ? "external.confirm.done" : "external.revert.done", {
              id: flag.task,
            }),
            "success",
          ),
        onError: (error) => {
          if (error instanceof ApiError && error.unauthorized) return;
          toast.show(t("error.generic", { message: error.message }), "error");
        },
      },
    );
  };
  return (
    <li className="b-external__row">
      <span>
        {showTask && <b className="k-mono">{flag.task}</b>} {externalText(flag)}
      </span>
      {!readOnly && (
        <span className="a-actions">
          <Button
            size="sm"
            busy={resolve.isPending && resolve.variables?.how === "confirm"}
            onClick={() => void run("confirm")}
          >
            {t("external.confirm")}
          </Button>
          <Button
            size="sm"
            variant="danger"
            busy={resolve.isPending && resolve.variables?.how === "revert"}
            onClick={() => void run("revert")}
          >
            {t("external.revert")}
          </Button>
        </span>
      )}
      <ExternalDetail flag={flag} current={current} />
    </li>
  );
}

/** Unapproved changes made outside Konsora: a banner for the board or a box in the task panel. */
export function ExternalChanges({
  projectId,
  flags,
  tasks,
  readOnly,
  showTask = true,
}: {
  projectId: string;
  flags: readonly ExternalFlag[];
  /** The plan's tasks as they are now, to compare with the version kept for reverting. */
  tasks: readonly Task[];
  readOnly: boolean;
  showTask?: boolean;
}) {
  if (flags.length === 0) return null;
  return (
    <section className="a-callout b-external" aria-label={t("external.title")}>
      <p className="a-callout__text">
        <b>{t("external.count", { n: flags.length })}</b> {t("external.text")}
      </p>
      <ul className="b-external__list">
        {flags.map((flag) => (
          <ExternalRow
            key={`${flag.task}:${flag.kind}:${flag.detected_at}`}
            projectId={projectId}
            flag={flag}
            current={tasks.find((task) => task.id === flag.task)}
            readOnly={readOnly}
            showTask={showTask}
          />
        ))}
      </ul>
    </section>
  );
}
