import { type OrphanWorktree, useOrphans } from "../api/runs.ts";
import { t } from "../i18n/index.ts";
import { folderName } from "./run-model.ts";

/** What an orphan list shows: folder names and branches, never the user's private paths. */
export function OrphanList({ orphans }: { orphans: readonly OrphanWorktree[] }) {
  if (orphans.length === 0) return null;
  return (
    <section className="a-callout b-orphans" aria-label={t("orphans.label")}>
      <p className="a-callout__text">
        <b>{t("orphans.title", { n: orphans.length })}</b>
      </p>
      <ul className="b-approvals__list">
        {orphans.map((orphan) => (
          <li key={`${orphan.worktree ?? ""}|${orphan.branch ?? ""}`}>
            {orphan.branch && <span className="k-mono">{orphan.branch}</span>}
            {orphan.branch && orphan.worktree && " · "}
            {orphan.worktree && <span className="k-mono">{folderName(orphan.worktree)}</span>}{" "}
            <span className="s-muted">({t(`orphans.reason.${orphan.reason}`)})</span>
          </li>
        ))}
      </ul>
      <p className="s-muted">{t("orphans.hint")}</p>
    </section>
  );
}

/** The project's orphan worktrees and branches, if any (read-only notice). */
export function Orphans({ projectId }: { projectId: string }) {
  const orphans = useOrphans(projectId).data ?? [];
  return <OrphanList orphans={orphans} />;
}
