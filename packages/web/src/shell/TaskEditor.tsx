import { type AgentSpec, DifficultySchema, type TasksDocument } from "@konsora/core";
import { type FormEvent, useId, useState } from "react";
import { useAgents } from "../api/agents.ts";
import { type BoardTask, useEditTask } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { Button, Field, useToast } from "../ui/index.ts";
import { AgentPicker } from "./AgentPicker.tsx";
import { agentProblem, initialAgent } from "./agent-model.ts";
import {
  changesFrom,
  type Draft,
  type DraftField,
  dependencyProblem,
  draftFrom,
  editErrorText,
  rebaseDraft,
} from "./edit-model.ts";

/** "claude · opus · high" */
const agentText = (agent: AgentSpec) =>
  [agent.provider, agent.model, agent.effort].filter(Boolean).join(" · ");

const FIELD_NAME: Record<DraftField, MessageKey> = {
  title: "edit.field.name.title",
  desc: "edit.field.name.desc",
  labels: "edit.field.name.labels",
  group: "edit.field.name.group",
  acceptance: "edit.field.name.acceptance",
  agent: "edit.field.name.agent",
  difficulty: "edit.field.name.difficulty",
};

const errorText = (error: unknown, ctx: { id: string; on?: string }) =>
  error instanceof ApiError
    ? editErrorText(
        {
          code: error.code,
          message: error.message,
          ...(error.details.issues ? { issues: error.details.issues } : {}),
        },
        ctx,
      )
    : String(error);

