// Review M1 (decision: TRUSTED_PROXY): rate limiting / login lockout must not
// trust a client-spoofable X-Forwarded-For. This tests the pure decision
// function so it can be covered without a DB or server.

import { describe, expect, it } from "vitest";
import { resolveClientIp, ipInCidr } from "@/proxy";

function h(values: Record<string, string>) {
  return { get: (name: string) => values[name.toLowerCase()] ?? null } as Pick<Headers, "get">;
}

describe("ipInCidr", () => {
  it("matches exact IP and CIDR", () => {
    expect(ipInCidr("10.0.0.5", "10.0.0.0/8")).toBe(true);
    expect(ipInCidr("10.0.0.5", "10.0.0.5")).toBe(true);
    expect(ipInCidr("192.168.1.1", "10.0.0.0/8")).toBe(false);
  });
  it("rejects malformed input", () => {
    expect(ipInCidr("not-an-ip", "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("10.0.0.1", "10.0.0.0/33")).toBe(false);
  });
});

describe("resolveClientIp — trusted proxy gating", () => {
  it("trusts the first XFF hop when the last hop is a trusted proxy", () => {
    const ip = resolveClientIp(h({ "x-forwarded-for": "1.2.3.4, 10.0.0.9" }), ["10.0.0.0/8"]);
    expect(ip).toBe("1.2.3.4");
  });

  it("does NOT trust XFF when the peer is not a trusted proxy (spoof attempt)", () => {
    // Attacker forges a trusted value in XFF but connects from elsewhere.
    const ip = resolveClientIp(h({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }), ["10.0.0.0/8"]);
    expect(ip).toBe("untrusted"); // x-real-ip absent → untrusted
  });

  it("requires >1 hop so a direct client cannot claim to be the proxy", () => {
    const ip = resolveClientIp(h({ "x-forwarded-for": "10.0.0.9" }), ["10.0.0.0/8"]);
    expect(ip).toBe("untrusted");
  });

  it("falls back to x-real-ip when the peer is untrusted", () => {
    const ip = resolveClientIp(h({ "x-forwarded-for": "1.2.3.4, 203.0.113.7", "x-real-ip": "8.8.8.8" }), ["10.0.0.0/8"]);
    expect(ip).toBe("8.8.8.8");
  });

  it("with no TRUSTED_PROXY configured, keeps legacy behavior (first XFF hop)", () => {
    const ip = resolveClientIp(h({ "x-forwarded-for": "6.6.6.6, 1.1.1.1" }), []);
    expect(ip).toBe("6.6.6.6");
  });
});
