// Payment providers behind one interface: Stripe (cards, international) and
// ЮKassa (Russian market — the primary audience of this product).
//
// The application never imports a provider SDK directly; it asks for a
// checkout URL and reacts to normalised webhook events. Adding a provider
// means implementing this interface, not touching billing logic.

import { createHmac, timingSafeEqual } from "crypto";
import type { PlanId } from "./plans";
import { PLANS } from "./plans";

export type ProviderId = "stripe" | "yookassa";

export interface CheckoutRequest {
  orgId: number;
  plan: PlanId;
  email: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  url: string;
  providerRef: string;
}

/** A webhook normalised into the only facts billing needs. */
export interface NormalizedEvent {
  provider: ProviderId;
  eventId: string;
  eventType: string;
  orgId: number | null;
  plan: PlanId | null;
  /** active | past_due | canceled | ignored */
  status: "active" | "past_due" | "canceled" | "ignored";
  currentPeriodEnd: Date | null;
  customerId: string | null;
  subscriptionId: string | null;
}

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

export function yookassaConfigured(): boolean {
  return Boolean(process.env.YOOKASSA_SHOP_ID?.trim() && process.env.YOOKASSA_SECRET_KEY?.trim());
}

export function availableProviders(): ProviderId[] {
  const out: ProviderId[] = [];
  if (yookassaConfigured()) out.push("yookassa");
  if (stripeConfigured()) out.push("stripe");
  return out;
}

// ── Stripe ─────────────────────────────────────────────────────────────────

/**
 * Verify a Stripe signature header (`t=...,v1=...`).
 *
 * Implemented directly rather than pulling in the SDK: the algorithm is a
 * documented HMAC-SHA256 over `${timestamp}.${rawBody}`, and an unverified
 * webhook endpoint is a "give me a free Pro plan" button for anyone who finds
 * the URL. Timestamp tolerance blocks replay of an old, captured-but-valid
 * event.
 */
