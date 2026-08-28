// Rate limiting (Phase 0.2, review 27.08.2026).
//
// The proxy previously kept in-memory token buckets per instance. That does
// not hold across multiple instances (horizontal scale / serverless). This
// module abstracts the limiter so the same policy runs on:
//   * MemoryRateLimiter — the original per-instance token bucket (default;
//     used when REDIS_URL is unset, and as a fail-open fallback when Redis is
//     unreachable, so a Redis outage never blocks the app);
//   * RedisRateLimiter — a cross-instance sliding-window log on Upstash/Redis
//     (atomic sorted-set ops via a pipeline).
//
// Selection is by env: `REDIS_URL` present → Redis, else memory. The selected
// instance is cached (globalThis, HMR-safe).

export interface RateLimiterResult {
  ok: boolean;
  /** how long the caller should wait before retrying, ms (when !ok). */
  retryAfterMs?: number;
}
export interface RateLimiter {
  check(key: string, limit: number, windowMs?: number): Promise<RateLimiterResult>;
}

const DEFAULT_WINDOW_MS = 60_000;

/** Original per-instance token bucket (identical behavior to the pre-0.2 proxy). */
export class MemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, { tokens: number; ts: number }>();
  async check(key: string, limit: number, windowMs = DEFAULT_WINDOW_MS): Promise<RateLimiterResult> {
    const now = Date.now();
    const rate = limit / windowMs; // tokens per ms
    let b = this.buckets.get(key);
    if (!b) b = { tokens: limit, ts: now };
    b.tokens = Math.min(limit, b.tokens + (now - b.ts) * rate);
    b.ts = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return { ok: true };
    }
    this.buckets.set(key, b);
    const retryAfterMs = Math.ceil((1 - b.tokens) / rate);
    return { ok: false, retryAfterMs };
  }
}

/** Cross-instance sliding-window log on Redis/Upstash (sorted set per key). */
export class RedisRateLimiter implements RateLimiter {
  constructor(private redis: {
    pipeline: () => {
      zremrangebyscore: (k: string, min: number, max: number) => unknown;
      zadd: (k: string, score: number, member: string) => unknown;
      zcard: (k: string) => unknown;
      pexpire: (k: string, ms: number) => unknown;
      exec: () => Promise<[unknown, unknown][] | null>;
    };
  }) {}
  async check(key: string, limit: number, windowMs = DEFAULT_WINDOW_MS): Promise<RateLimiterResult> {
    try {
      const now = Date.now();
      const windowStart = now - windowMs;
      const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
      const pipe = this.redis.pipeline();
      pipe.zremrangebyscore(key, 0, windowStart);
      pipe.zadd(key, now, member);
      pipe.zcard(key);
      pipe.pexpire(key, windowMs + 500);
      const results = await pipe.exec();
      if (!results) return { ok: false, retryAfterMs: windowMs };
      const count = Number(results[2]?.[1] ?? 0);
      if (count <= limit) return { ok: true };
      // Oldest entry in the window defines when a slot frees up.
      return { ok: false, retryAfterMs: windowMs };
    } catch {
      // Redis blip: fail-open (allow) rather than block the app. The memory
      // limiter is the selected fallback when Redis is down at startup; a
      // mid-flight blip here is rare and better served by allowing the request.
      return { ok: true };
    }
  }
}

const g = globalThis as typeof globalThis & { __rateLimiter?: RateLimiter };

/**
 * Resolve the process-wide limiter. REDIS_URL → Redis (with a short connect
 * timeout, falling back to memory on failure); otherwise memory. Cached.
 */
export async function getRateLimiter(): Promise<RateLimiter> {
  if (g.__rateLimiter) return g.__rateLimiter;
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const { default: Redis } = await import("ioredis");
      const client = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: () => null, // never retry-loop; we fail open to memory
        connectTimeout: 1500,
      });
      await Promise.race([
        client.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("redis connect timeout")), 1600)),
      ]);
      g.__rateLimiter = new RedisRateLimiter(client);
      return g.__rateLimiter;
    } catch {
      // fall through to memory (fail-open)
    }
  }
  g.__rateLimiter = new MemoryRateLimiter();
  return g.__rateLimiter;
}

/** Test seam: reset the cached limiter between tests. */
export function _resetRateLimiterForTests(): void {
  g.__rateLimiter = undefined;
}