/** What changed outside, field by field, between the version the edit started from and now. */
function ChangedOutside({ base, current }: { base: Draft; current: Draft }) {
  const rows: [DraftField, string][] = [];
  if (base.title !== current.title) rows.push(["title", current.title]);
  if (base.desc !== current.desc) rows.push(["desc", current.desc]);
  if (base.labels !== current.labels) rows.push(["labels", current.labels]);
  if (base.group !== current.group) rows.push(["group", current.group]);
  if (JSON.stringify(base.acceptance) !== JSON.stringify(current.acceptance))
    rows.push(["acceptance", current.acceptance.map((ac) => ac.text).join(" · ")]);
  if (JSON.stringify(base.agent) !== JSON.stringify(current.agent))
    rows.push(["agent", current.agent ? agentText(current.agent) : ""]);
  if (base.difficulty !== current.difficulty)
    rows.push(["difficulty", current.difficulty ? t(`difficulty.${current.difficulty}`) : ""]);
  if (rows.length === 0) return <p className="a-callout__text">{t("edit.changed.none")}</p>;
  return (
    <dl className="b-edit__changed">
      {rows.map(([field, value]) => (
        <div key={field}>
          <dt className="k-label">{t(FIELD_NAME[field])}</dt>
          <dd>{value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Edits a task's title, description, criteria, labels and group as one `edit` op conditioned on
 * the version the human started from. If the task changes meanwhile nothing is overwritten: the
 * current version is shown and the draft is kept, to be moved onto it or discarded.
 */
export function TaskEditor({
  projectId,
  task,
  groups,
  defaults,
  onClose,
  startFrom = task,
}: {
  projectId: string;
  task: BoardTask;
  groups: readonly { id: string; name: string }[];
  /** The project's default agent, which the task uses until it has its own. */
  defaults?: AgentSpec | undefined;
  onClose: () => void;
  /** The version the edit starts from (the current task, unless resuming an older draft). */
  startFrom?: BoardTask;
}) {
  const [base, setBase] = useState(startFrom);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(startFrom));
  const [error, setError] = useState<{ field?: DraftField; text: string } | null>(null);
  const [clashes, setClashes] = useState<DraftField[]>([]);
  const mutation = useEditTask(projectId);
  const catalog = useAgents().data;
  const toast = useToast();
  const changedOutside = task.hash !== base.hash;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setError(null);
  };
  const setRow = (index: number, row: Partial<Draft["acceptance"][number]>) =>
    set(
      "acceptance",
      draft.acceptance.map((r, i) => (i === index ? { ...r, ...row } : r)),
    );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (changedOutside) return;
    const check = changesFrom(draft, base, groups, agentProblem(draft.agent ?? undefined, catalog));
    if (!check.ok) {
      setError({ field: check.field, text: check.message });
      return;
    }
    if (check.empty) {
      toast.show(t("edit.nothing"), "info");
      onClose();
      return;
    }
    mutation.mutate(
      { op: "edit", task: task.id, hash: base.hash, changes: check.changes },
      {
        onSuccess: () => {
          toast.show(t("edit.saved", { id: task.id }), "success");
          onClose();
        },
        onError: (err) => {
          if (err instanceof ApiError && err.unauthorized) return;
          setError({ text: errorText(err, { id: task.id }) });
        },
      },
    );
  };
  const rebase = () => {
    const next = rebaseDraft(draft, base, task);
    setDraft(next.draft);
    setClashes(next.clashes);
    setBase(task);
    setError(null);
  };
  const discard = () => {
    setDraft(draftFrom(task));
    setClashes([]);
    setBase(task);
    setError(null);
  };
  const fieldError = (field: DraftField) => (error?.field === field ? error.text : undefined);

  return (
    <form
      className="b-edit a-stack"
      onSubmit={submit}
      aria-label={t("edit.title", { id: task.id })}
    >
      {changedOutside && (
        <section className="a-callout a-callout--warn" role="alert">
          <p className="a-callout__text">
            <b>{t("edit.changed.title")}</b> {t("edit.changed.text")}
          </p>
          <ChangedOutside base={draftFrom(base)} current={draftFrom(task)} />
          <div className="a-actions">
            <Button size="sm" variant="primary" onClick={rebase}>
              {t("edit.changed.rebase")}
            </Button>
            <Button size="sm" variant="ghost" onClick={discard}>
              {t("edit.changed.discard")}
            </Button>
          </div>
        </section>
      )}
      {!changedOutside && clashes.length > 0 && (
        <p className="a-callout a-callout--warn a-callout__text" role="status">
          {t("edit.changed.clash", { fields: clashes.map((f) => t(FIELD_NAME[f])).join(", ") })}
        </p>
      )}
      <Field
        label={t("edit.field.title")}
        value={draft.title}
        maxLength={120}
        required
        error={fieldError("title")}
        onChange={(e) => set("title", e.target.value)}
      />
      <Field
        multiline
        rows={8}
        label={t("edit.field.desc")}
        hint={t("edit.field.desc.hint")}
        value={draft.desc}
        error={fieldError("desc")}
        onChange={(e) => set("desc", e.target.value)}
      />
      <Criteria
        rows={draft.acceptance}
        error={fieldError("acceptance")}
        onChange={(rows) => set("acceptance", rows)}
        onRow={setRow}
      />
      <Field
        label={t("edit.field.labels")}
        hint={t("edit.field.labels.hint")}
        value={draft.labels}
        onChange={(e) => set("labels", e.target.value)}
      />
      <GroupSelect
        groups={groups}
        value={draft.group}
        error={fieldError("group")}
        onChange={(value) => set("group", value)}
      />
      <label className="k-field">
        <span className="k-field__label">{t("difficulty.label")}</span>
        <select
          className="k-field__control"
          value={draft.difficulty}
          onChange={(e) => set("difficulty", e.target.value as Draft["difficulty"])}
        >
          <option value="">{t("difficulty.none")}</option>
          {DifficultySchema.options.map((d) => (
            <option key={d} value={d}>
              {t(`difficulty.${d}`)}
            </option>
          ))}
        </select>
      </label>
      <div className="k-field">
        {!(draft.agent && catalog) && <span className="k-field__label">{t("agent.edit")}</span>}
        {draft.agent ? (
          catalog ? (
            <AgentPicker
              label={t("agent.edit")}
              agent={draft.agent}
              catalog={catalog}
              onChange={(agent) => set("agent", agent)}
            />
          ) : (
            <p className="k-mono">{agentText(draft.agent)}</p>
          )
        ) : (
          <div className="a-actions">
            <span className="s-muted">
              {t("agent.edit.inherit", { agent: defaults ? agentText(defaults) : "—" })}
            </span>
            {catalog && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => set("agent", initialAgent({}, { defaults }, catalog) ?? null)}
              >
                {t("agent.edit.set")}
              </Button>
            )}
          </div>
        )}
        {fieldError("agent") && (
          <span className="k-field__error" role="alert">
            {fieldError("agent")}
          </span>
        )}
      </div>
      {error && !error.field && (
        <p className="k-field__error" role="alert">
          {error.text}
        </p>
      )}
      <div className="a-actions">
        <Button type="submit" variant="primary" busy={mutation.isPending} disabled={changedOutside}>
          {t("edit.save")}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t("edit.cancel")}
        </Button>
      </div>
    </form>
  );
}

