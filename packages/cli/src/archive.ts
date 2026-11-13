/**
 * `konsora archive --before <date>` (CORE-18): moves the done tasks finished before a date to
 * `.konsora/archive.json`, so the plan agents read stops growing. Preview by default; `--write`
 * applies it. Their ids stay in the plan (`archived`): dependencies on them still count as done.
 */
import { relative } from "node:path";
import { ARCHIVE_FILE, archiveTasks, KONSORA_DIR, tasksPath } from "@konsora/core/store";
import type { Command } from "commander";
import { issuesText } from "./format.ts";
import { CliError, EXIT, type Io, json, locate, storeError } from "./shared.ts";

/** `2026-11-01` (start of that day, UTC) or a full UTC timestamp → ISO UTC with seconds. */
export function parseBefore(value: string): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  const date = new Date(day);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(day) || Number.isNaN(date.getTime()))
    throw new CliError(
      `Invalid date "${value}".`,
      "Use YYYY-MM-DD (start of that day, UTC) or a UTC timestamp like 2026-11-01T12:00:00Z.",
      EXIT.usage,
    );
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function registerArchive(program: Command, io: Io, rootOption: () => string | undefined) {
  program
    .command("archive")
    .description(
      `move done tasks finished before a date to ${KONSORA_DIR}/${ARCHIVE_FILE} — preview by default`,
    )
    .requiredOption("--before <date>", "YYYY-MM-DD (UTC) or a UTC timestamp")
    .option("--write", "apply it (otherwise only shows what would move)")
    .option("--json", "machine-readable output")
    .action(async (opts: { before: string; write?: boolean; json?: boolean }) => {
      const before = parseBefore(opts.before);
      const root = locate(io, rootOption());
      const result = await archiveTasks(root, before, { write: Boolean(opts.write) });
      if (!result.ok) {
        if (result.error.file === "archive")
          throw new CliError(
            `${result.error.message}${result.error.issues ? `:\n${issuesText(result.error.issues).trimEnd()}` : ""}`,
          );
        storeError(result.error, root);
      }
      const { moved } = result as Extract<typeof result, { ok: true }>;
      const written = Boolean(opts.write) && moved.length > 0;
      if (opts.json) {
        json(io, { ok: true, before, archived: written, moved });
        return;
      }
      const rel = (p: string) => relative(io.cwd, p) || p;
      const file = rel(tasksPath(root)).replace(/tasks\.json$/, ARCHIVE_FILE);
      if (moved.length === 0) {
        io.stdout(`No done tasks finished before ${before}; nothing to archive.\n`);
        return;
      }
      const lines = [
        written
          ? `Archived ${moved.length} done task(s) finished before ${before} to ${file}:`
          : `Archive preview: ${moved.length} done task(s) finished before ${before} would move to ${file}:`,
        ...moved.map((e) => `  ${e.id.padEnd(9)} ${e.at.slice(0, 10)}  ${e.title}`),
        "",
        written
          ? "Their ids stay in tasks.json (archived): dependencies on them still count as done, and `konsora show` and the History still find them."
          : `Nothing was written. Run \`konsora archive --before ${opts.before} --write\` to apply it.`,
      ];
      io.stdout(`${lines.join("\n")}\n`);
    });
}
