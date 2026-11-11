import {
  type Block,
  BlockIdSchema,
  blockProgress,
  DEFAULT_BASE_BRANCH,
  type TasksDocument,
} from "@konsora/core";
import { type FormEvent, useId, useState } from "react";
import { type BoardTask, useGitInfo, useMergeBlock, useProjectOp } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { Button, Field, Panel, StateBadge, useToast } from "../ui/index.ts";
import { opErrorText } from "./board-model.ts";

const STATUS: Record<"open" | "ready" | "merged", MessageKey> = {
  open: "blocks.status.open",
  ready: "blocks.status.ready",
  merged: "blocks.status.merged",
};

/** Spanish text for a refused merge; the conflicting files go below it. */
export function mergeErrorText(code: string, block: Block, message: string): string {
  switch (code) {
    case "git_conflict":
      return t("blocks.merge.error.conflict", { branch: block.branch, base: block.base });
    case "git_dirty":
      return t("blocks.merge.error.dirty", { base: block.base });
    case "git_no_branch":
      return t("blocks.merge.error.no_branch", { branch: block.branch });
    case "git_no_base":
      return t("blocks.merge.error.no_base", { base: block.base });
    case "git_nothing_to_merge":
      return t("blocks.merge.error.nothing", { branch: block.branch, base: block.base });
    case "git_not_a_repo":
      return t("blocks.merge.error.not_a_repo");
    case "block_not_ready":
      return t("blocks.merge.error.not_ready", { name: block.name });
    default:
      return t("blocks.merge.error.other", { message });
  }
}

/** Creates a block: id, name, branch (default konsora/<id>) and the base it merges into. */
function NewBlock({ projectId, doc }: { projectId: string; doc: TasksDocument }) {
  const git = useGitInfo(projectId);
  const save = useProjectOp(projectId);
  const toast = useToast();
  const listId = useId();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const baseValue = base || git.data?.branch || DEFAULT_BASE_BRANCH;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const slug = id.trim().toLowerCase();
    if (!BlockIdSchema.safeParse(slug).success) return setError(t("blocks.error.id"));
    if (doc.blocks?.some((b) => b.id === slug))
      return setError(t("blocks.error.id.twice", { id: slug }));
    if (!name.trim()) return setError(t("blocks.error.name"));
    save.mutate(
      {
        op: "add-block",
        id: slug,
        name: name.trim(),
        base: baseValue.trim(),
        ...(branch.trim() ? { branch: branch.trim() } : {}),
      },
      {
        onSuccess: () => {
          toast.show(t("blocks.created", { id: slug }), "success");
          setId("");
          setName("");
          setBranch("");
          setError(null);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.unauthorized) return;
          setError(t("blocks.error.other", { message: err.message }));
        },
      },
    );
  };
  const slug = id.trim().toLowerCase();
  return (
    <form className="a-stack b-blocks__new" onSubmit={submit} noValidate>
      <div className="b-blocks__row">
        <Field mono label={t("blocks.id")} value={id} onChange={(e) => setId(e.target.value)} />
        <Field label={t("blocks.name")} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="b-blocks__row">
        <Field
          mono
          label={t("blocks.branch")}
          placeholder={t("blocks.branch.placeholder", { id: slug || "id" })}
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        />
        <Field
          mono
          label={t("blocks.base")}
          hint={t("blocks.base.hint")}
          list={listId}
          value={base}
          placeholder={git.data?.branch ?? DEFAULT_BASE_BRANCH}
          onChange={(e) => setBase(e.target.value)}
        />
        <datalist id={listId}>
          {(git.data?.branches ?? []).map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
      </div>
      {error && (
        <p className="k-field__error" role="alert">
          {error}
        </p>
      )}
      <div className="a-actions">
        <Button type="submit" variant="primary" busy={save.isPending}>
          {t("blocks.create")}
        </Button>
      </div>
    </form>
  );
}

