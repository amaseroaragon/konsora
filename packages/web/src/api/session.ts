/**
 * Session token bootstrap (docs/arquitectura.md §4). `konsora ui` opens `/#token=…[&project=…]`;
 * the token moves to sessionStorage and the fragment is replaced by a route, so it never stays in
 * the address bar or history. A later visit in the same tab reuses the stored token.
 */
export const TOKEN_KEY = "konsora.token";
const TOKEN = /^[0-9a-f]{64}$/;

export type Bootstrap = {
  token: string | null;
  /** Route to replace the fragment with, when the fragment carried a token. */
  route: string | null;
};

export function bootstrapSession(
  hash: string,
  storage: Pick<Storage, "getItem" | "setItem">,
): Bootstrap {
  const fragment = hash.replace(/^#/, "");
  if (!fragment.startsWith("/")) {
    const params = new URLSearchParams(fragment);
    const token = params.get("token");
    if (token !== null) {
      const project = params.get("project");
      const route = project ? `#/p/${encodeURIComponent(project)}` : "#/";
      if (!TOKEN.test(token)) return { token: readStored(storage), route };
      try {
        storage.setItem(TOKEN_KEY, token);
      } catch {
        // Storage blocked: the token still works for this page load.
      }
      return { token, route };
    }
  }
  return { token: readStored(storage), route: null };
}

function readStored(storage: Pick<Storage, "getItem">): string | null {
  try {
    const token = storage.getItem(TOKEN_KEY);
    return token && TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}
