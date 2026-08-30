import { describe, expect, it } from "vitest";
import { hasScope, normalizeScopes, roleForScopes, scopeForAction } from "@/lib/agent/scopes";
import { authorize } from "@/lib/agent/rbac";

describe("machine capability scopes", () => {
  it("maps execution actions to narrow capabilities", () => {
    expect(scopeForAction("execute_campaign_status")).toBe("campaigns:write");
    expect(scopeForAction("execute_bids")).toBe("bids:write");
    expect(scopeForAction("execute_budget")).toBe("budget:write");
    expect(scopeForAction("read")).toBe("read");
  });
  it("deduplicates and drops unknown scopes", () => {
    expect(normalizeScopes(["read", "read", "nope"])).toEqual(["read"]);
  });
  it("null means legacy unrestricted, arrays are explicit", () => {
    expect(hasScope(null, "budget:write")).toBe(true);
    expect(hasScope(["read"], "budget:write")).toBe(false);
  });
});

// Review P2: the proxy used to stamp role "admin" on EVERY machine key, so a
// read-only key satisfied every role check and only the scope check stood
// between it and a live budget change. The role is now derived from scopes.
describe("machine key role is derived from its scopes (review P2)", () => {
  it("a read-only key is a viewer, not an admin", () => {
    expect(roleForScopes(["read"])).toBe("viewer");
  });

  it("ad-surface write scopes grant media_buyer, not admin", () => {
    expect(roleForScopes(["read", "campaigns:write"])).toBe("media_buyer");
    expect(roleForScopes(["budget:write"])).toBe("media_buyer");
  });

  it("admin surfaces (credentials/policy/members) grant admin", () => {
    expect(roleForScopes(["credentials"])).toBe("admin");
    expect(roleForScopes(["policy"])).toBe("admin");
    expect(roleForScopes(["members"])).toBe("admin");
  });

  it("an empty scope list is the least privilege", () => {
    expect(roleForScopes([])).toBe("viewer");
  });

  it("a legacy NULL-scope key stays unrestricted (backward compatibility)", () => {
    expect(roleForScopes(null)).toBe("admin");
  });

  it("RBAC now DENIES a read-only key the execute actions it lacks", () => {
    const role = roleForScopes(["read"]);
    // Pre-fix this role was "admin" and authorize() allowed the action.
    expect(authorize({ role, action: "execute_budget" }).decision).toBe("DENY");
    expect(authorize({ role, action: "execute_campaign_status" }).decision).toBe("DENY");
    expect(authorize({ role, action: "manage_members" }).decision).toBe("DENY");
  });

  it("a campaigns:write key can act on campaigns but not manage members", () => {
    const role = roleForScopes(["campaigns:write"]);
    expect(authorize({ role, action: "manage_members" }).decision).toBe("DENY");
    expect(authorize({ role, action: "execute_campaign_status" }).decision).not.toBe("DENY");
  });
});
