// Client-side fetch wrapper (Phase B): the browser authenticates via the
// HttpOnly session cookie set at login — NO credentials in JS, NO localStorage.
// Mutating requests carry X-Agent-Csrf (checked by the proxy for session auth).

export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-Agent-Csrf", "1");
  }
  return fetch(url, { ...init, headers, credentials: "same-origin" });
}
