// Auth policy (Production Hardening v1, Phases A–B).
//
// Levels (deliberately separate, per the hardening plan):
//   1. Authentication  — "who are you?"  (session cookie OR x-api-key)
//   2. Tenant resolution — "which organization?" (Phase C: organization_id)
//   3. Authorization   — "may you?"        (Phase D: RBAC)
//   4. Policy          — "is this action allowed?" (src/lib/agent/policy.ts)
//   5. Execution       — "can it run right now?" (adapters)
//
// This module only owns level 1 + the fail-closed rule:
//   - AGENT_AUTH_MODE=on  → authentication required (sessions and/or API key)
//   - production mode     → authentication required
//   - no key AND no users → 503 misconfigured (never silently open)
//
// Local development (auth off) stays friction-free for the sandbox demo.

export function isProductionMode(): boolean {
  return process.env.NODE_ENV === "production" || process.env.AGENT_MODE === "production";
}

export function isAuthRequired(): boolean {
  return process.env.AGENT_AUTH_MODE === "on" || isProductionMode();
}

export function getApiKey(): string | undefined {
  const k = process.env.AGENT_API_KEY;
  return k && k.trim().length > 0 ? k : undefined;
}
