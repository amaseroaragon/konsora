import { t } from "../i18n/index.ts";
import { cx } from "./cx.ts";

/** A task's labels as chips; renders nothing when there are none. */
export function Labels({
  labels,
  className,
}: {
  labels: readonly string[] | undefined;
  className?: string;
}) {
  if (!labels || labels.length === 0) return null;
  return (
    <ul className={cx("k-labels", className)} aria-label={t("labels.label")}>
      {labels.map((label) => (
        <li key={label} className="k-labels__chip">
          {label}
        </li>
      ))}
    </ul>
  );
}
