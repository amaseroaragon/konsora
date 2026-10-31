/**
 * Project registry (`projects.json` in the data dir). A Konsora "project" is only a link to a
 * folder: linking or unlinking never writes, moves or deletes anything inside that folder.
 */
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { readJson, writePrivateFile } from "./files.ts";
import { PROJECTS_FILE } from "./paths.ts";

export const ProjectSchema = z.object({
  id: z.string().regex(/^p-[0-9a-f]{12}$/),
  name: z.string().min(1).max(80),
  path: z.string().min(1),
  added_at: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

const RegistrySchema = z.object({ version: z.literal(1), projects: z.array(ProjectSchema) });

export class RegistryError extends Error {
  readonly code: "not_found" | "not_a_directory" | "inside_data_dir" | "not_registered" | "corrupt";
  constructor(code: RegistryError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** Stable id from the canonical path, so re-linking the same folder gives the same id. */
export function projectId(path: string): string {
  return `p-${createHash("sha256").update(path).digest("hex").slice(0, 12)}`;
}

export class Registry {
  readonly file: string;
  readonly dataDir: string;
  /** Serializes writes within this process (the daemon is the registry's only writer). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.file = join(dataDir, PROJECTS_FILE);
  }

  async list(): Promise<Project[]> {
    const raw = await readJson<unknown>(this.file);
    if (raw === undefined) return [];
    const parsed = RegistrySchema.safeParse(raw);
    if (!parsed.success)
      throw new RegistryError("corrupt", `${this.file} is not a valid project registry`);
    return parsed.data.projects;
  }

  async get(id: string): Promise<Project> {
    const project = (await this.list()).find((p) => p.id === id);
    if (!project) throw new RegistryError("not_registered", `Project ${id} is not linked`);
    return project;
  }

  /** Links a folder. Idempotent for the same canonical path. Writes only to the data dir. */
  add(path: string, name: string | undefined, at: string): Promise<Project> {
    return this.serial(async () => {
      if (!isAbsolute(path)) throw new RegistryError("not_found", "Give an absolute folder path");
      let canonical: string;
      try {
        canonical = await realpath(path);
      } catch {
        throw new RegistryError("not_found", `${path} does not exist`);
      }
      if (!(await stat(canonical)).isDirectory())
        throw new RegistryError("not_a_directory", `${canonical} is not a folder`);
      const dataDir = await realpath(this.dataDir).catch(() => this.dataDir);
      const rel = relative(dataDir, canonical);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
        throw new RegistryError(
          "inside_data_dir",
          "Konsora's own data folder cannot be linked as a project",
        );
      }
      const projects = await this.list();
      const existing = projects.find((p) => p.path === canonical);
      if (existing) return existing;
      const project: Project = {
        id: projectId(canonical),
        name: (name ?? basename(canonical)).slice(0, 80) || canonical,
        path: canonical,
        added_at: at,
      };
      await this.save([...projects, project]);
      return project;
    });
  }

  /** Unlinks a project from Konsora. Its folder and files are left untouched. */
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const projects = await this.list();
      if (!projects.some((p) => p.id === id))
        throw new RegistryError("not_registered", `Project ${id} is not linked`);
      await this.save(projects.filter((p) => p.id !== id));
    });
  }

  private async save(projects: Project[]) {
    await writePrivateFile(this.file, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
