/**
 * Runtime schema for semantic ops received as JSON (daemon HTTP, MCP). Mirrors the `Op` type in
 * ops.ts; `applyOp` still enforces roles, transitions and validity.
 */
import { z } from "zod";
import type { Op } from "./ops.ts";
import {
  AcceptanceSchema,
  AgentSpecSchema,
  CheckSchema,
  GroupSchema,
  MAX_CHECK_RETRIES,
  SetupSchema,
  TaskIdSchema,
  TaskSchema,
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
  agent: AgentSpecSchema.optional(),
};

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
    tasks: z.array(z.strictObject(NewTask)).min(1).max(200),
  }),
  z.strictObject({
    op: z.literal("add-group"),
    expect,
    id: z.string(),
    name: z.string().min(1).max(60),
  }),
  z.strictObject({ op: z.literal("approve"), expect, task: id }),
  z.strictObject({
    op: z.literal("edit"),
    expect,
    task: id,
    changes: z.strictObject({
      title: z.string().min(1).max(120).optional(),
      desc: z.string().max(32_768).optional(),
      acceptance: z.array(AcceptanceSchema).optional(),
      labels: z.array(z.string()).optional(),
      agent: AgentSpecSchema.optional(),
      group: z.string().optional(),
      rank: z.string().optional(),
    }),
  }),
  z.strictObject({ op: z.literal("withdraw"), expect, task: id }),
  z.strictObject({ op: z.literal("depend"), expect, task: id, on: id }),
  z.strictObject({ op: z.literal("undepend"), expect, task: id, on: id }),
  z.strictObject({ op: z.literal("start"), expect, task: id, text: text.optional() }),
  z.strictObject({ op: z.literal("pause"), expect, task: id, text: text.optional() }),
  z.strictObject({ op: z.literal("note"), expect, task: id, text }),
  z.strictObject({ op: z.literal("ask"), expect, task: id, text }),
  z.strictObject({ op: z.literal("answer"), expect, task: id, text }),
  z.strictObject({ op: z.literal("finish"), expect, task: id, summary: text }),
  z.strictObject({
    op: z.literal("complete"),
    expect,
    task: id,
    checks_passed: z.boolean(),
    text: text.optional(),
  }),
  z.strictObject({ op: z.literal("rebase"), expect, task: id, text: text.optional() }),
  z.strictObject({ op: z.literal("rebase-abort"), expect, task: id, text: text.optional() }),
  z.strictObject({
    op: z.literal("set-checks"),
    expect,
    checks: z.array(CheckSchema).max(50).optional(),
    check_retries: z.int().min(0).max(MAX_CHECK_RETRIES).nullable().optional(),
    setup: SetupSchema.nullable().optional(),
  }),
  z.strictObject({ op: z.literal("accept"), expect, task: id }),
  z.strictObject({ op: z.literal("send-back"), expect, task: id, feedback: text }),
  z.strictObject({ op: z.literal("reopen"), expect, task: id, text: text.optional() }),
  z.strictObject({ op: z.literal("set-yolo"), expect, task: id, value: z.boolean() }),
  z.strictObject({ op: z.literal("restore"), expect, task: id, version: TaskSchema }),
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
