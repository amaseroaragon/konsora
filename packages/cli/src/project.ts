import { existsSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { KONSORA_DIR } from "@konsora/core/store";

/**
 * Finds the project root: `--root`, else `KONSORA_ROOT`, else the nearest ancestor of `cwd` that contains a `.konsora/`
 * directory. Returns null when none is found.
 */
export function findRoot(
  cwd: string,
  explicit?: string,
  env: NodeJS.ProcessEnv = {},
): string | null {
  const given = explicit ?? env.KONSORA_ROOT;
  if (given) return resolve(cwd, given);
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, KONSORA_DIR);
    if (existsSync(candidate) && lstatSync(candidate).isDirectory()) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
