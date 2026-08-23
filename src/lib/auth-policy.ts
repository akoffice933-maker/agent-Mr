// Auth policy (Production Hardening v1, Phase A).
//
// Principle: in production mode the REST API MUST be protected by an API key.
// Instead of silently running open, the server fails closed — every API route
// (except health and OAuth callbacks) returns 503 "misconfigured".
//
// Local development stays friction-free: without AGENT_MODE=production the key
// is optional.

export function isProductionMode(): boolean {
  return process.env.NODE_ENV === "production" || process.env.AGENT_MODE === "production";
}

export function getApiKey(): string | undefined {
  const k = process.env.AGENT_API_KEY;
  return k && k.trim().length > 0 ? k : undefined;
}

/** API key is mandatory in production mode; optional in development. */
export function apiKeyRequired(): boolean {
  return isProductionMode();
}
