/** Typed fetch wrapper for the daemon's `/api`, with the session token as a Bearer header. */

export class ApiError extends Error {
  readonly status: number;
  /** Error code from the daemon's body (`forbidden`, `not_found`, …), or `network`. */
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
  /** The token is missing, wrong or from a daemon that has since restarted. */
  get unauthorized(): boolean {
    return this.status === 403 || this.status === 401;
  }
}

export type Api = {
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body?: unknown) => Promise<T>;
  del: (path: string) => Promise<void>;
};

type ErrorBody = { error?: { code?: string; message?: string } };

export function createApi(
  token: string,
  options: { base?: string; fetch?: typeof fetch } = {},
): Api {
  const base = options.base ?? "";
  const doFetch = options.fetch ?? fetch;
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${base}/api${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new ApiError(0, "network", (error as Error).message);
    }
    if (response.status === 204) return undefined as T;
    const data = (await response.json().catch(() => ({}))) as T & ErrorBody;
    if (!response.ok) {
      throw new ApiError(
        response.status,
        data.error?.code ?? "http",
        data.error?.message ?? `HTTP ${response.status}`,
      );
    }
    return data;
  }
  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    del: (path) => request("DELETE", path),
  };
}
