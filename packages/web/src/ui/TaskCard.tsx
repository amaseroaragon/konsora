import { t } from "../i18n/index.ts";
import { cx } from "./cx.ts";
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
  /** In review with its run's checks failing. */
  checksFailed?: boolean;
  /** Its run waits for the human to approve something. */
  awaitingApproval?: boolean;
  /** Elapsed time of the active run, e.g. "4:12". */
  running?: string;
  /** "claude · opus · alto" */
  agent?: string;
  /** The task's estimated difficulty, as shown: "Dificultad alta". */
  difficulty?: string;
  proposedBy?: string;
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
  checksFailed = false,
  awaitingApproval = false,
  running,
  agent,
  difficulty,
  proposedBy,
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
        state === "review" && "k-card--review",
        blocked && "k-card--blocked",
        running && "k-card--running",
        external && "k-card--external",
        checksFailed && "k-card--checks",
        awaitingApproval && "k-card--approval",
        selected && "k-card--selected",
      )}
    >
      <div className="k-card__head">
        <span className="k-card__id">{id}</span>
        {running && <StateBadge kind="running" label={running} />}
        {blocked && (
          <StateBadge kind="blocked" label={t("card.blockedBy", { ids: blockedBy.join(", ") })} />
        )}
        {ready && <StateBadge kind="ready" />}
        {waiting && <StateBadge kind="waiting" />}
        {external && <StateBadge kind="external" />}
        {checksFailed && <StateBadge kind="checks" />}
        {awaitingApproval && <StateBadge kind="approval" />}
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
      {(agent || difficulty) && (
        <div className="k-card__meta">
          {difficulty && <span className="k-card__difficulty">{difficulty}</span>}
          {agent && <span>{agent}</span>}
        </div>
      )}
    </article>
  );
}
