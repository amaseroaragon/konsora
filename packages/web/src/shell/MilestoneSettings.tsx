import { MilestoneIdSchema, type MilestoneProgress, type Task } from "@konsora/core";
import { type FormEvent, useState } from "react";
import { useProjectOp } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { Button, Field, Panel, useToast } from "../ui/index.ts";

/** Sends one milestone op and reports it with a toast. */
function useMilestoneOp(projectId: string) {
  const mutation = useProjectOp(projectId);
  const toast = useToast();
  const send = (op: Record<string, unknown>, done: MessageKey, onSuccess?: () => void) =>
    mutation.mutate(op, {
      onSuccess: () => {
        toast.show(t(done), "success");
        onSuccess?.();
      },
      onError: (error) => {
        if (error instanceof ApiError && error.unauthorized) return;
        const code = error instanceof ApiError ? error.code : "error";
        toast.show(
          code === "in_use"
            ? t("milestones.error.inUse")
            : t("settings.error.other", { message: error.message }),
          "error",
        );
      },
    });
  return { send, busy: mutation.isPending };
}

/** What is wrong with a new milestone's id, if anything. */
export function newMilestoneIdError(
  id: string,
  existing: readonly string[],
): MessageKey | undefined {
  if (!MilestoneIdSchema.safeParse(id).success) return "milestones.error.id";
  if (existing.includes(id)) return "milestones.error.id.twice";
  return undefined;
}

function MilestoneRow({
  projectId,
  milestone,
  tasks,
  disabled,
}: {
  projectId: string;
  milestone: MilestoneProgress;
  /** Tasks of the plan in this milestone: while any, it cannot be removed. */
  tasks: number;
  disabled: boolean;
}) {
  const [name, setName] = useState(milestone.name);
  const [criterion, setCriterion] = useState(milestone.criterion ?? "");
  const { send, busy } = useMilestoneOp(projectId);
  const off = disabled || busy;
  const nameChanged = name.trim() !== milestone.name && name.trim() !== "";
  const criterionChanged = criterion.trim() !== (milestone.criterion ?? "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!nameChanged && !criterionChanged) return;
    send(
      {
        op: "edit-milestone",
        id: milestone.id,
        ...(nameChanged ? { name: name.trim() } : {}),
        ...(criterionChanged ? { criterion: criterion.trim() || null } : {}),
      },
      "milestones.saved",
    );
  };
  return (
    <li className="b-settings__milestone">
      <div className="b-settings__template-head">
        <span>
          <span className="k-mono">{milestone.id}</span>{" "}
          <span className="s-muted">
            {t("milestone.progress", { done: milestone.done, total: milestone.total })}
          </span>
        </span>
        <div className="b-settings__row-actions">
          <Button
            size="sm"
            variant="ghost"
            disabled={off || tasks > 0}
            title={tasks > 0 ? t("milestones.remove.inUse") : undefined}
            onClick={() => send({ op: "remove-milestone", id: milestone.id }, "milestones.removed")}
          >
            ✕
            <span className="k-visually-hidden">
              {t("milestones.remove", { id: milestone.id })}
            </span>
          </Button>
        </div>
      </div>
      <progress
        className="b-milestone__bar"
        max={Math.max(1, milestone.total)}
        value={milestone.done}
        aria-label={t("milestone.progress.label", { name: milestone.name })}
      />
      <form className="b-settings__inline" onSubmit={submit}>
        <Field
          label={t("milestones.name", { id: milestone.id })}
          value={name}
          maxLength={80}
          disabled={off}
          onChange={(event) => setName(event.target.value)}
        />
        <Field
          label={t("milestones.criterion", { id: milestone.id })}
          value={criterion}
          maxLength={500}
          disabled={off}
          onChange={(event) => setCriterion(event.target.value)}
        />
        <div className="b-settings__row-actions">
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={off || (!nameChanged && !criterionChanged)}
          >
            {t("milestones.save")}
          </Button>
        </div>
      </form>
    </li>
  );
}

function AddMilestone({
  projectId,
  ids,
  disabled,
}: {
  projectId: string;
  ids: readonly string[];
  disabled: boolean;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [criterion, setCriterion] = useState("");
  const [error, setError] = useState<MessageKey | undefined>();
  const { send, busy } = useMilestoneOp(projectId);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const key = id.trim().toLowerCase();
    const problem = newMilestoneIdError(key, ids);
    setError(problem);
    if (problem || !name.trim()) return;
    send(
      {
        op: "add-milestone",
        id: key,
        name: name.trim(),
        ...(criterion.trim() ? { criterion: criterion.trim() } : {}),
      },
      "milestones.added",
      () => {
        setId("");
        setName("");
        setCriterion("");
      },
    );
  };
  return (
    <form className="b-settings__add-milestone" onSubmit={submit} noValidate>
      <Field
        mono
        label={t("milestones.new.id")}
        hint={t("milestones.new.id.hint")}
        value={id}
        maxLength={31}
        disabled={disabled || busy}
        error={error ? t(error) : undefined}
        onChange={(event) => setId(event.target.value)}
      />
      <Field
        label={t("milestones.new.name")}
        value={name}
        maxLength={80}
        disabled={disabled || busy}
        onChange={(event) => setName(event.target.value)}
      />
      <Field
        label={t("milestones.new.criterion")}
        value={criterion}
        maxLength={500}
        disabled={disabled || busy}
        onChange={(event) => setCriterion(event.target.value)}
      />
      <div className="b-settings__row-actions">
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          busy={busy}
          disabled={disabled || !id.trim() || !name.trim()}
        >
          {t("milestones.add")}
        </Button>
      </div>
    </form>
  );
}

/**
 * The plan's milestones (CORE-19): each with its progress (done of total tasks, archived ones
 * included), its name and its done criterion; add, edit and remove them. Tasks join a milestone
 * from their panel. A milestone has nothing to do with git.
 */
export function MilestoneSettings({
  projectId,
  milestones,
  tasks,
  readOnly,
}: {
  projectId: string;
  milestones: readonly MilestoneProgress[];
  /** The plan's tasks, to know which milestones still have some. */
  tasks: readonly Pick<Task, "milestone">[];
  readOnly: boolean;
}) {
  return (
    <Panel title={t("milestones.title")} eyebrow={t("settings.eyebrow")}>
      <p className="s-text s-muted">{t("milestones.text")}</p>
      {milestones.length === 0 ? (
        <p className="s-text s-muted">{t("milestones.none")}</p>
      ) : (
        <ol className="b-settings__checks">
          {milestones.map((milestone) => (
            <MilestoneRow
              key={`${milestone.id}:${milestone.name}:${milestone.criterion ?? ""}`}
              projectId={projectId}
              milestone={milestone}
              tasks={tasks.filter((task) => task.milestone === milestone.id).length}
              disabled={readOnly}
            />
          ))}
        </ol>
      )}
      <AddMilestone projectId={projectId} ids={milestones.map((m) => m.id)} disabled={readOnly} />
    </Panel>
  );
}
