import { describe, expect, it } from "vitest";
import { ApiError, createApi } from "../src/api/client.ts";
import { bootstrapSession, TOKEN_KEY } from "../src/api/session.ts";
import { linkErrorText, planLabel } from "../src/shell/ProjectsPage.tsx";
import { parseRoute, projectHref } from "../src/shell/route.ts";

const token = "ab".repeat(32);

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("session bootstrap", () => {
  it("moves the token from the fragment to storage and routes to the project", () => {
    const storage = memoryStorage();
    expect(bootstrapSession(`#token=${token}&project=p-0123456789ab`, storage)).toEqual({
      token,
      route: "#/p/p-0123456789ab",
    });
    expect(storage.data.get(TOKEN_KEY)).toBe(token);
  });

  it("routes home when no project is given, and reuses a stored token later", () => {
    const storage = memoryStorage();
    expect(bootstrapSession(`#token=${token}`, storage).route).toBe("#/");
    expect(bootstrapSession("#/", storage)).toEqual({ token, route: null });
  });

  it("drops a malformed token from the URL without storing it", () => {
    const storage = memoryStorage();
    expect(bootstrapSession("#token=nope", storage)).toEqual({ token: null, route: "#/" });
    expect(storage.data.size).toBe(0);
  });

  it("survives blocked storage", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(bootstrapSession(`#token=${token}`, blocked).token).toBe(token);
    expect(bootstrapSession("#/", blocked).token).toBeNull();
  });
});

describe("routes", () => {
  it.each([
    ["", { name: "projects" }],
    ["#/", { name: "projects" }],
    ["#/p/p-0123456789ab", { name: "project", id: "p-0123456789ab", view: "board", task: null }],
    [
      "#/p/p-0123456789ab?view=graph&task=UI-05",
      { name: "project", id: "p-0123456789ab", view: "graph", task: "UI-05" },
    ],
    [
      "#/p/p-0123456789ab?view=nope&task=",
      { name: "project", id: "p-0123456789ab", view: "board", task: null },
    ],
    ["#/muestrario", { name: "projects" }],
    ["#/maqueta", { name: "projects" }],
    ["#/whatever", { name: "projects" }],
  ])("%s", (hash, route) => expect(parseRoute(hash)).toEqual(route));

  it("builds project links that parse back to the same view and task", () => {
    expect(projectHref("p-1")).toBe("#/p/p-1");
    expect(projectHref("p-1", { task: "UI-05" })).toBe("#/p/p-1?task=UI-05");
    const href = projectHref("p-1", { view: "graph", task: "UI-05" });
    expect(href).toBe("#/p/p-1?view=graph&task=UI-05");
    expect(parseRoute(href)).toEqual({ name: "project", id: "p-1", view: "graph", task: "UI-05" });
  });
});

const failed = (): never => {
  throw new Error("expected the request to fail");
};

describe("api client", () => {
  it("sends the bearer token and JSON body", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const api = createApi(token, {
      fetch: async (url, init) => {
        seen = { url: String(url), init: init ?? {} };
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      },
    });
    expect(await api.post("/projects", { path: "/x" })).toEqual({ ok: true });
    expect(seen?.url).toBe("/api/projects");
    expect(new Headers(seen?.init.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(seen?.init.body).toBe('{"path":"/x"}');
  });

  it("turns error bodies, 403 and network failures into ApiError", async () => {
    const reply = (status: number, body: unknown) =>
      createApi(token, { fetch: async () => new Response(JSON.stringify(body), { status }) });
    const notFound = await reply(400, { error: { code: "not_found", message: "nope" } })
      .get("/x")
      .then(failed, (e: unknown) => e as ApiError);
    expect(notFound).toBeInstanceOf(ApiError);
    expect(notFound).toMatchObject({ status: 400, code: "not_found", unauthorized: false });
    const denied = await reply(403, { error: { code: "forbidden" } })
      .get("/x")
      .then(failed, (e: unknown) => e as ApiError);
    expect(denied.unauthorized).toBe(true);
    const offline = await createApi(token, {
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    })
      .get("/x")
      .then(failed, (e: unknown) => e as ApiError);
    expect(offline).toMatchObject({ status: 0, code: "network" });
  });
});

describe("project list texts", () => {
  it("labels each plan status in Spanish", () => {
    expect(planLabel({ status: "ok", tasks: 3, hash: "h" })).toBe("3 tareas");
    expect(planLabel({ status: "missing", message: "m" })).toContain("konsora init");
    expect(planLabel({ status: "invalid", message: "m" })).toContain("inválido");
  });

  it("maps link errors to actionable messages", () => {
    expect(linkErrorText(new ApiError(400, "not_a_directory", "x"))).toBe(
      "Esa ruta no es una carpeta.",
    );
    expect(linkErrorText(new ApiError(500, "internal", "boom"))).toBe("Algo ha fallado: boom");
  });
});
