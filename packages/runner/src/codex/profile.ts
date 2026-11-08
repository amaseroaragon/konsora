/** Codex's permission profiles (RUN-29): `default` (workspace-write) and `readonly`. */
import { READONLY_PROFILE } from "@konsora/core";
import { AdapterError, type RunSpec } from "../adapter.ts";
import type { v2 } from "./protocol/index.ts";

/** The `readonly` profile (review runs, RUN-29): Codex's `read-only` sandbox, no network. */
export const CODEX_READONLY_SANDBOX = "read-only" satisfies v2.SandboxMode;
export const CODEX_PROFILES = ["default", READONLY_PROFILE];

/** Whether the run uses the `readonly` profile; refuses unknown profiles. */
export function codexReadonly(spec: Pick<RunSpec, "agent">): boolean {
  const profile = spec.agent.permissions ?? "default";
  if (!CODEX_PROFILES.includes(profile)) {
    throw new AdapterError(
      "unsupported_profile",
      `Permission profile "${profile}" is not available for Codex; use ${CODEX_PROFILES.join(" or ")}`,
    );
  }
  return profile === READONLY_PROFILE;
}
