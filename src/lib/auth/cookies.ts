// Session cookie helpers. HttpOnly + SameSite=Strict; Secure when the public
// URL is https. The cookie carries ONLY the session id — no credentials.

import { COOKIE_NAME, SESSION_TTL_MS } from "./sessions";

function isSecure(): boolean {
  const url = process.env.PUBLIC_URL ?? "";
  return url.startsWith("https://");
}

export function sessionCookie(sid: string): string {
  return [
    `${COOKIE_NAME}=${sid}`,
    "HttpOnly",
    "SameSite=Strict",
    `Path=/`,
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    isSecure() ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export function readSessionCookie(req: Request): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE_NAME) return v.join("=");
  }
  return undefined;
}
