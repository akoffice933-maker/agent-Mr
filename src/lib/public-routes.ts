// Routes reachable without a session.
//
// Single source of truth for three places that must agree, or the app either
// leaks protected pages or locks anonymous users out of the funnel:
//
//   1. src/proxy.ts       — the 307-to-/login short circuit for page requests
//   2. src/components/auth-guard.tsx — the client-side /api/auth/me guard
//   3. src/components/chrome.tsx     — whether to render the app shell (sidebar)
//
// `/` is public because it decides for itself: with a session it redirects to
// /dashboard, without one to /welcome (ТЗ §5.1). Sending an anonymous visitor
// from the root domain straight to /login was exactly the defect this list
// fixes — the product had no public entry point at all.

export const PUBLIC_PAGES: ReadonlySet<string> = new Set([
  "/",
  "/welcome",
  "/login",
  "/signup",
  // Opened from an email, often in a browser that holds no session.
  "/verify",
  // Восстановление пароля: человек по определению не может войти.
  "/forgot",
  "/reset",
]);

/** Публичные разделы целиком (юридические документы, ТЗ §5.1 п.7). */
const PUBLIC_PREFIXES = ["/legal/"];

export function isPublicPage(path: string): boolean {
  return PUBLIC_PAGES.has(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p));
}
