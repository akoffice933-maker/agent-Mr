// Capability scopes for machine/API keys.
// Session/browser auth remains role-based; scopes only constrain machine clients.

export const MACHINE_SCOPES = [
  "read",
  "campaigns:write",
  "bids:write",
  "budget:write",
  "promotion:write",
  "negative:write",
  "credentials",
  "policy",
  "members",
] as const;

export type MachineScope = (typeof MACHINE_SCOPES)[number];

export function isMachineScope(value: string): value is MachineScope {
  return (MACHINE_SCOPES as readonly string[]).includes(value);
}

export function normalizeScopes(scopes: string[] | null | undefined): MachineScope[] | null {
  if (scopes == null) return null; // legacy unrestricted key
  return [...new Set(scopes.filter(isMachineScope))];
}

export function scopeForAction(action: string): MachineScope {
  switch (action) {
    case "execute_campaign_status": return "campaigns:write";
    case "execute_bids": return "bids:write";
    case "execute_budget": return "budget:write";
    case "execute_promotion": return "promotion:write";
    case "execute_negative": return "negative:write";
    case "credentials": return "credentials";
    case "policy": return "policy";
    case "manage_members": return "members";
    default: return "read";
  }
}

export function hasScope(scopes: string[] | null | undefined, required: MachineScope): boolean {
  return scopes == null || scopes.includes(required);
}

/**
 * Least-privilege ROLE implied by a machine key's scopes.
 *
 * Review P2: the proxy used to stamp `x-tenant-role: "admin"` on every machine
 * key, so RBAC (authorize()) waved through everything and scopes were the only
 * thing standing between a read-only key and a live budget change. Two layers
 * that are supposed to be independent had collapsed into one — and any route
 * that checked the role but not the scope was effectively unguarded.
 *
 * The role is now derived from the capabilities the key actually holds:
 *   * no write scopes            -> viewer     (read-only)
 *   * ad-surface write scopes    -> media_buyer (execute, no admin surface)
 *   * credentials/policy/members -> admin      (explicitly granted)
 *
 * NULL means a legacy key created before scopes existed; it stays unrestricted
 * for backward compatibility (hasScope() returns true for it), so it keeps the
 * admin role. Newly minted keys always carry explicit scopes.
 */
export function roleForScopes(scopes: string[] | null | undefined): "admin" | "media_buyer" | "viewer" {
  if (scopes == null) return "admin"; // legacy unrestricted key
  const ADMIN_SCOPES: MachineScope[] = ["credentials", "policy", "members"];
  if (scopes.some((s) => (ADMIN_SCOPES as string[]).includes(s))) return "admin";
  const WRITE_SCOPES: MachineScope[] = [
    "campaigns:write",
    "bids:write",
    "budget:write",
    "promotion:write",
    "negative:write",
  ];
  if (scopes.some((s) => (WRITE_SCOPES as string[]).includes(s))) return "media_buyer";
  return "viewer";
}
