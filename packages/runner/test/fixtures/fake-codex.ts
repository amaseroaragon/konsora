/** A stand-in for `codex` in tests. FAKE_CODEX_VERSION sets what `--version` prints; FAKE_CODEX_FAIL makes it exit 1. */
if (process.env.FAKE_CODEX_FAIL) process.exit(1);
if (process.argv[2] === "--version") {
  process.stdout.write(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? "0.166.0"}\n`);
  process.exit(0);
}
process.stderr.write("fake codex: unsupported arguments\n");
process.exit(2);
