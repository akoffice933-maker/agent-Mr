// Client-side fetch wrapper: attaches the optional agent API key (stored in
// localStorage via the "API key" field in Settings) when the server enforces one.

export function getStoredApiKey(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("agent_api_key");
}

export function setStoredApiKey(key: string): void {
  window.localStorage.setItem("agent_api_key", key.trim());
}

export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const key = getStoredApiKey();
  if (key) headers.set("x-api-key", key);
  return fetch(url, { ...init, headers });
}
