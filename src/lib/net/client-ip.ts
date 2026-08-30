// Client IP resolution for rate limiting and brute-force lockout.
//
// Extracted from src/proxy.ts (review P3): these are pure, reusable and tested
// functions — they should not live in a framework file-convention module that
// other code has to import from. `src/proxy.ts` re-exports them for backwards
// compatibility with existing imports and tests.
//
// Trust model
// -----------
// Rate limiting and login lockout key on the client IP, so a spoofable IP is a
// bypass. X-Forwarded-For is only trusted when it demonstrably comes from a
// configured reverse proxy (TRUSTED_PROXY).
//
// Deployment note: put the app behind a proxy that APPENDS its own address as
// the last X-Forwarded-For hop (not a bare overwrite — that yields a single
// hop, which this code never trusts by design; see .env.example for the exact
// nginx directive), list that proxy (and/or its CIDR) in TRUSTED_PROXY, and do
// not expose the app directly.

/** Parse an IPv4 "a.b.c.d" to a 32-bit unsigned integer, or null. */
function ipv4ToLong(ip: string): number | null {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** Whether `ip` is inside an IPv4 CIDR (`a.b.c.d/nn`) or exactly matches it. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const bits = bitsStr ? Number(bitsStr) : 32;
  const ipNum = ipv4ToLong(ip);
  const baseNum = ipv4ToLong(base);
  if (ipNum === null || baseNum === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipNum & mask) >>> 0) === ((baseNum & mask) >>> 0);
}

/**
 * Decide the client IP for rate limiting / brute-force lockout. Pure & tested.
 *
 * @param headers a minimal {get(name)} of the request headers
 * @param trusted configured trusted proxies (or empty)
 */
export function resolveClientIp(headers: Pick<Headers, "get">, trusted: string[] = []): string {
  const xff = headers.get("x-forwarded-for");
  const xRealIp = headers.get("x-real-ip");
  if (trusted.length) {
    if (xff) {
      const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
      // XFF is appended by each proxy, so the LAST hop is the one that
      // connected directly to us. If it is a trusted proxy, the FIRST hop is
      // the original client. Require >1 hop so a direct client cannot simply
      // claim a trusted proxy as its own address.
      if (hops.length >= 2) {
        const lastHop = hops[hops.length - 1];
        if (trusted.some((p) => ipInCidr(lastHop, p))) {
          return hops[0];
        }
      }
    }
    // Not provably behind a trusted proxy: do not read XFF at all.
    return xRealIp ?? "untrusted";
  }
  // No TRUSTED_PROXY configured (dev / sandbox): best effort, documented as
  // not trust-safe. Deployments that expose the app publicly should set it.
  return xff?.split(",")[0]?.trim() ?? xRealIp ?? "local";
}

/** Configured trusted proxies from TRUSTED_PROXY (comma-separated IPs/CIDRs). */
export function trustedProxies(): string[] {
  return (process.env.TRUSTED_PROXY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Convenience: resolve the client IP of a request using the env configuration. */
export function clientIpOf(req: { headers: Pick<Headers, "get"> }): string {
  return resolveClientIp(req.headers, trustedProxies());
}
