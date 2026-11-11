import { z } from "zod";
import { DocumentSchema } from "./schema.ts";

export const JSON_SCHEMA_ID = "https://konsora.local/schema/tasks.v3.json";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * zod renders `catchall(unknown)` as `additionalProperties: {}`. Our objects only allow
 * `x-*` extension keys, so translate that into `patternProperties` + `additionalProperties: false`.
 */
function restrictExtensions(node: Json): Json {
  if (Array.isArray(node)) return node.map(restrictExtensions);
  if (node === null || typeof node !== "object") return node;
  const out: { [key: string]: Json } = {};
  for (const [key, value] of Object.entries(node)) out[key] = restrictExtensions(value);
  const extra = out.additionalProperties;
  if (
    out.type === "object" &&
    extra &&
    typeof extra === "object" &&
    !Array.isArray(extra) &&
    Object.keys(extra).length === 0
  ) {
    out.patternProperties = { "^x-": {} };
    out.additionalProperties = false;
  }
  return out;
}

/** JSON Schema (draft 2020-12) for editors and for agents that edit the file by hand. */
export function tasksJsonSchema(): Json {
  const generated = z.toJSONSchema(DocumentSchema, { target: "draft-2020-12" }) as Json;
  const restricted = restrictExtensions(generated) as { [key: string]: Json };
  const { $schema, ...rest } = restricted;
  return {
    $schema: $schema ?? "https://json-schema.org/draft/2020-12/schema",
    $id: JSON_SCHEMA_ID,
    title: "Konsora tasks (konsora/3)",
    description:
      "Structure of .konsora/tasks.json. Semantic rules (ids vs groups, seq, deps, cycles) are checked by Konsora, not by this schema. See docs/esquema-tareas.md.",
    ...rest,
  };
}

export function tasksJsonSchemaText(): string {
  return `${JSON.stringify(tasksJsonSchema(), null, 2)}\n`;
}
