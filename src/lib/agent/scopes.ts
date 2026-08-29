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
