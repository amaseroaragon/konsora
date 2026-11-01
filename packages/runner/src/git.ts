/**
 * Git, behind an interface so tests (and later the integration step) can substitute it.
 *
 * The system implementation spawns the user's `git` with a clean, predictable environment: no
 * inherited `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` (they would redirect every command when
 * Konsora runs from inside a git hook), no terminal prompts and C locale messages.
 */
import { spawn } from "node:child_process";

export type GitResult = { code: number; stdout: string; stderr: string };

export type GitOptions = {
  cwd: string;
  /** Run git under this umask (e.g. 0o077 so a new worktree is private to the user). */
  umask?: number;
  /** Written to git's stdin (e.g. a commit message for `commit-tree -F -`). */
  input?: string;
};

export interface Git {
  run(args: readonly string[], options: GitOptions): Promise<GitResult>;
}

const REPO_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  for (const name of REPO_ENV) delete clean[name];
  return clean;
}

export const systemGit: Git = {
  run(args, options) {
    // `umask` only exists as a shell builtin: wrap git in `sh -c 'umask …; exec git "$@"'`.
    const [command, argv] =
      options.umask === undefined
        ? ["git", [...args]]
        : [
            "sh",
            [
              "-c",
              `umask ${options.umask.toString(8).padStart(3, "0")} && exec git "$@"`,
              "git",
              ...args,
            ],
          ];
    return new Promise((resolve, reject) => {
      const child = spawn(command, argv, {
        cwd: options.cwd,
        env: gitEnv(),
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      if (options.input !== undefined) {
        child.stdin?.on("error", () => undefined); // git may exit before reading it all
        child.stdin?.end(options.input);
      }
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code, signal) =>
        resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr }),
      );
    });
  },
};
