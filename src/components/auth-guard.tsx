"use client";

// Client-side auth guard: checks /api/auth/me once on mount.
//   authMode=off          → render children (sandbox/dev)
//   authMode=on + user    → render children, expose the user (module store)
//   authMode=on + 401     → redirect to /login?next=<path>
import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isPublicPage } from "@/lib/public-routes";

export interface AuthUser {
  id: number;
  email: string;
  name?: string;
  role: string;
}

// Tiny module store so the sidebar can read the current user without prop-drilling.
const store: { user: AuthUser | null; authMode: "off" | "on" | null; listeners: Set<() => void> } = {
  user: null,
  authMode: null,
  listeners: new Set(),
};

export function subscribeAuth(fn: () => void): () => void {
  store.listeners.add(fn);
  return () => store.listeners.delete(fn);
}

export function getAuth() {
  return { user: store.user, authMode: store.authMode };
}

export function AuthGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [state, setState] = useState<"checking" | "ok" | "redirecting">("checking");

  useEffect(() => {
    let alive = true;
    (async () => {
      let res: Response;
      try {
        res = await fetch("/api/auth/me", { credentials: "same-origin" });
      } catch {
        if (alive) setState("ok"); // network hiccup — let the app render; API calls will 401 visibly
        return;
      }
      if (!alive) return;
      if (res.ok) {
        const d = (await res.json()) as { authMode: "on" | "off"; user?: AuthUser };
        store.authMode = d.authMode;
        store.user = d.user ?? null;
        store.listeners.forEach((fn) => fn());
        setState("ok");
      } else if (!isPublicPage(pathname)) {
        store.authMode = "on";
        setState("redirecting");
        router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      } else {
        setState("ok");
      }
    })();
    return () => {
      alive = false;
    };
  }, [pathname, router]);

  if (isPublicPage(pathname)) return <>{children}</>;
  if (state === "checking" || state === "redirecting") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-sm text-fog">Проверяем сессию…</div>
      </div>
    );
  }
  return <>{children}</>;
}
