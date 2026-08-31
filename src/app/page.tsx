// Root route — the funnel entry point (ТЗ §5.1, критерий приёмки №1).
//
// Before: `/` WAS the dashboard, wrapped in withTenantPage(). An anonymous
// visitor typing the bare domain got a 307 to /login with no explanation of
// what the product even is. The dashboard now lives at /dashboard and this
// route only decides where the visitor belongs:
//
//   valid session → /dashboard   (returning user, ТЗ §4 шаг 17)
//   no session    → /welcome     (public landing, ТЗ §4 шаги 1–2)
//
// Identity comes from the DAL (session cookie verified against the DB), never
// from x-tenant-* headers — ТЗ §8.2. No tenant data is read here, so there is
// no RLS transaction to open: getTenantContextOrNull() only resolves identity,
// and for a visitor with no cookie it does not touch the database at all.

import { redirect } from "next/navigation";
import { getTenantContextOrNull } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

export default async function RootPage() {
  const ctx = await getTenantContextOrNull();
  redirect(ctx ? "/dashboard" : "/welcome");
}