function Criteria({
  rows,
  error,
  onChange,
  onRow,
}: {
  rows: Draft["acceptance"];
  error: string | undefined;
  onChange: (rows: Draft["acceptance"]) => void;
  onRow: (index: number, row: Partial<Draft["acceptance"][number]>) => void;
}) {
  const label = useId();
  return (
    <fieldset className="b-edit__criteria" aria-labelledby={label}>
      <legend id={label} className="k-field__label">
        {t("edit.field.acceptance")}
      </legend>
      {rows.map((row, index) => (
        <div key={row.id ?? `new-${index}`} className="b-edit__criterion">
          <Field
            label={t("edit.criterion.text", { n: row.id ?? index + 1 })}
            value={row.text}
            maxLength={500}
            onChange={(e) => onRow(index, { text: e.target.value })}
          />
          <Field
            mono
            label={t("edit.criterion.check", { n: row.id ?? index + 1 })}
            value={row.check}
            onChange={(e) => onRow(index, { check: e.target.value })}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            ✕
            <span className="k-visually-hidden">
              {t("edit.criterion.remove", { n: row.id ?? index + 1 })}
            </span>
          </Button>
        </div>
      ))}
      {error && (
        <p className="k-field__error" role="alert">
          {error}
        </p>
      )}
      <div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onChange([...rows, { text: "", check: "" }])}
        >
          {t("edit.criterion.add")}
        </Button>
      </div>
    </fieldset>
  );
}

function GroupSelect({
  groups,
  value,
  error,
  onChange,
}: {
  groups: readonly { id: string; name: string }[];
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="k-field">
      <label htmlFor={id} className="k-field__label">
        {t("edit.field.group")}
      </label>
      <select
        id={id}
        className="k-field__control"
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        {groups.map((group) => (
          <option key={group.id} value={group.id}>
            {group.id} · {group.name}
          </option>
        ))}
      </select>
      {error && <span className="k-field__error">{error}</span>}
    </div>
  );
}

/** Adds and removes dependencies right away (depend / undepend), each conditioned on the task. */
export function DependencyEditor({
  projectId,
  task,
  doc,
}: {
  projectId: string;
  task: BoardTask;
  doc: TasksDocument;
}) {
  const [on, setOn] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const mutation = useEditTask(projectId);
  const toast = useToast();
  const listId = useId();
  const run = (op: "depend" | "undepend", target: string) =>
    mutation.mutate(
      { op, task: task.id, hash: task.hash, on: target },
      {
        onSuccess: () => {
          toast.show(
            t(op === "depend" ? "edit.deps.added" : "edit.deps.removed", {
              id: task.id,
              on: target,
            }),
            "success",
          );
          if (op === "depend") setOn("");
          setProblem(null);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.unauthorized) return;
          setProblem(errorText(err, { id: task.id, on: target }));
        },
      },
    );
  const add = (event: FormEvent) => {
    event.preventDefault();
    const target = on.trim().toUpperCase();
    const why = dependencyProblem(doc, task.id, target);
    if (why) setProblem(why);
    else run("depend", target);
  };
  const candidates = doc.tasks.filter((x) => x.id !== task.id && !(task.deps ?? []).includes(x.id));
  return (
    <div className="b-deps a-stack">
      {(task.deps ?? []).length > 0 && (
        <ul className="b-deps__remove">
          {(task.deps ?? []).map((dep) => (
            <li key={dep}>
              <Button
                size="sm"
                variant="ghost"
                busy={
                  mutation.isPending &&
                  mutation.variables?.op === "undepend" &&
                  "on" in mutation.variables &&
                  mutation.variables.on === dep
                }
                onClick={() => run("undepend", dep)}
              >
                ✕ {t("edit.deps.remove", { on: dep })}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className="b-deps__add" onSubmit={add}>
        <Field
          mono
          label={t("edit.deps.label")}
          placeholder={t("edit.deps.placeholder")}
          list={listId}
          value={on}
          error={problem ?? undefined}
          onChange={(e) => {
            setOn(e.target.value);
            setProblem(null);
          }}
        />
        <datalist id={listId}>
          {candidates.map((x) => (
            <option key={x.id} value={x.id}>
              {x.title}
            </option>
          ))}
        </datalist>
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          busy={mutation.isPending && mutation.variables?.op === "depend"}
        >
          {t("edit.deps.add")}
        </Button>
      </form>
    </div>
  );
}
