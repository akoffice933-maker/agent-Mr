// POST /api/billing/webhook/yookassa
//
// ЮKassa does NOT sign its webhooks — it documents source IP ranges instead.
// Since an unauthenticated webhook here is a free-upgrade button, this handler
// does not trust the delivered body for anything that grants access: it
// re-reads the payment from the ЮKassa API and applies the plan only if the
// API itself says the payment succeeded. An optional shared secret (?s=...)
// adds a cheap first filter.

import { NextResponse } from "next/server";
import { fetchYooKassaPayment, normalizeYooKassaEvent, verifyYooKassaSecret, yookassaConfigured } from "@/lib/billing/providers";
import { applyPlanUpdate, markEventProcessed, recordEventOnce } from "@/lib/billing/subscription";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!yookassaConfigured()) {
    log.error("billing.yookassa_not_configured", {});
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const url = new URL(req.url);
  if (!verifyYooKassaSecret(url.searchParams.get("s"))) {
    log.warn("billing.yookassa_bad_secret", {});
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let evt: unknown;
  try {
    evt = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const norm = normalizeYooKassaEvent(evt);
  if (!norm.subscriptionId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const fresh = await recordEventOnce({
    provider: "yookassa",
    eventId: norm.eventId,
    eventType: norm.eventType,
    orgId: norm.orgId,
    payload: evt,
  });
  if (!fresh) return NextResponse.json({ ok: true, duplicate: true });

  if (norm.status === "ignored" || !norm.orgId) {
    await markEventProcessed("yookassa", norm.eventId);
    return NextResponse.json({ ok: true, ignored: true });
  }

  // Upgrades are granted only on the API's word, never the request body's.
  if (norm.status === "active") {
    const actual = await fetchYooKassaPayment(norm.subscriptionId);
    if (!actual || actual.status !== "succeeded" || !actual.paid) {
      log.warn("billing.yookassa_unverified_payment", { paymentId: norm.subscriptionId, orgId: norm.orgId });
      await markEventProcessed("yookassa", norm.eventId);
      return NextResponse.json({ ok: true, unverified: true });
    }
  }

  await applyPlanUpdate(norm.orgId, {
    plan: norm.status === "canceled" ? "free" : (norm.plan ?? "pro"),
    status: norm.status,
    provider: "yookassa",
    providerCustomerId: norm.customerId,
    providerSubscriptionId: norm.subscriptionId,
    currentPeriodEnd: norm.currentPeriodEnd,
    cancelAtPeriodEnd: false,
  });
  await markEventProcessed("yookassa", norm.eventId);
  return NextResponse.json({ ok: true });
}
