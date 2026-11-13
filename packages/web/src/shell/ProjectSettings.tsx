import type { TasksDocument } from "@konsora/core";
import { type FormEvent, useState } from "react";
import { useProjectOp } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { Button, Field, Panel, useToast } from "../ui/index.ts";
import { groupUse, moveGroup, newGroupIdError } from "./project-settings-model.ts";

/** Sends one op and reports it with a toast; `onSuccess` runs once it is saved. */
function useSettingsOp(projectId: string) {
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
            ? t("groups.error.inUse")
            : code === "forbidden"
              ? t("settings.error.forbidden")
              : t("settings.error.other", { message: error.message }),
          "error",
        );
      },
    });
  return { send, busy: mutation.isPending };
}

function ProjectName({
  projectId,
  name,
  disabled,
}: {
  projectId: string;
  name: string;
  disabled: boolean;
}) {
  const [value, setValue] = useState(name);
  const { send, busy } = useSettingsOp(projectId);
  const changed = value.trim() !== name && value.trim() !== "";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (changed) send({ op: "rename-project", name: value.trim() }, "project.name.saved");
  };
  return (
    <form className="b-settings__inline" onSubmit={submit}>
      <Field
        label={t("project.name")}
        value={value}
        maxLength={80}
        disabled={disabled || busy}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="b-settings__row-actions">
        <Button type="submit" size="sm" variant="secondary" busy={busy} disabled={!changed}>
          {t("project.name.save")}
        </Button>
      </div>
    </form>
  );
}

function GroupRow({
  projectId,
  group,
  index,
  ids,
  uses,
  disabled,
}: {
  projectId: string;
  group: { id: string; name: string };
  index: number;
  ids: readonly string[];
  /** Tasks that keep the group in use: while any, it cannot be removed. */
  uses: number;
  disabled: boolean;
}) {
  const [name, setName] = useState(group.name);
  const { send, busy } = useSettingsOp(projectId);
  const changed = name.trim() !== group.name && name.trim() !== "";
  const off = disabled || busy;
  const reorder = (by: -1 | 1) =>
    send({ op: "reorder-groups", ids: moveGroup(ids, index, by) }, "groups.reordered");
  return (
    <li className="b-settings__group">
      <span className="k-mono b-settings__group-id">{group.id}</span>
      <form
        className="b-settings__inline"
        onSubmit={(event) => {
          event.preventDefault();
          if (changed)
            send({ op: "rename-group", id: group.id, name: name.trim() }, "groups.renamed");
        }}
      >
        <Field
          label={t("groups.name", { id: group.id })}
          hideLabel
          value={name}
          maxLength={60}
          disabled={off}
          onChange={(event) => setName(event.target.value)}
        />
        <div className="b-settings__row-actions">
          <Button type="submit" size="sm" variant="secondary" disabled={off || !changed}>
            {t("groups.rename")}
          </Button>
        </div>
      </form>
      <span className="s-text s-muted b-settings__group-use">
        {uses === 0
          ? t("groups.empty")
          : t(uses === 1 ? "groups.uses.one" : "groups.uses.many", { n: uses })}
      </span>
      <div className="b-settings__row-actions">
        <Button size="sm" variant="ghost" disabled={off || index === 0} onClick={() => reorder(-1)}>
          ↑<span className="k-visually-hidden">{t("groups.up", { id: group.id })}</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={off || index === ids.length - 1}
          onClick={() => reorder(1)}
        >
          ↓<span className="k-visually-hidden">{t("groups.down", { id: group.id })}</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={off || uses > 0 || ids.length === 1}
          title={uses > 0 ? t("groups.remove.inUse") : undefined}
          onClick={() => send({ op: "remove-group", id: group.id }, "groups.removed")}
        >
          ✕<span className="k-visually-hidden">{t("groups.remove", { id: group.id })}</span>
        </Button>
      </div>
    </li>
  );
}

function AddGroup({
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
  const [error, setError] = useState<MessageKey | undefined>();
  const { send, busy } = useSettingsOp(projectId);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const key = id.trim().toUpperCase();
    const problem = newGroupIdError(key, ids);
    setError(problem);
    if (problem || !name.trim()) return;
    send({ op: "add-group", id: key, name: name.trim() }, "groups.added", () => {
      setId("");
      setName("");
    });
  };
  return (
    <form className="b-settings__add-group" onSubmit={submit} noValidate>
      <Field
        mono
        label={t("groups.new.id")}
        hint={t("groups.new.id.hint")}
        value={id}
        maxLength={6}
        disabled={disabled || busy}
        error={error ? t(error) : undefined}
        onChange={(event) => setId(event.target.value)}
      />
      <Field
        label={t("groups.new.name")}
        value={name}
        maxLength={60}
        disabled={disabled || busy}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="b-settings__row-actions">
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          busy={busy}
          disabled={disabled || !id.trim() || !name.trim()}
        >
          {t("groups.add")}
        </Button>
      </div>
    </form>
  );
}

/**
 * The project's name and its groups (CORE-13): rename the project, and add, rename, reorder and
 * remove groups. Each change is one op, saved at once. A group's id never changes: it is the
 * prefix of its tasks' ids.
 */
export function ProjectSettings({
  projectId,
  plan,
  readOnly,
}: {
  projectId: string;
  plan: Pick<TasksDocument, "project" | "groups" | "tasks" | "archived">;
  readOnly: boolean;
}) {
  const ids = plan.groups.map((g) => g.id);
  return (
    <Panel title={t("project.settings.title")} eyebrow={t("settings.eyebrow")}>
      {/* Keyed by the saved name, so a change from elsewhere resets the field. */}
      <ProjectName
        key={plan.project.name}
        projectId={projectId}
        name={plan.project.name}
        disabled={readOnly}
      />
      <div className="a-stack">
        <div className="k-label">{t("groups.title")}</div>
        <p className="s-text s-muted">{t("groups.text")}</p>
        <ol className="b-settings__checks">
          {plan.groups.map((group, index) => (
            <GroupRow
              key={`${group.id}:${group.name}`}
              projectId={projectId}
              group={group}
              index={index}
              ids={ids}
              uses={groupUse(plan, group.id)}
              disabled={readOnly}
            />
          ))}
        </ol>
        <AddGroup projectId={projectId} ids={ids} disabled={readOnly} />
      </div>
    </Panel>
  );
}
