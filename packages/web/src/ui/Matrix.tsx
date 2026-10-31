import { type CSSProperties, Fragment, type ReactNode } from "react";
import { stateLabel, type TaskState } from "./StateBadge.tsx";

export type MatrixLane = {
  id: string;
  name: string;
  /** One cell per column, in the same order as `columns`. */
  cells: readonly ReactNode[];
};

export type MatrixCellProps = {
  lane: string;
  state: TaskState;
  /** Accessible name of the cell ("Backend · Por hacer"). */
  label: string;
  className: string;
  children: ReactNode;
};

export type MatrixProps = {
  columns: readonly { state: TaskState; count: number }[];
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
  const style = { "--k-matrix-cols": columns.length } as CSSProperties;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a CSS grid of regions, not tabular data.
    <div className="k-matrix" style={style} role="group" aria-label={label}>
      <div className="k-matrix__head k-label" aria-hidden="true" />
      {columns.map((column) => (
        <div key={column.state} className="k-matrix__head">
          <span className={`k-state-mark k-state-mark--${column.state}`} aria-hidden="true" />
          <span className="k-label" style={{ color: "var(--k-ink)" }}>
            {stateLabel(column.state)}
          </span>
          <span className="k-matrix__count">{column.count}</span>
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
      <div className="k-matrix__lane">
        <div className="k-matrix__lane-id">{lane.id}</div>
        <div className="k-matrix__lane-name">{lane.name}</div>
      </div>
      {columns.map((column, index) => (
        <Fragment key={column.state}>
          {renderCell({
            lane: lane.id,
            state: column.state,
            label: `${lane.name} · ${stateLabel(column.state)}`,
            className: "k-matrix__cell",
            children: lane.cells[index],
          })}
        </Fragment>
      ))}
    </>
  );
}
