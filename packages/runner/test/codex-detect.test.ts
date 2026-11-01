import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectCodex } from "../src/codex/detect.ts";
import { CODEX_PROTOCOL_VERSION } from "../src/codex/protocol/version.ts";

const fakeCodex = fileURLToPath(new URL("./fixtures/fake-codex.ts", import.meta.url));

const detect = (env: Record<string, string> = {}, command = process.execPath) =>
  detectCodex({ command, prefixArgs: [fakeCodex], env: { ...process.env, ...env } });

describe("detectCodex", () => {
  it("reports the installed version, the types' version and that they match", async () => {
    expect(await detect({ FAKE_CODEX_VERSION: CODEX_PROTOCOL_VERSION })).toEqual({
      installed: true,
      version: CODEX_PROTOCOL_VERSION,
      authenticated: "unknown",
      expected_version: CODEX_PROTOCOL_VERSION,
      version_matches: true,
    });
  });

  it("warns, without blocking, when the installed version is another", async () => {
    const result = await detect({ FAKE_CODEX_VERSION: "0.170.1" });
    expect(result).toMatchObject({
      installed: true,
      version: "0.170.1",
      expected_version: CODEX_PROTOCOL_VERSION,
      version_matches: false,
    });
    expect(result.warning).toContain("0.170.1");
    expect(result.warning).toContain("npm run codex:types");
  });

  it("says codex is not installed when it cannot run or fails", async () => {
    expect(await detect({}, "/nonexistent/codex")).toEqual({
      installed: false,
      expected_version: CODEX_PROTOCOL_VERSION,
    });
    expect(await detect({ FAKE_CODEX_FAIL: "1" })).toEqual({
      installed: false,
      expected_version: CODEX_PROTOCOL_VERSION,
    });
  });
});
