/**
 * Runtime schema for semantic ops received as JSON (daemon HTTP, MCP). Mirrors the `Op` type in
 * ops.ts; `applyOp` still enforces roles, transitions and validity.
 */
import { z } from "zod";
import type { Op } from "./ops.ts";
import {
  AcceptanceSchema,
  DifficultySchema,
  GroupSchema,
  QuestionOptionSchema,
  TaskIdSchema,
  TaskSchema,
  TemplateSchema,
} from "./schema.ts";

const expect = z.record(TaskIdSchema, z.string()).optional();
const id = z.string().min(1).max(40);
const text = z.string().max(16_384);

const NewTask = {
  title: z.string().min(1).max(120),
  group: z.string().min(1).max(6),
  desc: z.string().max(32_768).optional(),
  acceptance: z.array(z.string().min(1).max(500)).optional(),
  deps: z.array(z.string().min(1).max(120)).optional(),
  labels: z.array(z.string()).optional(),
  difficulty: DifficultySchema.optional(),
  template: z.string().min(1).max(31).optional(),
};

/** A task in a batch; `idea: true` creates it as an idea (`proposed`) instead of in `todo`. */
const BatchTask = { ...NewTask, idea: z.boolean().optional() };

export const OpSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("propose"),
    expect,
    state: z.enum(["proposed", "todo"]).optional(),
    ...NewTask,
  }),
  z.strictObject({
    op: z.literal("batch"),
    expect,
    groups: z.array(GroupSchema).optional(),
    tasks: z.array(z.strictObject(BatchTask)).min(1).max(200),
  }),
  z.strictObject({
    op: z.literal("add-group"),
    expect,
    id: z.string(),
    name: z.string().min(1).max(60),
  }),
  z.strictObject({ op: z.literal("promote"), expect, task: id }),
  z.strictObject({ op: z.literal("demote"), expect, task: id }),
  z.strictObject({
    op: z.literal("edit"),
    expect,
    task: id,
    changes: z.strictObject({
      title: z.string().min(1).max(120).optional(),
      desc: z.string().max(32_768).optional(),
      acceptance: z.array(AcceptanceSchema).optional(),
      labels: z.array(z.string()).optional(),
      group: z.string().optional(),
      rank: z.string().optional(),
      // null removes it (JSON has no undefined).
      difficulty: DifficultySchema.nullable().optional(),
    }),
  }),
  z.strictObject({
    op: z.literal("move"),
    expect,
    task: id,
    before: id.optional(),
    after: id.optional(),
    top: z.boolean().optional(),
  }),
  z.strictObject({ op: z.literal("delete"), expect, task: id }),
  z.strictObject({ op: z.literal("depend"), expect, task: id, on: id }),
  z.strictObject({ op: z.literal("undepend"), expect, task: id, on: id }),
  z.strictObject({ op: z.literal("start"), expect, task: id, text: text.optional() }),
  z.strictObject({ op: z.literal("pause"), expect, task: id, text: text.optional() }),
  z.strictObject({ op: z.literal("note"), expect, task: id, text }),
  z.strictObject({
    op: z.literal("ask"),
    expect,
    task: id,
    text,
    options: z.array(QuestionOptionSchema).max(10).optional(),
  }),
  z.strictObject({ op: z.literal("answer"), expect, task: id, text }),
  z.strictObject({ op: z.literal("finish"), expect, task: id, summary: text }),
  z.strictObject({
    op: z.literal("set-templates"),
    expect,
    templates: z.array(TemplateSchema).max(100),
  }),
  z.strictObject({ op: z.literal("reopen"), expect, task: id, text: text.optional() }),
  z.strictObject({ op: z.literal("restore"), expect, task: id, version: TaskSchema }),
  z.strictObject({
    op: z.literal("undo"),
    expect,
    changes: z
      .array(
        z.strictObject({
          task: TaskIdSchema,
          before: TaskSchema.nullable(),
          after: z.string().nullable(),
        }),
      )
      .min(1)
      .max(500),
  }),
]);

/** Parses untrusted JSON into an `Op`, or explains the first problem. */
export function parseOp(value: unknown): { ok: true; op: Op } | { ok: false; message: string } {
  const parsed = OpSchema.safeParse(value);
  if (parsed.success) return { ok: true, op: parsed.data as Op };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    message: `Invalid op at ${issue?.path.join(".") || "(root)"}: ${issue?.message}`,
  };
}
