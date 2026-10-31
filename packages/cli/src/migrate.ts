/** `konsora migrate`: v1 (schema_version 1) → konsora/2. Dry-run unless --write. */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, relative } from "node:path";
import { isV1, migrateV1, parseJsonText, serializeDocument } from "@konsora/core";
import {
  BACKUP_V1_FILE,
  LEGACY_HISTORY_FILE,
  tasksPath,
  writeMigration,
} from "@konsora/core/store";
import type { Command } from "commander";
import { CliError, type Io, json, locate, timestamp } from "./shared.ts";

function gitBranch(cwd: string): string | undefined {
  try {
    const name = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

export function registerMigrate(program: Command, io: Io, rootOption: () => string | undefined) {
  program
    .command("migrate")
    .description("convert a v1 tasks.json (schema_version 1) to konsora/2 — preview by default")
    .option("--write", "apply the migration (backs up the original first)")
    .option("--name <name>", "project name (default: folder name)")
    .option("--base-branch <branch>", "base branch (default: current git branch, else main)")
    .option("--json", "machine-readable output")
    .action(
      async (opts: { write?: boolean; name?: string; baseBranch?: string; json?: boolean }) => {
        const root = locate(io, rootOption());
        const path = tasksPath(root);
        const text = await readFile(path, "utf8").catch(() => {
          throw new CliError(`No plan at ${path}.`, "Nothing to migrate.");
        });
        const parsed = parseJsonText(text);
        if (!parsed.ok)
          throw new CliError(`${path} is not valid JSON: ${parsed.issues[0]?.message}`);
        if ((parsed.value as { schema?: unknown }).schema === "konsora/2") {
          if (opts.json) json(io, { ok: true, migrated: false, reason: "already konsora/2" });
          else io.stdout("Already konsora/2; nothing to migrate.\n");
          return;
        }
        if (!isV1(parsed.value))
          throw new CliError(`${path} is neither konsora/2 nor v1 (schema_version 1).`);

        const result = migrateV1(parsed.value, {
          name: opts.name ?? basename(root),
          baseBranch: opts.baseBranch ?? gitBranch(root) ?? "main",
          at: timestamp(io),
        });
        if (!result.ok) throw new CliError(result.message);
        const { report } = result;
        const output = serializeDocument(result.document);
        const rel = (p: string) => relative(io.cwd, p) || p;
        const backupPath = `${rel(path)}`.replace(/tasks\.json$/, BACKUP_V1_FILE);
        const historyPath = `${rel(path)}`.replace(/tasks\.json$/, LEGACY_HISTORY_FILE);

        if (opts.write) {
          const written = await writeMigration(root, {
            expectedText: text,
            text: output,
            history: result.history,
          });
          if (!written.ok) {
            throw new CliError(
              written.error.message,
              written.error.code === "exists"
                ? "Move the old backup or history away and run again."
                : undefined,
            );
          }
        }
        if (opts.json) {
          json(io, {
            ok: true,
            migrated: Boolean(opts.write),
            report,
            ...(opts.write ? {} : { preview: result.document }),
          });
          return;
        }
        const lines = [
          `${opts.write ? "Migrated" : "Migration preview for"} ${rel(path)}: ${report.tasks} tasks, groups ${report.groups.join(", ")}`,
          "",
          "States:",
          ...Object.values(report.states).map(
            (s) => `  ${s.from.padEnd(11)} → ${s.to.padEnd(8)} ${s.count}`,
          ),
        ];
        if (report.renumbered.length)
          lines.push(
            "",
            "Renumbered ids:",
            ...report.renumbered.map((r) => `  ${r.from} → ${r.to}`),
          );
        if (report.criteriaInDescription.length) {
          lines.push(
            "",
            `Criteria kept in the description (over 500 chars): ${report.criteriaInDescription.join(", ")}`,
          );
        }
        lines.push(
          "",
          `History: ${report.history.attempts} attempts, ${report.history.activity} activity events, ${report.history.reviews} reviews → ${historyPath}`,
          `Backup of the original: ${backupPath}`,
          "",
          opts.write
            ? "Done. Review the result with `konsora status`."
            : "Nothing was written. Run `konsora migrate --write` to apply it.",
        );
        io.stdout(`${lines.join("\n")}\n`);
      },
    );
}