function BlockCard({
  projectId,
  block,
  doc,
  tasks,
  readOnly,
  onOpen,
}: {
  projectId: string;
  block: Block;
  doc: TasksDocument;
  tasks: readonly BoardTask[];
  readOnly: boolean;
  onOpen: (id: string) => void;
}) {
  const progress = blockProgress(doc, block.id);
  const merge = useMergeBlock(projectId);
  const remove = useProjectOp(projectId);
  const toast = useToast();
  const [strategy, setStrategy] = useState<"squash" | "merge">("squash");
  const [problem, setProblem] = useState<{ text: string; files: string[] } | null>(null);
  const strategyId = useId();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const doMerge = () => {
    if (!window.confirm(t("blocks.merge.confirm", { branch: block.branch, base: block.base })))
      return;
    merge.mutate(
      { block: block.id, strategy },
      {
        onSuccess: (result) => {
          setProblem(null);
          toast.show(
            t("blocks.merge.done", { name: block.name, commit: result.commit.slice(0, 12) }),
            "success",
          );
        },
        onError: (error) => {
          if (error instanceof ApiError && error.unauthorized) return;
          const code = error instanceof ApiError ? error.code : "error";
          const files = error instanceof ApiError ? (error.details.files ?? []) : [];
          setProblem({ text: mergeErrorText(code, block, error.message), files });
        },
      },
    );
  };
  const doDelete = () => {
    if (!window.confirm(t("blocks.delete.confirm", { name: block.name }))) return;
    remove.mutate(
      { op: "delete-block", block: block.id },
      {
        onSuccess: () => toast.show(t("blocks.deleted", { name: block.name }), "success"),
        onError: (error) => {
          if (error instanceof ApiError && error.unauthorized) return;
          const code = error instanceof ApiError ? error.code : "error";
          toast.show(opErrorText(code, block.id, error.message), "error");
        },
      },
    );
  };
  return (
    <li className={`b-blocks__item b-blocks__item--${progress.status}`}>
      <div className="b-blocks__head">
        <h3 className="b-blocks__title">{block.name}</h3>
        <span className="a-chip k-mono">{block.id}</span>
        <span className={`b-blocks__status b-blocks__status--${progress.status}`}>
          {t(STATUS[progress.status])}
        </span>
      </div>
      <p className="s-text k-mono">
        {block.branch} → {block.base} ·{" "}
        {t("blocks.progress", { done: progress.done, total: progress.tasks.length })}
        {block.merged && ` · ${block.merged.commit.slice(0, 12)} (${block.merged.strategy})`}
      </p>
      {progress.tasks.length === 0 ? (
        <p className="s-muted">{t("blocks.empty")}</p>
      ) : (
        <ul className="a-deps">
          {progress.tasks.map((id) => {
            const task = byId.get(id);
            return (
              <li key={id}>
                <button type="button" className="a-link" onClick={() => onOpen(id)}>
                  {id}
                </button>{" "}
                {task?.title}
                {task && <StateBadge kind={task.state} />}
              </li>
            );
          })}
        </ul>
      )}
      {problem && (
        <div className="a-callout a-callout--warn" role="alert">
          <p className="a-callout__text">{problem.text}</p>
          {problem.files.length > 0 && (
            <ul className="k-mono">
              {problem.files.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {!readOnly && !block.merged && (
        <div className="a-actions">
          {progress.status === "ready" && (
            <>
              <label htmlFor={strategyId} className="k-visually-hidden">
                {t("blocks.merge.strategy")}
              </label>
              <select
                id={strategyId}
                className="k-field__control b-blocks__strategy"
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as "squash" | "merge")}
              >
                <option value="squash">{t("blocks.merge.squash")}</option>
                <option value="merge">{t("blocks.merge.merge")}</option>
              </select>
              <Button variant="primary" busy={merge.isPending} onClick={doMerge}>
                {t("blocks.merge", { base: block.base })}
              </Button>
            </>
          )}
          <Button variant="ghost" busy={remove.isPending} onClick={doDelete}>
            {t("blocks.delete")}
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * The project's blocks: tasks worked on one branch. When all are done, the human merges the
 * branch into its base here (locally, never pushed).
 */
export function BlocksView({
  projectId,
  doc,
  tasks,
  readOnly,
  onOpen,
}: {
  projectId: string;
  doc: TasksDocument;
  tasks: readonly BoardTask[];
  readOnly: boolean;
  onOpen: (id: string) => void;
}) {
  const blocks = doc.blocks ?? [];
  return (
    <div className="s-stack">
      <Panel title={t("blocks.title")}>
        <p className="s-text s-muted">{t("blocks.text")}</p>
        {blocks.length === 0 ? (
          <p className="s-text">{t("blocks.none.yet")}</p>
        ) : (
          <ul className="b-blocks">
            {blocks.map((block) => (
              <BlockCard
                key={block.id}
                projectId={projectId}
                block={block}
                doc={doc}
                tasks={tasks}
                readOnly={readOnly}
                onOpen={onOpen}
              />
            ))}
          </ul>
        )}
      </Panel>
      {!readOnly && (
        <Panel title={t("blocks.new")}>
          <NewBlock projectId={projectId} doc={doc} />
        </Panel>
      )}
    </div>
  );
}
