// Regenerates src/theme/tokens.css from src/theme/tokens.ts. Run: npm run tokens -w @konsora/web
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tokensCss } from "../src/theme/css.ts";

const target = fileURLToPath(new URL("../src/theme/tokens.css", import.meta.url));
writeFileSync(target, tokensCss());
console.log(`wrote ${target}`);
