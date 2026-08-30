// Webhook verification and event normalisation.
//
// A billing webhook endpoint is unauthenticated by necessity — the provider
// has no session and no API key. Signature verification is therefore the ONLY
// thing between the endpoint and anyone who wants to grant themselves a paid
// plan, so it gets tested like the security control it is.

import { describe, expect, it } from "vitest";
import { createHmac } from "crypto";
import {
  verifyStripeSignature,
  normalizeStripeEvent,
  normalizeYooKassaEvent,
  verifyYooKassaSecret,
} from "@/lib/billing/providers";

const SECRET = "whsec_test_secret";

function stripeHeader(body: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${sig}`;
}

describe("Stripe signature verification", () => {
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });

  it("accepts a correctly signed payload", () => {
    expect(verifyStripeSignature(body, stripeHeader(body), SECRET)).toBe(true);
  });

  it("REJECTS a payload signed with the wrong secret", () => {
    expect(verifyStripeSignature(body, stripeHeader(body, "whsec_attacker"), SECRET)).toBe(false);
  });

  it("REJECTS a tampered body", () => {
    // The attack: capture a real event, change org_id/plan, replay it.
    const header = stripeHeader(body);
    const tampered = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", extra: "injected" });
    expect(verifyStripeSignature(tampered, header, SECRET)).toBe(false);
  });

  it("REJECTS a replayed old event", () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(verifyStripeSignature(body, stripeHeader(body, SECRET, old), SECRET)).toBe(false);
  });

  it("rejects malformed or missing headers", () => {
    expect(verifyStripeSignature(body, "", SECRET)).toBe(false);
    expect(verifyStripeSignature(body, "garbage", SECRET)).toBe(false);
    expect(verifyStripeSignature(body, "t=abc,v1=def", SECRET)).toBe(false);
    // No secret configured must never mean "accept".
    expect(verifyStripeSignature(body, stripeHeader(body), "")).toBe(false);
  });
});

describe("Stripe event normalisation", () => {
  it("extracts org and plan from metadata", () => {
    const n = normalizeStripeEvent({
      id: "evt_2",
      type: "checkout.session.completed",
      data: { object: { metadata: { org_id: "42", plan: "pro" }, customer: "cus_1", subscription: "sub_1" } },
    });
    expect(n.orgId).toBe(42);
    expect(n.plan).toBe("pro");
    expect(n.status).toBe("active");
  });

  it("falls back to client_reference_id when metadata is absent", () => {
    const n = normalizeStripeEvent({
      id: "evt_3",
      type: "checkout.session.completed",
      data: { object: { client_reference_id: "7" } },
    });
    expect(n.orgId).toBe(7);
  });

  it("never invents an org from a non-numeric reference", () => {
    // Guards against attributing a payment to the wrong tenant.
    const n = normalizeStripeEvent({
      id: "evt_4",
      type: "checkout.session.completed",
      data: { object: { client_reference_id: "'; DROP TABLE users; --" } },
    });
    expect(n.orgId).toBeNull();
  });

  it("maps a cancellation to the free plan", () => {
    const n = normalizeStripeEvent({
      id: "evt_5",
      type: "customer.subscription.deleted",
      data: { object: { metadata: { org_id: "9", plan: "pro" } } },
    });
    expect(n.status).toBe("canceled");
    // Whatever the metadata says, a cancelled subscription grants nothing.
    expect(n.plan).toBe("free");
  });

  it("maps a failed payment to past_due, not to cancellation", () => {
    const n = normalizeStripeEvent({
      id: "evt_6",
      type: "invoice.payment_failed",
      data: { object: { metadata: { org_id: "9", plan: "pro" } } },
    });
    expect(n.status).toBe("past_due");
  });

  it("ignores unrelated event types", () => {
    const n = normalizeStripeEvent({ id: "evt_7", type: "customer.created", data: { object: {} } });
    expect(n.status).toBe("ignored");
  });
});

describe("ЮKassa", () => {
  it("grants a month on a successful payment", () => {
    const n = normalizeYooKassaEvent({
      event: "payment.succeeded",
      object: { id: "pay_1", status: "succeeded", paid: true, metadata: { org_id: "5", plan: "pro" } },
    });
    expect(n.orgId).toBe(5);
    expect(n.status).toBe("active");
    expect(n.currentPeriodEnd).toBeInstanceOf(Date);
    expect(n.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now());
  });

  it("treats a refund as cancellation", () => {
    const n = normalizeYooKassaEvent({
      event: "refund.succeeded",
      object: { id: "pay_2", metadata: { org_id: "5", plan: "pro" } },
    });
    expect(n.status).toBe("canceled");
    expect(n.plan).toBe("free");
  });

  it("builds a distinct event id per payment and event type", () => {
    // ЮKassa sends no event id; without this, two different events for the
    // same payment would collide and the second would be dropped as duplicate.
    const a = normalizeYooKassaEvent({ event: "payment.succeeded", object: { id: "pay_3" } });
    const b = normalizeYooKassaEvent({ event: "refund.succeeded", object: { id: "pay_3" } });
    expect(a.eventId).not.toBe(b.eventId);
  });

  it("shared secret: absent config accepts, configured config enforces", () => {
    delete process.env.YOOKASSA_WEBHOOK_SECRET;
    expect(verifyYooKassaSecret(null)).toBe(true);

    process.env.YOOKASSA_WEBHOOK_SECRET = "s3cret";
    expect(verifyYooKassaSecret("s3cret")).toBe(true);
    expect(verifyYooKassaSecret("wrong")).toBe(false);
    expect(verifyYooKassaSecret(null)).toBe(false);
    delete process.env.YOOKASSA_WEBHOOK_SECRET;
  });
});
