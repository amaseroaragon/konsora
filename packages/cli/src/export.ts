/**
 * `konsora export` (CLI-12): the plan as Markdown, for a PR description, release notes or a
 * weekly summary. `--done` lists what was closed (core's completionLog, archived tasks included),
 * by group; `--pending`, what is left, in dependency order. The text is a pure function of the
 * plan (no "generated at"), so the same plan always gives the same Markdown. It prints to stdout
 * and writes a file only with `--output`.
 */
import { constants } from "node:fs";
import { link, open, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { type LogEntry, startedBy, type TasksDocument } from "@konsora/core";
import type { Command } from "commander";
import { parseBefore } from "./archive.ts";
import { views } from "./format.ts";
import { logData } from "./read.ts";
import { CliError, EXIT, type Io, load } from "./shared.ts";

const who = (by: string | undefined) => by?.replace(/^agent:/, "");

/** A list item's continuation: the text indented under its bullet. */
const indented = (text: string) =>
  text
    .trimEnd()
    .split("\n")
    .map((line) => (line.trim() ? `  ${line}` : ""))
    .join("\n");

export function doneMarkdown(
  doc: TasksDocument,
  entries: readonly LogEntry[],
  since?: string,
): string {
  const title = `# ${doc.project.name}: done${since ? ` since ${since.slice(0, 10)}` : ""}`;
  if (entries.length === 0)
    return `${title}\n\nNo tasks were finished${since ? " since then" : ""}.\n`;
  // Groups in the plan's order; one only archived tasks still use goes last, by id.
  const order = [
    ...doc.groups.map((g) => g.id),
    ...[...new Set(entries.map((e) => e.group))]
      .filter((id) => !doc.groups.some((g) => g.id === id))
      .sort(),
  ];
  const sections = order.flatMap((group) => {
    const items = entries.filter((e) => e.group === group);
    if (items.length === 0) return [];
    const name = doc.groups.find((g) => g.id === group)?.name;
    const lines = items.map((e) => {
      const meta = [e.at.slice(0, 10), who(e.by)].filter(Boolean).join(", ");
      const extra = [
        e.unmet ? `${e.unmet} criteria not met` : undefined,
        e.commits?.length ? `commits ${e.commits.join(", ")}` : undefined,
      ].filter(Boolean);
      return (
        `- **${e.id}** ${e.title} (${meta})${extra.length ? ` · ${extra.join(" · ")}` : ""}\n` +
        (e.summary ? `${indented(e.summary)}\n` : "  _(no closing summary)_\n")
      );
    });
    return [`## ${name && name !== group ? `${group} · ${name}` : group}\n\n${lines.join("")}`];
  });
  const count = `${entries.length} task${entries.length === 1 ? "" : "s"} finished.`;
  return `${title}\n\n${count}\n\n${sections.join("\n")}`;
}

export function pendingMarkdown(doc: TasksDocument): string {
  const pending = views(doc).filter((t) => t.state === "todo" || t.state === "doing");
  const title = `# ${doc.project.name}: pending`;
  if (pending.length === 0) return `${title}\n\nNothing left to do.\n`;
  const doing = pending.filter((t) => t.state === "doing").length;
  const lines = pending.map((t) => {
    const started = startedBy(t);
    const state =
      t.state === "doing"
        ? `in progress${started ? `, ${who(started.by)}` : ""}`
        : t.ready
          ? "ready"
          : `blocked by ${t.blockers.join(", ")}`;
    const flags = [state, t.waiting ? "waiting for an answer" : undefined, t.difficulty].filter(
      Boolean,
    );
    const criteria = (t.acceptance ?? []).map((a) => `  - [ ] ${a.text}\n`).join("");
    return `- **${t.id}** ${t.title} (${flags.join(", ")})\n${criteria}`;
  });
  const count = `${pending.length} task${pending.length === 1 ? "" : "s"} to do${doing ? `, ${doing} in progress` : ""}, in dependency order.`;
  return `${title}\n\n${count}\n\n${lines.join("")}`;
}

/** Writes `text` to `path` atomically; an existing file only with `force`. */
async function writeOutput(path: string, text: string, force: boolean) {
  const temp = `${path}.konsora-${process.pid}.tmp`;
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // Without force, link() fails if the file exists: nothing is overwritten by accident.
    if (force) await rename(temp, path);
    else await link(temp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CliError(
        `${path} already exists; left it unchanged.`,
        "Pass --force to replace it, or choose another --output.",
      );
    throw new CliError(`Could not write ${path}: ${(error as Error).message}`);
  } finally {
    await rm(temp, { force: true });
  }
}

export function registerExport(program: Command, io: Io, rootOption: () => string | undefined) {
  program
    .command("export")
    .description(
      "the plan as Markdown: --done (closed tasks by group, with their summaries) or --pending (what is left, in dependency order)",
    )
    .option("--done", "the finished tasks with their closing summaries, by group")
    .option("--since <date>", "with --done: only tasks finished on or after this date")
    .option("--pending", "the tasks left to do and in progress, in dependency order")
    .option("--output <file>", "write the Markdown to this file instead of printing it")
    .option("--force", "with --output: replace the file if it exists")
    .action(
      async (opts: {
        done?: boolean;
        since?: string;
        pending?: boolean;
        output?: string;
        force?: boolean;
      }) => {
        if (Boolean(opts.done) === Boolean(opts.pending))
          throw new CliError(
            "Pass exactly one of --done or --pending.",
            "e.g. `konsora export --done --since 2026-11-01`.",
            EXIT.usage,
          );
        if (opts.since && !opts.done)
          throw new CliError("--since only goes with --done.", undefined, EXIT.usage);
        if (opts.force && !opts.output)
          throw new CliError("--force only goes with --output.", undefined, EXIT.usage);
        const since = opts.since ? parseBefore(opts.since) : undefined;
        const { root, doc } = await load(io, rootOption());
        const text = opts.done
          ? doneMarkdown(doc, await logData(root, doc, since ? { since } : {}), since)
          : pendingMarkdown(doc);
        if (!opts.output) {
          io.stdout(text);
          return;
        }
        const path = resolve(io.cwd, opts.output);
        await writeOutput(path, text, Boolean(opts.force));
        io.stdout(`Wrote ${opts.output}.\n`);
      },
    );
}
