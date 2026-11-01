/**
 * `detect()` for Codex: the installed version, compared with the one the protocol types in
 * `./protocol/` were generated for. A mismatch is a warning, never a block: `codex app-server` is
 * experimental and may change, so the human should know, regenerate (`npm run codex:types`) or
 * fall back to `codex exec`.
 */
import type { DetectResult } from "../adapter.ts";
import { readVersion } from "../version.ts";
import { CODEX_PROTOCOL_VERSION } from "./protocol/version.ts";

export type CodexDetectOptions = {
  /** The executable. Default `codex` (from PATH). */
  command?: string;
  /** Arguments placed before Konsora's (tests run a fake `codex` through Node). */
  prefixArgs?: string[];
  /** The child's environment. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The version the types were generated for. Default `CODEX_PROTOCOL_VERSION`. */
  expectedVersion?: string;
};

export async function detectCodex(options: CodexDetectOptions = {}): Promise<DetectResult> {
  const expected = options.expectedVersion ?? CODEX_PROTOCOL_VERSION;
  const version = await readVersion(
    options.command ?? "codex",
    [...(options.prefixArgs ?? []), "--version"],
    options.env ?? process.env,
  );
  if (!version) return { installed: false, expected_version: expected };
  const matches = version === expected;
  return {
    installed: true,
    version,
    authenticated: "unknown",
    expected_version: expected,
    version_matches: matches,
    ...(matches
      ? {}
      : {
          warning: `Codex ${version} is installed, but Konsora's protocol types are for ${expected}; runs may fail. Regenerate them with \`npm run codex:types\` or install codex-cli ${expected}.`,
        }),
  };
}