export function verifyStripeSignature(rawBody: string, header: string, secret: string, toleranceSec = 300): boolean {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const [k, ...v] = kv.split("=");
      return [k.trim(), v.join("=").trim()];
    })
  ) as Record<string, string>;

  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return false;

  const ts = Number(t);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;

  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createStripeCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
  const key = process.env.STRIPE_SECRET_KEY!;
  const priceId = req.plan === "pro" ? process.env.STRIPE_PRICE_PRO : undefined;
  if (!priceId) throw new Error("STRIPE_PRICE_PRO is not configured");

  const form = new URLSearchParams();
  form.set("mode", "subscription");
  form.set("line_items[0][price]", priceId);
  form.set("line_items[0][quantity]", "1");
  form.set("success_url", req.successUrl);
  form.set("cancel_url", req.cancelUrl);
  form.set("customer_email", req.email);
  // org_id travels with the session and comes back on every related webhook —
  // this is how a payment is attributed to a tenant. Without it the money
  // arrives with no idea whose plan to upgrade.
  form.set("client_reference_id", String(req.orgId));
  form.set("metadata[org_id]", String(req.orgId));
  form.set("metadata[plan]", req.plan);
  form.set("subscription_data[metadata][org_id]", String(req.orgId));
  form.set("subscription_data[metadata][plan]", req.plan);

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) throw new Error(`Stripe checkout failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { id: string; url: string };
  return { url: json.url, providerRef: json.id };
}

interface StripeEventShape {
  id?: string;
  type?: string;
  data?: {
    object?: {
      id?: string;
      customer?: string;
      subscription?: string;
      status?: string;
      current_period_end?: number;
      cancel_at_period_end?: boolean;
      client_reference_id?: string;
      metadata?: Record<string, string>;
    };
  };
}

export function normalizeStripeEvent(evt: unknown): NormalizedEvent {
  const e = (evt ?? {}) as StripeEventShape;
  const obj = e.data?.object ?? {};
  const meta = obj.metadata ?? {};
  const orgRaw = meta.org_id ?? obj.client_reference_id ?? null;
  const orgId = orgRaw !== null && /^\d+$/.test(String(orgRaw)) ? Number(orgRaw) : null;
  const planRaw = meta.plan;
  const plan: PlanId | null = planRaw === "pro" || planRaw === "free" ? planRaw : null;

  let status: NormalizedEvent["status"] = "ignored";
  switch (e.type) {
    case "checkout.session.completed":
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "invoice.payment_succeeded":
      status =
        obj.status === "past_due" || obj.status === "unpaid"
          ? "past_due"
          : obj.status === "canceled"
            ? "canceled"
            : "active";
      break;
    case "customer.subscription.deleted":
      status = "canceled";
      break;
    case "invoice.payment_failed":
      status = "past_due";
      break;
    default:
      status = "ignored";
  }

  return {
    provider: "stripe",
    eventId: String(e.id ?? ""),
    eventType: String(e.type ?? "unknown"),
    orgId,
    // A cancellation always lands on free, whatever metadata says.
    plan: status === "canceled" ? "free" : (plan ?? "pro"),
    status,
    currentPeriodEnd: obj.current_period_end ? new Date(obj.current_period_end * 1000) : null,
    customerId: obj.customer ?? null,
    subscriptionId: obj.subscription ?? obj.id ?? null,
  };
}

// ── ЮKassa ─────────────────────────────────────────────────────────────────

export async function createYooKassaPayment(req: CheckoutRequest): Promise<CheckoutSession> {
  const shopId = process.env.YOOKASSA_SHOP_ID!;
  const secret = process.env.YOOKASSA_SECRET_KEY!;
  const plan = PLANS[req.plan];

  const amount = (plan.priceMinor / 100).toFixed(2);
  // Idempotence-Key is required by the API: a retried create must not charge
  // twice. Scoped per org+plan+day so an accidental double click reuses the
  // same payment instead of opening a second one.
  const idempotenceKey = `org-${req.orgId}-${req.plan}-${new Date().toISOString().slice(0, 10)}`;

  const res = await fetch("https://api.yookassa.ru/v3/payments", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${shopId}:${secret}`).toString("base64")}`,
      "Idempotence-Key": idempotenceKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: { value: amount, currency: plan.currency },
      capture: true,
      confirmation: { type: "redirect", return_url: req.successUrl },
      description: `Agent Mr — тариф ${plan.title}, организация #${req.orgId}`,
      // Same attribution problem as Stripe: metadata is how the webhook knows
      // which tenant paid.
      metadata: { org_id: String(req.orgId), plan: req.plan },
      save_payment_method: true,
    }),
  });
  if (!res.ok) throw new Error(`YooKassa payment failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { id: string; confirmation?: { confirmation_url?: string } };
  const url = json.confirmation?.confirmation_url;
  if (!url) throw new Error("YooKassa returned no confirmation_url");
  return { url, providerRef: json.id };
}

interface YooEventShape {
  event?: string;
  object?: {
    id?: string;
    status?: string;
    paid?: boolean;
    metadata?: Record<string, string>;
    payment_method?: { id?: string };
    expires_at?: string;
  };
}

export function normalizeYooKassaEvent(evt: unknown): NormalizedEvent {
  const e = (evt ?? {}) as YooEventShape;
  const obj = e.object ?? {};
  const meta = obj.metadata ?? {};
  const orgId = meta.org_id && /^\d+$/.test(meta.org_id) ? Number(meta.org_id) : null;
  const plan: PlanId | null = meta.plan === "pro" || meta.plan === "free" ? meta.plan : null;

  let status: NormalizedEvent["status"] = "ignored";
  switch (e.event) {
    case "payment.succeeded":
      status = "active";
      break;
    case "payment.canceled":
    case "refund.succeeded":
      status = "canceled";
      break;
    case "payment.waiting_for_capture":
      status = "ignored";
      break;
    default:
      status = "ignored";
  }

  // ЮKassa charges per payment rather than running a subscription clock, so a
  // successful payment grants exactly one month of access.
  const periodEnd = status === "active" ? new Date(Date.now() + 31 * 24 * 3600 * 1000) : null;

  return {
    provider: "yookassa",
    // No separate event id in the payload: the payment id plus the event name
    // identifies the delivery uniquely enough for idempotency.
    eventId: `${obj.id ?? "unknown"}:${e.event ?? "unknown"}`,
    eventType: String(e.event ?? "unknown"),
    orgId,
    plan: status === "canceled" ? "free" : (plan ?? "pro"),
    status,
    currentPeriodEnd: periodEnd,
    customerId: obj.payment_method?.id ?? null,
    subscriptionId: obj.id ?? null,
  };
}

/**
 * ЮKassa does not sign webhooks; it documents source IP ranges instead.
 *
 * Since an unauthenticated webhook is a free-upgrade button, the handler
 * additionally re-reads the payment from the API before trusting it (see the
 * webhook route). This helper covers the optional shared-secret path: put a
 * random string in YOOKASSA_WEBHOOK_SECRET and the same value in the webhook
 * URL as ?s=... — cheap defence in depth that costs nothing when unset.
 */
export function verifyYooKassaSecret(provided: string | null): boolean {
  const expected = process.env.YOOKASSA_WEBHOOK_SECRET?.trim();
  if (!expected) return true; // not configured → rely on API re-read
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Re-read a payment from the ЮKassa API — the real source of truth. */
export async function fetchYooKassaPayment(paymentId: string): Promise<{ status: string; paid: boolean } | null> {
  if (!yookassaConfigured()) return null;
  const shopId = process.env.YOOKASSA_SHOP_ID!;
  const secret = process.env.YOOKASSA_SECRET_KEY!;
  const res = await fetch(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${shopId}:${secret}`).toString("base64")}` },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { status?: string; paid?: boolean };
  return { status: String(json.status ?? ""), paid: Boolean(json.paid) };
}
