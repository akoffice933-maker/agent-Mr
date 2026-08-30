// GET /api/billing/usage — current plan, live consumption and the plan catalog.
//
// Powers the /billing page. Read-only and safe for any member of the org:
// knowing how much of your own plan you have used is not privileged data, and
// hiding it from non-admins would leave them guessing why writes get refused.

import { NextResponse } from "next/server";
import { withTenantRequest } from "@/lib/tenant/request";
import { usageSummary } from "@/lib/billing/quota";
import { PLANS } from "@/lib/billing/plans";
import { availableProviders } from "@/lib/billing/providers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  return withTenantRequest(req, async (ctx) => {
    const usage = await usageSummary(ctx.orgId);
    return NextResponse.json(
      {
        usage,
        plans: Object.values(PLANS),
        providers: availableProviders(),
        // Only owners/admins may actually pay — the UI hides the button for
        // everyone else instead of letting them hit a 403.
        canManageBilling: ctx.role === "owner" || ctx.role === "admin",
      },
      { headers: { "cache-control": "no-store" } }
    );
  });
}
