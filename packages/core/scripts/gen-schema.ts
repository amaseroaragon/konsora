// Regenerates schema/tasks.v2.schema.json from packages/core/src/schema.ts. Run: npm run schema
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tasksJsonSchemaText } from "../src/json-schema.ts";

const target = fileURLToPath(new URL("../../../schema/tasks.v2.schema.json", import.meta.url));
writeFileSync(target, tasksJsonSchemaText());
console.log(`wrote ${target}`);
