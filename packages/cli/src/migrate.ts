/**
 * `konsora migrate`: v1 (schema_version 1), konsora/2, konsora/3 or konsora/4 → konsora/5.
 * Dry-run unless --write. From v2 it drops the run-only fields; from v2 and v3, review becomes
 * done and YOLO goes; from v2, v3 and v4, blocks go (their git branches are left alone).
 */
import { readFile } from "node:fs/promises";
import { basename, relative } from "node:path";
import {
  isV1,
  isV2,
  isV3,
  isV4,
  migratePlan,
  migrateV1,
  parseJsonText,
  SCHEMA_VERSION,
  serializeDocument,
} from "@konsora/core";
import {
  BACKUP_V1_FILE,
  BACKUP_V2_FILE,
  BACKUP_V3_FILE,
  BACKUP_V4_FILE,
  LEGACY_HISTORY_FILE,
  tasksPath,
  writeMigration,
} from "@konsora/core/store";
import type { Command } from "commander";
import { CliError, type Io, json, locate, timestamp } from "./shared.ts";

type Written = Awaited<ReturnType<typeof writeMigration>>;

function check(written: Written) {
  if (written.ok) return;
  throw new CliError(
    written.error.message,
    written.error.code === "exists"
      ? "Move the old backup or history away and run again."
      : undefined,
  );
}

export function registerMigrate(program: Command, io: Io, rootOption: () => string | undefined) {
  program
    .command("migrate")
    .description(
      `convert an older tasks.json (v1, konsora/2, konsora/3 or konsora/4) to ${SCHEMA_VERSION} — preview by default`,
    )
    .option("--write", "apply the migration (backs up the original first)")
    .option("--name <name>", "project name, for v1 plans (default: folder name)")
    .option("--json", "machine-readable output")
    .action(async (opts: { write?: boolean; name?: string; json?: boolean }) => {
      const root = locate(io, rootOption());
      const path = tasksPath(root);
      const text = await readFile(path, "utf8").catch(() => {
        throw new CliError(`No plan at ${path}.`, "Nothing to migrate.");
      });
      const parsed = parseJsonText(text);
      if (!parsed.ok) throw new CliError(`${path} is not valid JSON: ${parsed.issues[0]?.message}`);
      const rel = (p: string) => relative(io.cwd, p) || p;
      const sibling = (file: string) => rel(path).replace(/tasks\.json$/, file);

      if ((parsed.value as { schema?: unknown }).schema === SCHEMA_VERSION) {
        if (opts.json) json(io, { ok: true, migrated: false, reason: `already ${SCHEMA_VERSION}` });
        else io.stdout(`Already ${SCHEMA_VERSION}; nothing to migrate.\n`);
        return;
      }

      if (isV2(parsed.value) || isV3(parsed.value) || isV4(parsed.value)) {
        const result = migratePlan(parsed.value, { at: timestamp(io) });
        if (!result.ok) throw new CliError(result.message);
        const { report } = result;
        const from = report.from === "konsora/2" ? "v2" : report.from === "konsora/3" ? "v3" : "v4";
        if (opts.write) {
          check(
            await writeMigration(root, {
              expectedText: text,
              text: serializeDocument(result.document),
              from,
            }),
          );
        }
        if (opts.json) {
          json(io, {
            ok: true,
            from: report.from,
            migrated: Boolean(opts.write),
            report,
            ...(opts.write ? {} : { preview: result.document }),
          });
          return;
        }
        const dropped = Object.entries(report.dropped);
        const lines = [
          `${opts.write ? "Migrated" : "Migration preview for"} ${rel(path)}: ${report.from} → ${SCHEMA_VERSION}, ${report.tasks} tasks`,
          "",
          dropped.length ? "Dropped fields:" : "No fields to drop.",
          ...dropped.map(([field, count]) => `  ${field.padEnd(40)} ${count}`),
        ];
        if (report.reviewNotes)
          lines.push(
            "",
            `Review notes kept as plain notes, with their verdict: ${report.reviewNotes}`,
          );
        if (report.reviewToDone.length)
          lines.push(
            "",
            `In review → done (Konsora has no review step): ${report.reviewToDone.join(", ")}`,
          );
        if (report.blocks.length)
          lines.push(
            "",
            "Blocks removed (Konsora no longer has blocks; their git branches stay as they are):",
            ...report.blocks.map(
              (b) =>
                `  ${b.id.padEnd(16)} ${b.name}  [${b.branch}${b.merged ? ", merged" : ", not merged"}]`,
            ),
          );
        lines.push(
          "",
          `Backup of the original: ${sibling({ v2: BACKUP_V2_FILE, v3: BACKUP_V3_FILE, v4: BACKUP_V4_FILE }[from])}`,
          "",
          opts.write
            ? "Done. Review the result with `konsora status`."
            : "Nothing was written. Run `konsora migrate --write` to apply it.",
        );
        io.stdout(`${lines.join("\n")}\n`);
        return;
      }

      if (!isV1(parsed.value))
        throw new CliError(
          `${path} is neither ${SCHEMA_VERSION}, konsora/4, konsora/3, konsora/2 nor v1 (schema_version 1).`,
        );
      const result = migrateV1(parsed.value, {
        name: opts.name ?? basename(root),
        at: timestamp(io),
      });
      if (!result.ok) throw new CliError(result.message);
      const { report } = result;
      if (opts.write) {
        check(
          await writeMigration(root, {
            expectedText: text,
            text: serializeDocument(result.document),
            from: "v1",
            history: result.history,
          }),
        );
      }
      if (opts.json) {
        json(io, {
          ok: true,
          from: "v1",
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
        lines.push("", "Renumbered ids:", ...report.renumbered.map((r) => `  ${r.from} → ${r.to}`));
      if (report.criteriaInDescription.length) {
        lines.push(
          "",
          `Criteria kept in the description (over 500 chars): ${report.criteriaInDescription.join(", ")}`,
        );
      }
      lines.push(
        "",
        `History: ${report.history.attempts} attempts, ${report.history.activity} activity events, ${report.history.reviews} reviews → ${sibling(LEGACY_HISTORY_FILE)}`,
        `Backup of the original: ${sibling(BACKUP_V1_FILE)}`,
        "",
        opts.write
          ? "Done. Review the result with `konsora status`."
          : "Nothing was written. Run `konsora migrate --write` to apply it.",
      );
      io.stdout(`${lines.join("\n")}\n`);
    });
}
