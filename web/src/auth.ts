/** The office token, shared by the settings dialog and chat. Storage may be unavailable (private mode). */
const TOKEN_KEY = "barnacle.token";

export class Unauthorized extends Error {}

let memory: string | null = null;

export const tokenStore = {
  get(): string | null {
    if (memory) return memory;
    try {
      return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  /** `remember` keeps it in localStorage; otherwise it lasts for this tab only. */
  set(token: string, remember: boolean) {
    memory = token;
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
      if (remember) localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // Kept in memory only.
    }
  },
  /** After a rotation: update wherever the old token was kept. */
  replace(token: string) {
    memory = token;
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
      if (localStorage.getItem(TOKEN_KEY)) localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // As above.
    }
  },
  clear() {
    memory = null;
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      // As above.
    }
  },
};

/** JSON call to the token-protected API. Throws Unauthorized on 401, Error(message) on other failures. */
export async function api<T>(method: string, path: string, body?: unknown, token = tokenStore.get()): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token ?? ""}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new Unauthorized();
  const data = (await res.json()) as T & { error?: string | string[] };
  if (!res.ok) throw new Error(Array.isArray(data.error) ? data.error.join("; ") : (data.error ?? res.statusText));
  return data;
}
