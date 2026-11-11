/**
 * Structural schema of `.konsora/tasks.json`, format `konsora/4` (docs/esquema-tareas.md §1).
 *
 * This is the single source of truth: types are inferred from it and
 * `schema/tasks.v4.schema.json` is generated from it (`npm run schema`).
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

export const SCHEMA_VERSION = "konsora/4";

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

/** `proposed` is an idea: anyone may move it to `todo`, no approval needed. */
export const TaskStateSchema = z.enum(["proposed", "todo", "doing", "done"]);

const slug = /^[a-z][a-z0-9-]{0,30}$/;

const LabelSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "Label must be a lowercase slug");

/** A template's acceptance criterion: like a task's, without the id (the task numbers them). */
export const TemplateCriterionSchema = strict({
  text: z.string().min(1).max(500),
});

/**
 * A task template (CORE-10): the values a task proposed with it starts from. Only the human
 * defines templates (`set-templates`).
 */
export const TemplateSchema = strict({
  id: z.string().regex(slug, "Template id must be a lowercase slug"),
  name: z.string().min(1).max(60),
  desc: z.string().max(32_768).optional(),
  acceptance: z.array(TemplateCriterionSchema).max(50).optional(),
  labels: z.array(LabelSchema).optional(),
});

export const ProjectSchema = strict({
  name: z.string().min(1).max(80),
  templates: z.array(TemplateSchema).max(100).optional(),
});

export const BlockIdSchema = z
  .string()
  .regex(slug, "Block id must be a lowercase slug (letters, digits and dashes, from a letter)");

/** A git branch name as Konsora accepts it: a conservative subset of `git check-ref-format`. */
export const BranchSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?![/.-])[A-Za-z0-9._/-]+(?<![/.])(?<!\.lock)$/,
    "Branch must be a valid git branch name (letters, digits, . _ - /)",
  );

/**
 * A block (M12): tasks that are worked on together in one git branch. When all its tasks are
 * done, the human merges the branch into `base` from the UI; `merged` records it.
 */
export const BlockSchema = strict({
  id: BlockIdSchema,
  name: z.string().min(1).max(80),
  branch: BranchSchema,
  base: BranchSchema,
  created: strict({ at: TimestampSchema, by: ActorSchema }),
  merged: strict({
    at: TimestampSchema,
    by: ActorSchema,
    commit: z.string().regex(/^[0-9a-f]{40}$/, "Commit must be a full 40-character hash"),
    strategy: z.enum(["squash", "merge"]),
  }).optional(),
});

export const GroupSchema = strict({
  id: GroupIdSchema,
  name: z.string().min(1).max(60),
});

export const AcceptanceSchema = strict({
  id: z.string().regex(/^ac\d+$/, "Acceptance id must look like ac1"),
  text: z.string().min(1).max(500),
});

export const NoteKindSchema = z.enum(["note", "question", "answer", "feedback", "summary"]);

export const NoteSchema = strict({
  id: z.string().regex(/^n\d+$/, "Note id must look like n1"),
  at: TimestampSchema,
  by: ActorSchema,
  kind: NoteKindSchema,
  text: z.string().min(1).max(16_384),
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
  labels: z.array(LabelSchema).optional(),
  /** The block whose branch this task is worked on. */
  block: BlockIdSchema.optional(),
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
  blocks: z.array(BlockSchema).optional(),
  tasks: z.array(TaskSchema),
});

export type TaskState = z.infer<typeof TaskStateSchema>;
export type Template = z.infer<typeof TemplateSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type Group = z.infer<typeof GroupSchema>;
export type Block = z.infer<typeof BlockSchema>;
export type MergeStrategy = NonNullable<Block["merged"]>["strategy"];
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
