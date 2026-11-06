/**
 * Structural schema of `.konsora/tasks.json`, format `konsora/2` (docs/esquema-tareas.md §1).
 *
 * This is the single source of truth: types are inferred from it and
 * `schema/tasks.v2.schema.json` is generated from it (`npm run schema`).
 * Semantic rules (ids vs groups, seq, deps existence, cycles…) live in CORE-02.
 */
import { z } from "zod";

/** Objects reject unknown keys, except extension keys starting with `x-`, which are kept as-is. */
function strict<T extends z.ZodRawShape>(shape: T) {
  return z
    .object(shape)
    .catchall(z.unknown())
    .superRefine((value, ctx) => {
      for (const key of Object.keys(value)) {
        if (!(key in shape) && !key.startsWith("x-")) {
          ctx.addIssue({
            code: "unrecognized_keys",
            keys: [key],
            message: `Unknown key "${key}" (extension keys must start with "x-")`,
          });
        }
      }
    });
}

export const SCHEMA_VERSION = "konsora/2";

export const GroupIdSchema = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9]{0,5}$/,
    "Group id must be 1–6 uppercase letters/digits, starting with a letter",
  );

export const TaskIdSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{0,5}-\d{2,}$/, "Task id must look like GROUP-NN (e.g. CORE-01)");

/** ISO-8601 in UTC with `Z` and second precision, e.g. 2026-10-31T21:50:00Z. */
export const TimestampSchema = z.iso.datetime({
  offset: false,
  precision: 0,
  message: "Timestamp must be UTC with seconds precision, e.g. 2026-10-31T21:50:00Z",
});

export const ActorSchema = z
  .string()
  .regex(
    /^(human|konsora|agent:[a-z0-9][a-z0-9._-]{0,39})$/,
    'Actor must be "human", "konsora" or "agent:<name>"',
  );

export const TaskStateSchema = z.enum(["proposed", "todo", "doing", "review", "done"]);

export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const ProviderSchema = z.enum(["claude", "codex"]);

const slug = /^[a-z][a-z0-9-]{0,30}$/;

export const AgentSpecSchema = strict({
  provider: ProviderSchema,
  model: z.string().min(1).max(100),
  effort: EffortSchema.optional(),
  permissions: z.string().regex(slug, "Permission profile must be a lowercase slug").optional(),
});

/** Retries when `project.check_retries` is absent, and the most it may be. */
export const DEFAULT_CHECK_RETRIES = 2;
export const MAX_CHECK_RETRIES = 5;
/** A check's timeout when `timeout_s` is absent. */
export const DEFAULT_CHECK_TIMEOUT_S = 600;

export const CheckSchema = strict({
  id: z.string().regex(slug, "Check id must be a lowercase slug"),
  run: z.string().min(1).max(1000),
  timeout_s: z.int().min(1).max(86_400).optional(),
});

export const ProjectSchema = strict({
  name: z.string().min(1).max(80),
  base_branch: z.string().min(1).max(255),
  defaults: AgentSpecSchema.optional(),
  checks: z.array(CheckSchema).optional(),
  /** How many times a run's agent gets the failed checks back to fix them (default 2). */
  check_retries: z.int().min(0).max(MAX_CHECK_RETRIES).optional(),
});

export const GroupSchema = strict({
  id: GroupIdSchema,
  name: z.string().min(1).max(60),
});

export const AcceptanceSchema = strict({
  id: z.string().regex(/^ac\d+$/, "Acceptance id must look like ac1"),
  text: z.string().min(1).max(500),
  check: z.string().min(1).max(1000).optional(),
});

export const NoteKindSchema = z.enum(["note", "question", "answer", "feedback", "summary"]);

export const NoteSchema = strict({
  id: z.string().regex(/^n\d+$/, "Note id must look like n1"),
  at: TimestampSchema,
  by: ActorSchema,
  kind: NoteKindSchema,
  text: z.string().min(1).max(16_384),
  run: z
    .string()
    .regex(/^r-[0-9A-Z]{6,26}$/, "Run id must look like r-01JC8Z3K2Q")
    .optional(),
  edited: TimestampSchema.optional(),
});

export const TaskSchema = strict({
  id: TaskIdSchema,
  title: z
    .string()
    .min(1)
    .max(120)
    .refine((s) => s.trim().length > 0, "Title must not be blank"),
  state: TaskStateSchema,
  group: GroupIdSchema,
  deps: z.array(TaskIdSchema).optional(),
  rank: z.string().regex(/^[0-9a-z]+$/, "Rank must use only 0-9 and a-z"),
  desc: z.string().max(32_768).optional(),
  acceptance: z.array(AcceptanceSchema).optional(),
  labels: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "Label must be a lowercase slug"))
    .optional(),
  agent: AgentSpecSchema.optional(),
  yolo: z.literal(true).optional(),
  created: strict({ at: TimestampSchema, by: ActorSchema }),
  updated_at: TimestampSchema,
  notes: z.array(NoteSchema).optional(),
});

export const DocumentSchema = strict({
  $schema: z.string().optional(),
  schema: z.literal(SCHEMA_VERSION),
  project: ProjectSchema,
  groups: z.array(GroupSchema).min(1),
  seq: z.record(GroupIdSchema, z.int().min(0)),
  tasks: z.array(TaskSchema),
});

export type TaskState = z.infer<typeof TaskStateSchema>;
export type Effort = z.infer<typeof EffortSchema>;
export type Provider = z.infer<typeof ProviderSchema>;
export type AgentSpec = z.infer<typeof AgentSpecSchema>;
export type Check = z.infer<typeof CheckSchema>;
export type Project = z.infer<typeof ProjectSchema>;

/** `project.check_retries`, or its default when absent. */
export function checkRetries(project: Pick<Project, "check_retries">): number {
  return project.check_retries ?? DEFAULT_CHECK_RETRIES;
}
export type Group = z.infer<typeof GroupSchema>;
export type Acceptance = z.infer<typeof AcceptanceSchema>;
export type NoteKind = z.infer<typeof NoteKindSchema>;
export type Note = z.infer<typeof NoteSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TasksDocument = z.infer<typeof DocumentSchema>;

/** A validation problem located by JSON Pointer (RFC 6901), e.g. `/tasks/3/id`. */
export type SchemaIssue = { path: string; code: string; message: string };

export type StructureResult =
  | { ok: true; document: TasksDocument }
  | { ok: false; issues: SchemaIssue[] };

export function toPointer(path: readonly PropertyKey[]): string {
  return path
    .map((segment) => `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`)
    .join("");
}

/** Validates the shape of an already-parsed JSON value. Never throws on bad input. */
export function validateStructure(value: unknown): StructureResult {
  const result = DocumentSchema.safeParse(value);
  if (result.success) return { ok: true, document: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => {
      const key = issue.code === "unrecognized_keys" ? issue.keys[0] : undefined;
      return {
        path: toPointer(key === undefined ? issue.path : [...issue.path, key]),
        code: issue.code,
        message: issue.message,
      };
    }),
  };
}
