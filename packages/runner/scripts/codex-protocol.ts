/**
 * Turns the output of `codex app-server generate-ts` into the subset Konsora keeps in
 * `packages/runner/src/codex/protocol/`. Pure: it takes and returns `{ path → text }` maps, so it is
 * testable without `codex`. `codex-types.ts` runs it against the installed `codex`.
 *
 * - Only the types reachable from `ROOTS` are kept: the four unions on the wire plus the responses
 *   the adapter reads. The full output (~760 files, 3 MB) is mostly requests Konsora never sends.
 * - ts-rs writes `import type { X } from "./X"`; with `nodenext` and `allowImportingTsExtensions`
 *   relative imports need their extension, so `.ts` is added.
 * - The generated `index.ts` files re-export every type, kept or not, so they are replaced by
 *   indexes of the kept files (`v2` as a namespace, as upstream does).
 */

export type Files = ReadonlyMap<string, string>;

/** Entry points, as paths without `.ts` relative to the output folder. */
export const ROOTS: readonly string[] = [
  "ClientRequest",
  "ClientNotification",
  "ServerRequest",
  "ServerNotification",
  // Replies to the requests the adapter sends.
  "InitializeResponse",
  "v2/ThreadStartResponse",
  "v2/ThreadResumeResponse",
  "v2/TurnStartResponse",
  "v2/TurnInterruptResponse",
  "v2/ModelListResponse",
  "v2/GetAccountRateLimitsResponse",
  // The adapter's replies to the server's requests (approvals and questions).
  "v2/CommandExecutionRequestApprovalResponse",
  "v2/FileChangeRequestApprovalResponse",
  "v2/PermissionsRequestApprovalResponse",
  "v2/ToolRequestUserInputResponse",
  "v2/McpServerElicitationRequestResponse",
  "ApplyPatchApprovalResponse",
  "ExecCommandApprovalResponse",
];

const IMPORT = /(from\s+")(\.{1,2}\/[^"]+)(")/g;

/** Joins a relative specifier to the folder of `from`, without leaving the output folder. */
function resolve(from: string, specifier: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error(`${from} imports ${specifier}, outside the output`);
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `${parts.join("/")}.ts`;
}

function imports(path: string, text: string): string[] {
  return [...text.matchAll(IMPORT)].map((m) => resolve(path, m[2] as string));
}

/** The files reachable from `roots`, sorted. Throws if a root or an import is missing. */
export function closure(files: Files, roots: readonly string[] = ROOTS): string[] {
  const seen = new Set<string>();
  const stack = roots.map((root) => `${root}.ts`);
  while (stack.length > 0) {
    const path = stack.pop() as string;
    if (seen.has(path)) continue;
    const text = files.get(path);
    if (text === undefined) throw new Error(`generate-ts did not produce ${path}`);
    seen.add(path);
    stack.push(...imports(path, text));
  }
  return [...seen].sort();
}

/** Adds `.ts` to relative imports that lack it. */
export function addExtensions(text: string): string {
  return text.replace(IMPORT, (_, start: string, specifier: string, end: string) =>
    specifier.endsWith(".ts") ? `${start}${specifier}${end}` : `${start}${specifier}.ts${end}`,
  );
}

const HEADER =
  "// GENERATED CODE! DO NOT MODIFY BY HAND! Run `npm run codex:types` to regenerate.\n";

function index(names: readonly string[], namespaces: readonly string[]): string {
  const lines = names.map((name) => `export type { ${name} } from "./${name}.ts";`);
  for (const ns of namespaces) lines.push(`export type * as ${ns} from "./${ns}/index.ts";`);
  return `${HEADER}\n${lines.join("\n")}\n`;
}

/** The folder Konsora keeps: the kept types, their indexes and `version.ts`. */
export function protocolSubset(files: Files, version: string, roots = ROOTS): Map<string, string> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unexpected codex version: ${version}`);
  const out = new Map<string, string>();
  const kept = closure(files, roots).filter((path) => !/(^|\/)index\.ts$/.test(path));
  for (const path of kept) {
    const text = (files.get(path) as string).replace(/\r\n/g, "\n");
    out.set(path, addExtensions(text.endsWith("\n") ? text : `${text}\n`));
  }
  // An index per folder: types of the root folder plus `v2` (and any other subfolder) as namespaces.
  const folders = new Map<string, string[]>();
  for (const path of kept) {
    const slash = path.lastIndexOf("/");
    const folder = slash === -1 ? "" : path.slice(0, slash);
    const name = path.slice(slash + 1, -3);
    folders.set(folder, [...(folders.get(folder) ?? []), name]);
  }
  for (const [folder, names] of folders) {
    const namespaces = [...folders.keys()]
      .filter((other) => other !== folder && other.startsWith(folder ? `${folder}/` : ""))
      .filter((other) => !other.slice(folder ? folder.length + 1 : 0).includes("/"))
      .map((other) => other.slice(other.lastIndexOf("/") + 1))
      .sort();
    out.set(folder ? `${folder}/index.ts` : "index.ts", index(names, namespaces));
  }
  out.set(
    "version.ts",
    `${HEADER}\n/** The codex-cli version these types were generated from. */\nexport const CODEX_PROTOCOL_VERSION = "${version}";\n`,
  );
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
