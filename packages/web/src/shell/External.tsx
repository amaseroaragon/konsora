import type { ExternalFlag } from "../api/board.ts";
import { useResolveExternal } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { t } from "../i18n/index.ts";
import { askConfirm, Button, useToast } from "../ui/index.ts";
import { confirmRevert, externalText } from "./board-model.ts";

/** One unapproved external change with its confirm / revert buttons (hidden when read-only). */
function ExternalRow({
  projectId,
  flag,
  readOnly,
  showTask,
}: {
  projectId: string;
  flag: ExternalFlag;
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
    </li>
  );
}

/** Unapproved changes made outside Konsora: a banner for the board or a box in the task panel. */
export function ExternalChanges({
  projectId,
  flags,
  readOnly,
  showTask = true,
}: {
  projectId: string;
  flags: readonly ExternalFlag[];
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
            readOnly={readOnly}
            showTask={showTask}
          />
        ))}
      </ul>
    </section>
  );
}
