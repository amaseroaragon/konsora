import { type CSSProperties, Fragment, type ReactNode } from "react";
import { t } from "../i18n/index.ts";
import { cx } from "./cx.ts";
import { stateLabel, type TaskState } from "./StateBadge.tsx";

export type MatrixLane = {
  id: string;
  name: string;
  /** Extra line under the name (e.g. the group's accumulated cost). */
  meta?: string | undefined;
  /** One cell per column, in the same order as `columns`. */
  cells: readonly ReactNode[];
  /**
   * Folded to its head (UI-32): its cells stay (they still take drops) and show only how many
   * tasks each holds, from `counts`.
   */
  collapsed?: boolean | undefined;
  /** Offers the fold/unfold button in the lane's head. */
  onToggle?: (() => void) | undefined;
  /** Tasks per column, shown while folded. */
  counts?: readonly number[] | undefined;
};

export type MatrixCellProps = {
  lane: string;
  state: TaskState;
  /** Accessible name of the cell ("Backend · Por hacer"). */
  label: string;
  className: string;
  children: ReactNode;
};

export type MatrixColumn = {
  state: TaskState;
  count: number;
  /** Folded to a narrow strip: its cells are kept (they still take drops) but show nothing. */
  collapsed?: boolean | undefined;
  /** Offers the fold/unfold button in the column's head. */
  onToggle?: (() => void) | undefined;
};

/** Width of an open and a folded column, and of the lane names, for the board's minimum width. */
const OPEN_PX = 230;
const FOLDED_PX = 48;
const LANE_PX = 120;

export type MatrixProps = {
  columns: readonly MatrixColumn[];
  lanes: readonly MatrixLane[];
  /** Accessible name for the whole board. */
  label: string;
  /** Custom cell (e.g. a drop target); it must render `className`, `label` and `children`. */
  renderCell?: (props: MatrixCellProps) => ReactNode;
};

function PlainCell({ label, className, children }: MatrixCellProps) {
  return (
    <section className={className} aria-label={label}>
      {children}
    </section>
  );
}

/** Group × state grid on blueprint paper: sticky state headers, one lane per group. */
export function Matrix({ columns, lanes, label, renderCell = PlainCell }: MatrixProps) {
  const style = {
    "--k-matrix-cols": columns.length,
    gridTemplateColumns: `${LANE_PX}px ${columns
      .map((column) => (column.collapsed ? `${FOLDED_PX}px` : "minmax(180px, 1fr)"))
      .join(" ")}`,
    "--k-matrix-min": `${columns.reduce(
      (sum, column) => sum + (column.collapsed ? FOLDED_PX : OPEN_PX),
      LANE_PX,
    )}px`,
  } as CSSProperties;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a CSS grid of regions, not tabular data.
    <div className="k-matrix" style={style} role="group" aria-label={label}>
      <div className="k-matrix__head k-label" aria-hidden="true" />
      {columns.map((column) => (
        <div
          key={column.state}
          className={cx("k-matrix__head", column.collapsed && "k-matrix__head--collapsed")}
        >
          <span className={`k-state-mark k-state-mark--${column.state}`} aria-hidden="true" />
          <span className="k-label k-matrix__name" style={{ color: "var(--k-ink)" }}>
            {stateLabel(column.state)}
          </span>
          <span className="k-matrix__count">{column.count}</span>
          {column.onToggle && (
            <button
              type="button"
              className="k-matrix__fold"
              aria-expanded={!column.collapsed}
              aria-label={t(column.collapsed ? "board.column.unfold" : "board.column.fold", {
                state: stateLabel(column.state),
              })}
              title={t(column.collapsed ? "board.column.unfold" : "board.column.fold", {
                state: stateLabel(column.state),
              })}
              onClick={column.onToggle}
            >
              <span aria-hidden="true">{column.collapsed ? "»" : "«"}</span>
            </button>
          )}
        </div>
      ))}
      {lanes.map((lane) => (
        <Lane key={lane.id} lane={lane} columns={columns} renderCell={renderCell} />
      ))}
    </div>
  );
}

function Lane({
  lane,
  columns,
  renderCell,
}: {
  lane: MatrixLane;
  columns: MatrixProps["columns"];
  renderCell: (props: MatrixCellProps) => ReactNode;
}) {
  return (
    <>
      <div className={cx("k-matrix__lane", lane.collapsed && "k-matrix__lane--collapsed")}>
        <div className="k-matrix__lane-head">
          <div className="k-matrix__lane-id">{lane.id}</div>
          {lane.onToggle && (
            <button
              type="button"
              className="k-matrix__fold"
              aria-expanded={!lane.collapsed}
              aria-label={t(lane.collapsed ? "board.lane.unfold" : "board.lane.fold", {
                name: lane.name,
              })}
              title={t(lane.collapsed ? "board.lane.unfold" : "board.lane.fold", {
                name: lane.name,
              })}
              onClick={lane.onToggle}
            >
              <span aria-hidden="true">{lane.collapsed ? "▸" : "▾"}</span>
            </button>
          )}
        </div>
        <div className="k-matrix__lane-name">{lane.name}</div>
        {lane.meta && <div className="k-matrix__lane-meta">{lane.meta}</div>}
      </div>
      {columns.map((column, index) => (
        <Fragment key={column.state}>
          {renderCell({
            lane: lane.id,
            state: column.state,
            label: `${lane.name} · ${stateLabel(column.state)}`,
            className: cx(
              "k-matrix__cell",
              column.collapsed && "k-matrix__cell--collapsed",
              lane.collapsed && "k-matrix__cell--folded",
            ),
            children: column.collapsed ? null : lane.collapsed ? (
              <span className="k-matrix__folded-count">
                {t("board.lane.count", { n: lane.counts?.[index] ?? 0 })}
              </span>
            ) : (
              lane.cells[index]
            ),
          })}
        </Fragment>
      ))}
    </>
  );
}
