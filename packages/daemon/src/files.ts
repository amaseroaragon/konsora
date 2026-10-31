/** Private files in Konsora's data dir: created with 0700 dirs / 0600 files, written atomically. */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Ensures the data dir exists, is a real directory (not a symlink) and is private (0700). */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${dir} must be a real directory, not a symlink`);
  }
  if ((info.mode & 0o077) !== 0) await chmod(dir, 0o700);
}

export async function writePrivateFile(path: string, text: string): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const temp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
