// POST /api/billing/checkout — start a plan upgrade.
//
// Only an owner/admin of the organization may spend its money, so this runs
// inside the normal tenant context and checks the role.

import { NextResponse } from "next/server";
import { withTenantRequest } from "@/lib/tenant/request";
import { identityPool } from "@/lib/tenant/pool";
import { isPlanId, PLANS } from "@/lib/billing/plans";
import {
  availableProviders,
  createStripeCheckout,
  createYooKassaPayment,
  stripeConfigured,
  yookassaConfigured,
  type ProviderId,
} from "@/lib/billing/providers";
import { appBaseUrl } from "@/lib/mail";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    plans: Object.values(PLANS),
    providers: availableProviders(),
  });
}

export async function POST(req: Request) {
  return withTenantRequest(req, async (ctx) => {
    // Machine keys carry no human identity; buying a plan is a human act.
    if (!ctx.userId) {
      return NextResponse.json({ error: "unauthorized", reason: "Требуется вход." }, { status: 401 });
    }
    if (ctx.role !== "owner" && ctx.role !== "admin") {
      return NextResponse.json(
        { error: "forbidden", reason: "Изменить тариф может только владелец или администратор организации." },
        { status: 403 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as { plan?: string; provider?: string };
    const plan = body.plan ?? "pro";
    if (!isPlanId(plan) || plan === "free") {
      return NextResponse.json({ error: "bad_request", reason: "Некорректный тариф." }, { status: 400 });
    }

    const providers = availableProviders();
    if (providers.length === 0) {
      return NextResponse.json(
        { error: "billing_unavailable", reason: "Приём платежей не настроен на этом сервере." },
        { status: 503 }
      );
    }
    const provider = (body.provider as ProviderId) ?? providers[0];
    if (!providers.includes(provider)) {
      return NextResponse.json({ error: "bad_request", reason: "Провайдер недоступен." }, { status: 400 });
    }

    const userRes = (await identityPool.query("SELECT email FROM users WHERE id = $1 LIMIT 1", [ctx.userId])) as {
      rows: { email: string }[];
    };
    const email = userRes.rows[0]?.email ?? "";

    const base = appBaseUrl();
    const checkoutReq = {
      orgId: ctx.orgId,
      plan,
      email,
      successUrl: `${base}/billing?status=success`,
      cancelUrl: `${base}/billing?status=cancelled`,
    };

    try {
      const session =
        provider === "stripe" && stripeConfigured()
          ? await createStripeCheckout(checkoutReq)
          : provider === "yookassa" && yookassaConfigured()
            ? await createYooKassaPayment(checkoutReq)
            : null;

      if (!session) {
        return NextResponse.json({ error: "billing_unavailable", reason: "Провайдер не настроен." }, { status: 503 });
      }
      log.info("billing.checkout_created", { orgId: ctx.orgId, provider, plan });
      return NextResponse.json({ ok: true, url: session.url, provider });
    } catch (e) {
      log.error("billing.checkout_failed", { orgId: ctx.orgId, provider, plan }, e);
      return NextResponse.json(
        { error: "provider_error", reason: "Не удалось создать платёж. Попробуйте позже." },
        { status: 502 }
      );
    }
  });
}
