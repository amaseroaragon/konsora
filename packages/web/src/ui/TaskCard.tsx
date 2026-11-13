import type { Difficulty } from "@konsora/core";
import { t } from "../i18n/index.ts";
import { cx } from "./cx.ts";
import { DifficultyMark } from "./DifficultyMark.tsx";
import { Labels } from "./Labels.tsx";
import { StateBadge, type TaskState } from "./StateBadge.tsx";

export type TaskCardProps = {
  id: string;
  title: string;
  state: TaskState;
  /** IDs of unfinished dependencies; non-empty means blocked. */
  blockedBy?: readonly string[];
  waiting?: boolean;
  /** An unapproved change made outside Konsora is pending on this task. */
  external?: boolean;
  proposedBy?: string;
  /** In progress with no recent activity: its agent's session may have died (CORE-10). */
  stale?: boolean;
  /** Who has the task in progress (CORE-09): an agent name, or «tú». */
  startedBy?: string | undefined;
  difficulty?: Difficulty | undefined;
  /** The task's labels, shown as chips under the title. */
  labels?: readonly string[] | undefined;
  selected?: boolean;
  /** Whether the checkbox can be ticked; defaults to ready tasks only. */
  selectable?: boolean;
  /** When provided, the card shows a selection checkbox. */
  onSelectedChange?: (selected: boolean) => void;
  onOpen?: () => void;
};

export function TaskCard({
  id,
  title,
  state,
  blockedBy = [],
  waiting = false,
  external = false,
  proposedBy,
  startedBy,
  stale = false,
  difficulty,
  labels = [],
  selected = false,
  selectable,
  onSelectedChange,
  onOpen,
}: TaskCardProps) {
  const blocked = state === "todo" && blockedBy.length > 0;
  const ready = state === "todo" && !blocked;
  const titleId = `task-${id}-title`;
  return (
    <article
      aria-labelledby={titleId}
      className={cx(
        "k-card",
        state === "proposed" && "k-card--proposed",
        blocked && "k-card--blocked",
        external && "k-card--external",
        selected && "k-card--selected",
      )}
    >
      <div className="k-card__head">
        <span className="k-card__id">{id}</span>
        {difficulty && <DifficultyMark difficulty={difficulty} />}
        {blocked && (
          <StateBadge kind="blocked" label={t("card.blockedBy", { ids: blockedBy.join(", ") })} />
        )}
        {ready && <StateBadge kind="ready" />}
        {waiting && <StateBadge kind="waiting" />}
        {state === "doing" && stale && <StateBadge kind="stale" />}
        {external && <StateBadge kind="external" />}
        {state === "doing" && startedBy && (
          <StateBadge kind="doing" label={t("card.startedBy", { actor: startedBy })} />
        )}
        {state === "proposed" && proposedBy && (
          <StateBadge kind="proposed" label={t("card.proposedBy", { actor: proposedBy })} />
        )}
        {onSelectedChange && (
          <input
            type="checkbox"
            className="k-card__select"
            checked={selected}
            disabled={!(selectable ?? ready)}
            aria-label={t("card.select", { id })}
            onChange={(event) => onSelectedChange(event.target.checked)}
          />
        )}
      </div>
      <h3 className="k-card__title" id={titleId}>
        {onOpen ? (
          <button
            type="button"
            className="k-card__open"
            onClick={onOpen}
            aria-label={`${t("card.open", { id })}: ${title}`}
          >
            {title}
          </button>
        ) : (
          title
        )}
      </h3>
      <Labels labels={labels} className="k-card__labels" />
    </article>
  );
}
