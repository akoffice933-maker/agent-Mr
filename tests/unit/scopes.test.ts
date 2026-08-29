import { describe, expect, it } from "vitest";
import { hasScope, normalizeScopes, scopeForAction } from "@/lib/agent/scopes";

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
