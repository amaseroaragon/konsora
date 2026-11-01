// Regenerates packages/runner/src/codex/protocol/ from the installed `codex`.
// Run: npm run codex:types   (CODEX_BIN picks another executable)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { protocolSubset } from "./codex-protocol.ts";

const codex = process.env.CODEX_BIN ?? "codex";
const target = fileURLToPath(new URL("../src/codex/protocol/", import.meta.url));

function walk(dir: string, root = dir, out = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, root, out);
    else if (entry.name.endsWith(".ts")) out.set(relative(root, path), readFileSync(path, "utf8"));
  }
  return out;
}

const versionText = execFileSync(codex, ["--version"], { encoding: "utf8" });
const version = /(\d+\.\d+\.\d+)/.exec(versionText)?.[1];
if (!version) throw new Error(`Could not read the version from \`${codex} --version\``);

const scratch = mkdtempSync(join(tmpdir(), "konsora-codex-types-"));
try {
  execFileSync(codex, ["app-server", "generate-ts", "--out", scratch], { stdio: "ignore" });
  const subset = protocolSubset(walk(scratch), version);
  rmSync(target, { recursive: true, force: true });
  for (const [path, text] of subset) {
    const file = join(target, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  console.log(`wrote ${subset.size} files for codex-cli ${version} to ${target}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
