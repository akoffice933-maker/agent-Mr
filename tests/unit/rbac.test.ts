import { describe, expect, it } from "vitest";
import { authorize, parseRole, RISK, type Action, type Role } from "@/lib/agent/rbac";

const EXEC: Action[] = ["execute_campaign_status", "execute_bids", "execute_budget", "execute_promotion", "execute_negative"];

describe("RBAC matrix (Phase D)", () => {
  it("viewer: read + recommend only", () => {
    expect(authorize({ role: "viewer", action: "read" }).decision).toBe("ALLOW");
    expect(authorize({ role: "viewer", action: "recommend" }).decision).toBe("ALLOW");
    for (const a of EXEC) expect(authorize({ role: "viewer", action: a }).decision).toBe("DENY");
    expect(authorize({ role: "viewer", action: "credentials" }).decision).toBe("DENY");
    expect(authorize({ role: "viewer", action: "policy" }).decision).toBe("DENY");
  });

  it("analyst: read + recommend only (same as viewer for execution)", () => {
    expect(authorize({ role: "analyst", action: "read" }).decision).toBe("ALLOW");
    expect(authorize({ role: "analyst", action: "recommend" }).decision).toBe("ALLOW");
    for (const a of EXEC) expect(authorize({ role: "analyst", action: a }).decision).toBe("DENY");
  });

  it("media_buyer: executes allowed, budget requires approval, no credentials/policy", () => {
    expect(authorize({ role: "media_buyer", action: "execute_campaign_status" }).decision).toBe("ALLOW");
    expect(authorize({ role: "media_buyer", action: "execute_negative" }).decision).toBe("ALLOW");
    expect(authorize({ role: "media_buyer", action: "execute_budget" }).decision).toBe("REQUIRE_APPROVAL");
    expect(authorize({ role: "media_buyer", action: "credentials" }).decision).toBe("DENY");
    expect(authorize({ role: "media_buyer", action: "policy" }).decision).toBe("DENY");
    expect(authorize({ role: "media_buyer", action: "read" }).decision).toBe("ALLOW");
  });

  it("admin: everything except manage_members", () => {
    for (const a of [...EXEC, "read", "recommend", "credentials", "policy"] as Action[]) {
      expect(authorize({ role: "admin", action: a }).decision, a).toBe("ALLOW");
    }
    expect(authorize({ role: "admin", action: "manage_members" }).decision).toBe("DENY");
  });

  it("owner: everything", () => {
    for (const a of [...EXEC, "read", "recommend", "credentials", "policy", "manage_members"] as Action[]) {
      expect(authorize({ role: "owner", action: a }).decision, a).toBe("ALLOW");
    }
  });
});

describe("RBAC risk dimension (Role + Action + Resource + Risk = Decision)", () => {
  it("media buyer bids: within cap → ALLOW", () => {
    const r = authorize({ role: "media_buyer", action: "execute_bids", context: { bidChangePercent: 5 } });
    expect(r.decision).toBe("ALLOW");
  });

  it("media buyer bids: above cap, within deny bound → LIMITED with clamp", () => {
    const r = authorize({ role: "media_buyer", action: "execute_bids", context: { bidChangePercent: 20 } });
    expect(r.decision).toBe("LIMITED");
    expect(r.bidPercentCap).toBe(RISK.bidPercentCap);
    const rDown = authorize({ role: "media_buyer", action: "execute_bids", context: { bidChangePercent: -20 } });
    expect(rDown.bidPercentCap).toBe(-RISK.bidPercentCap);
  });

  it("media buyer bids: beyond deny bound → DENY", () => {
    const r = authorize({ role: "media_buyer", action: "execute_bids", context: { bidChangePercent: 50 } });
    expect(r.decision).toBe("DENY");
    expect(r.reason).toContain("Медиа-байер");
  });

  it("large costDaily for media buyer → REQUIRE_APPROVAL", () => {
    const r = authorize({ role: "media_buyer", action: "execute_promotion", context: { costDaily: 15000 } });
    expect(r.decision).toBe("REQUIRE_APPROVAL");
  });

  it("large budget delta → REQUIRE_APPROVAL for non-owner roles (even admin)", () => {
    expect(authorize({ role: "media_buyer", action: "execute_budget", context: { budgetDelta: 50000 } }).decision).toBe("REQUIRE_APPROVAL");
    expect(authorize({ role: "admin", action: "execute_budget", context: { budgetDelta: 50000 } }).decision).toBe("REQUIRE_APPROVAL");
    expect(authorize({ role: "owner", action: "execute_budget", context: { budgetDelta: 50000 } }).decision).toBe("ALLOW");
  });

  it("admin/owner bids are not capped by the buyer cap", () => {
    expect(authorize({ role: "admin", action: "execute_bids", context: { bidChangePercent: 50 } }).decision).toBe("ALLOW");
    expect(authorize({ role: "owner", action: "execute_bids", context: { bidChangePercent: 50 } }).decision).toBe("ALLOW");
  });
});

describe("parseRole fail-closed (E.1 P0-4)", () => {
  it("known roles parse to themselves", () => {
    expect(parseRole("owner")).toBe("owner");
    expect(parseRole("admin")).toBe("admin");
    expect(parseRole("media_buyer")).toBe("media_buyer");
    expect(parseRole("analyst")).toBe("analyst");
    expect(parseRole("viewer")).toBe("viewer");
  });

  it("unknown/missing role NEVER escalates to admin — it degrades to the least-privileged viewer", () => {
    expect(parseRole("garbage")).toBe("viewer");
    expect(parseRole("ADMIN")).toBe("viewer"); // case-sensitive: not a known role
    expect(parseRole("")).toBe("viewer");
    expect(parseRole(null)).toBe("viewer");
    expect(parseRole(undefined)).toBe("viewer");
  });

  it("a viewer parsed from garbage holds no execute permission", () => {
    const role = parseRole("corrupted-row-value");
    for (const action of EXEC) {
      expect(authorize({ role, action }).decision).toBe("DENY");
    }
    expect(authorize({ role, action: "read" }).decision).toBe("ALLOW");
  });
});
