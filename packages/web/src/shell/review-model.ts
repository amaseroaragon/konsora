/**
 * The review of a run's work (UI-12): its `diff.patch` split per file for `DiffView`, and the
 * Spanish explanation of what happened when accepting (integration commit or refusal).
 */
import { t } from "../i18n/index.ts";
import type { DiffFile, DiffLine } from "../ui/index.ts";

/** Path from a `--- a/x` or `+++ b/x` line (`/dev/null` for a side that does not exist). */
function sidePath(line: string): string | null {
  const raw = line.slice(4).replace(/\t.*$/, "");
  if (raw === "/dev/null") return null;
  return raw.replace(/^[ab]\//, "");
}

/** Splits a git unified diff into files with their hunks and +/− counts. */
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: { path: string; added: number; removed: number; lines: DiffLine[] } | null = null;
  let inHunk = false;
  const close = () => {
    if (current) files.push(current);
    current = null;
    inHunk = false;
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      close();
      const match = / b\/(.*)$/.exec(line);
      current = { path: match?.[1] ?? line.slice(11), added: 0, removed: 0, lines: [] };
      continue;
    }
    if (!current) continue;
    const file = current as { path: string; added: number; removed: number; lines: DiffLine[] };
    if (!inHunk) {
      if (line.startsWith("+++ ")) {
        const path = sidePath(line);
        if (path) file.path = path;
      } else if (line.startsWith("--- ")) {
        const path = sidePath(line);
        if (path) file.path = path;
      } else if (line.startsWith("rename to ")) {
        file.path = line.slice("rename to ".length);
      } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        file.lines.push({ kind: "hunk", text: t("review.binary") });
      }
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      file.lines.push({ kind: "hunk", text: line });
    } else if (inHunk) {
      if (line.startsWith("+")) {
        file.added++;
        file.lines.push({ kind: "add", text: line });
      } else if (line.startsWith("-")) {
        file.removed++;
        file.lines.push({ kind: "del", text: line });
      } else if (line.startsWith(" ")) {
        file.lines.push({ kind: "ctx", text: line });
      } else if (line.startsWith("\\")) {
        file.lines.push({ kind: "ctx", text: line });
      }
    }
  }
  close();
  return files;
}

export function diffTotals(files: readonly DiffFile[]): { added: number; removed: number } {
  return files.reduce(
    (sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }),
    { added: 0, removed: 0 },
  );
}

/** What the daemon answers to `accept` when it integrated a run first. */
export type AcceptResult = { integrated?: { run: string; commit: string } };

/** The toast after accepting: with the integration commit when there was a run. */
export function acceptText(id: string, result: AcceptResult | undefined): string {
  const commit = result?.integrated?.commit;
  return commit
    ? t("review.integrated", { id, sha: commit.slice(0, 7) })
    : t("move.done.accept", { id });
}

/**
 * Why accepting did not integrate (409 `integration_*`), in Spanish; `null` for other errors.
 * The task stays in review in every case.
 */
export function integrationErrorText(
  code: string,
  id: string,
  files: readonly string[] = [],
): string | null {
  if (!code.startsWith("integration_")) return null;
  const list = files.join(", ");
  switch (code) {
    case "integration_conflict":
      return list
        ? t("review.error.conflict.files", { id, files: list })
        : t("review.error.conflict", { id });
    case "integration_dirty":
      return t("review.error.dirty", { files: list });
    case "integration_moved":
      return t("review.error.moved");
    case "integration_nothing_to_integrate":
      return t("review.error.nothing", { id });
    case "integration_plan_changes":
      return t("review.error.plan", { id });
    case "integration_checked_out_elsewhere":
      return t("review.error.elsewhere");
    case "integration_base_branch_missing":
      return t("review.error.base");
    default:
      return t("review.error.other", { id });
  }
}
