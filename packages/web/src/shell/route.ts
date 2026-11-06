/**
 * Hash routes: `#/` projects, `#/p/<id>` a project, `#/limites` the usage limits,
 * `#/muestrario` gallery, `#/maqueta` mock.
 * A project route carries its view and open task as a query, so both survive a reload and can be
 * linked: `#/p/<id>?view=graph&task=UI-05`.
 */
import { useEffect, useState } from "react";

export type ProjectViewName = "board" | "graph" | "settings";
export const projectViews: readonly ProjectViewName[] = ["board", "graph", "settings"];

export type Route =
  | { name: "projects" }
  | { name: "project"; id: string; view: ProjectViewName; task: string | null }
  | { name: "limits" }
  | { name: "gallery" }
  | { name: "mock" };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const at = raw.indexOf("?");
  const path = at < 0 ? raw : raw.slice(0, at);
  const query = new URLSearchParams(at < 0 ? "" : raw.slice(at + 1));
  if (path === "/muestrario") return { name: "gallery" };
  if (path === "/maqueta") return { name: "mock" };
  if (path === "/limites") return { name: "limits" };
  const project = /^\/p\/([^/]+)$/.exec(path);
  if (project?.[1]) {
    const view = query.get("view");
    return {
      name: "project",
      id: decodeURIComponent(project[1]),
      view: view === "graph" || view === "settings" ? view : "board",
      task: query.get("task") || null,
    };
  }
  return { name: "projects" };
}

/** Link to a project; the board without an open task is the bare `#/p/<id>`. */
export function projectHref(
  id: string,
  { view = "board", task = null }: { view?: ProjectViewName; task?: string | null } = {},
): string {
  const query = new URLSearchParams();
  if (view !== "board") query.set("view", view);
  if (task) query.set("task", task);
  const search = query.toString();
  return `#/p/${encodeURIComponent(id)}${search ? `?${search}` : ""}`;
}

export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return parseRoute(hash);
}

/** Goes to a hash route (a new history entry, so Back undoes it). */
export function navigate(href: string) {
  if (window.location.hash !== href) window.location.hash = href;
}
