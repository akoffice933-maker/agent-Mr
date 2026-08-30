// POST /api/billing/webhook/stripe
//
// Unauthenticated by necessity (Stripe calls it), so the SIGNATURE is the only
// thing standing between this endpoint and anyone who wants a free Pro plan.
// Requests are rejected before the body is parsed as an event.

import { NextResponse } from "next/server";
import { normalizeStripeEvent, verifyStripeSignature } from "@/lib/billing/providers";
import { applyPlanUpdate, markEventProcessed, recordEventOnce } from "@/lib/billing/subscription";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    // Fail closed: an unconfigured secret must not mean "accept everything".
    log.error("billing.stripe_webhook_secret_missing", {});
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  // The RAW body is required: re-serialising JSON changes bytes and breaks the
  // HMAC even when the content is identical.
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";
  if (!verifyStripeSignature(raw, sig, secret)) {
    log.warn("billing.stripe_bad_signature", {});
    return NextResponse.json({ error: "bad_signature" }, { status: 400 });
  }

  let evt: unknown;
  try {
    evt = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const norm = normalizeStripeEvent(evt);
  if (!norm.eventId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  // Retries are normal Stripe behaviour; process each event exactly once.
  const fresh = await recordEventOnce({
    provider: "stripe",
    eventId: norm.eventId,
    eventType: norm.eventType,
    orgId: norm.orgId,
    payload: evt,
  });
  if (!fresh) return NextResponse.json({ ok: true, duplicate: true });

  if (norm.status === "ignored" || !norm.orgId) {
    // Acknowledged and stored, but nothing to apply — returning 200 stops
    // Stripe from retrying an event we will never act on.
    await markEventProcessed("stripe", norm.eventId);
    return NextResponse.json({ ok: true, ignored: true });
  }

  await applyPlanUpdate(norm.orgId, {
    plan: norm.status === "canceled" ? "free" : (norm.plan ?? "pro"),
    status: norm.status,
    provider: "stripe",
    providerCustomerId: norm.customerId,
    providerSubscriptionId: norm.subscriptionId,
    currentPeriodEnd: norm.currentPeriodEnd,
    cancelAtPeriodEnd: false,
  });
  await markEventProcessed("stripe", norm.eventId);
  return NextResponse.json({ ok: true });
}
