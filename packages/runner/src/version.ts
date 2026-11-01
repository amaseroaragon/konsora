/** Runs `<command> --version` and reads the first `x.y.z` in its output. */
import { type ChildProcess, spawn } from "node:child_process";

export function readVersion(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = "";
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        env,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      });
    } catch {
      resolve(undefined);
      return;
    }
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      resolve(code === 0 ? /(\d+\.\d+\.\d+)/.exec(out)?.[1] : undefined);
    });
  });
}
