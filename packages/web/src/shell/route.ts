/**
 * Hash routes: `#/` projects and `#/p/<id>` a project. Any other hash leads to the projects.
 * A project route carries its view, its open task and its task filter as a query, so they survive
 * a reload and can be linked: `#/p/<id>?view=graph&task=UI-05&q=cache&label=perf`.
 */
import type { TaskFilter } from "@konsora/core";
import { useEffect, useState } from "react";

export type ProjectViewName = "board" | "graph" | "history" | "settings";
export const projectViews: readonly ProjectViewName[] = ["board", "graph", "history", "settings"];

export type Route =
  | { name: "projects" }
  | {
      name: "project";
      id: string;
      view: ProjectViewName;
      task: string | null;
      /** The task filter of the board and the graph; absent when nothing is filtered. */
      filter?: TaskFilter;
    };

/** The query parameter of each part of the filter. */
const FILTER_PARAMS = { text: "q", group: "group", label: "label", by: "by" } as const;
const FILTER_KEYS = Object.keys(FILTER_PARAMS) as (keyof typeof FILTER_PARAMS)[];

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const at = raw.indexOf("?");
  const path = at < 0 ? raw : raw.slice(0, at);
  const query = new URLSearchParams(at < 0 ? "" : raw.slice(at + 1));
  const project = /^\/p\/([^/]+)$/.exec(path);
  if (project?.[1]) {
    const view = query.get("view");
    const filter: TaskFilter = {};
    for (const key of FILTER_KEYS) {
      const value = query.get(FILTER_PARAMS[key]);
      if (value) filter[key] = value;
    }
    return {
      name: "project",
      id: decodeURIComponent(project[1]),
      view: projectViews.includes(view as ProjectViewName) ? (view as ProjectViewName) : "board",
      task: query.get("task") || null,
      // As typed (core trims when matching), so the search box does not fight the keyboard.
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    };
  }
  return { name: "projects" };
}

/** Link to a project; the board without an open task is the bare `#/p/<id>`. */
export function projectHref(
  id: string,
  {
    view = "board",
    task = null,
    filter = {},
  }: { view?: ProjectViewName; task?: string | null; filter?: TaskFilter } = {},
): string {
  const query = new URLSearchParams();
  if (view !== "board") query.set("view", view);
  if (task) query.set("task", task);
  for (const key of FILTER_KEYS) {
    const value = filter[key];
    if (value) query.set(FILTER_PARAMS[key], value);
  }
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

/** Changes the hash route in place, without a history entry: for what is typed, like a filter. */
export function replaceRoute(href: string) {
  if (window.location.hash === href) return;
  const { pathname, search } = window.location;
  window.history.replaceState(null, "", `${pathname}${search}${href}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
