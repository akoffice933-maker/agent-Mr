"use client";

// App shell.
//
// The layout used to wrap EVERY route in <AuthGuard> + <Sidebar>, which meant
// the public pages (login, signup, and now the landing) rendered the product
// navigation of an app the visitor has no account for. Chrome keeps the shell
// for the authenticated product and renders public pages bare.
//
// Client component on purpose: the decision needs the pathname, and making the
// landing itself a server component (ISR) matters far more than saving this
// one tiny client boundary.

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { AuthGuard } from "@/components/auth-guard";
import { isPublicPage } from "@/lib/public-routes";

export function Chrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (isPublicPage(pathname)) return <>{children}</>;

  return (
    <AuthGuard>
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="min-w-0 flex-1 lg:pl-64">
          <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 lg:px-8">{children}</div>
        </main>
      </div>
    </AuthGuard>
  );
}
