/**
 * Time limit for the tests that start real Node processes (`konsora mcp` over stdio, the real
 * binary) or make many real writes to disk (each one locked and fsynced). Starting `konsora mcp`
 * compiles the TypeScript of the CLI and the MCP SDK on the fly, about 0.6 s on an idle machine,
 * and a test may start several; under load (a parallel run, a busy machine) these tests passed
 * vitest's default 5 s and made `npm run check` fail now and then (CLI-13).
 */
export const SLOW_TIMEOUT = 30_000;
