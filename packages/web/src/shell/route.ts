/** Hash routes: `#/` projects, `#/p/<id>` a project, `#/muestrario` gallery, `#/maqueta` mock. */
import { useEffect, useState } from "react";

export type Route =
  | { name: "projects" }
  | { name: "project"; id: string }
  | { name: "gallery" }
  | { name: "mock" };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "");
  if (path === "/muestrario") return { name: "gallery" };
  if (path === "/maqueta") return { name: "mock" };
  const project = /^\/p\/([^/?]+)$/.exec(path);
  if (project?.[1]) return { name: "project", id: decodeURIComponent(project[1]) };
  return { name: "projects" };
}

export const projectHref = (id: string) => `#/p/${encodeURIComponent(id)}`;

export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return parseRoute(hash);
}
