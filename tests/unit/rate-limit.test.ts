// Phase 0.2: rate limiting abstraction — in-memory token bucket (default,
// identical to the pre-0.2 proxy behavior) and the Redis/Upstash sliding
// window (cross-instance). The Redis path is tested against ioredis-mock.
import { afterEach, describe, expect, it } from "vitest";
import Redis from "ioredis-mock";
import {
  MemoryRateLimiter,
  RedisRateLimiter,
  getRateLimiter,
  _resetRateLimiterForTests,
} from "@/lib/rate-limit";

describe("MemoryRateLimiter (token bucket)", () => {
  it("allows up to `limit` requests, then rejects with retryAfterMs", async () => {
    const rl = new MemoryRateLimiter();
    for (let i = 0; i < 3; i++) {
      expect((await rl.check("k", 3, 60_000)).ok).toBe(true);
    }
    const denied = await rl.check("k", 3, 60_000);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);
  });
  it("refills over time (token bucket)", async () => {
    const rl = new MemoryRateLimiter();
    // limit 2 per 200ms → 10 tokens/s. Exhaust, wait, expect partial refill.
    await rl.check("k", 2, 200);
    await rl.check("k", 2, 200);
    expect((await rl.check("k", 2, 200)).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 120)); // ~1.2 tokens
    expect((await rl.check("k", 2, 200)).ok).toBe(true);
  });
  it("keys are independent", async () => {
    const rl = new MemoryRateLimiter();
    await rl.check("a", 1, 60_000);
    expect((await rl.check("a", 1, 60_000)).ok).toBe(false);
    expect((await rl.check("b", 1, 60_000)).ok).toBe(true);
  });
});

describe("RedisRateLimiter (sliding window, ioredis-mock)", () => {
  it("allows up to `limit`, then rejects within the window", async () => {
    const rl = new RedisRateLimiter(new Redis({ data: {} }));
    for (let i = 0; i < 3; i++) {
      expect((await rl.check("ip:1", 3, 60_000)).ok).toBe(true);
    }
    expect((await rl.check("ip:1", 3, 60_000)).ok).toBe(false);
  });
  it("sliding window frees slots as entries age out", async () => {
    const rl = new RedisRateLimiter(new Redis({ data: {} }));
    await rl.check("ip:2", 1, 150);
    expect((await rl.check("ip:2", 1, 150)).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 200)); // > window
    expect((await rl.check("ip:2", 1, 150)).ok).toBe(true);
  });
  // Review P2 — CONTRACT CHANGE. This used to assert `ok: true` on a Redis
  // error, i.e. an outage disabled rate limiting entirely. Since the login
  // brute-force guard runs on this abstraction too (P1.3), that turned a Redis
  // blip into unlimited password attempts. A blip must still not 500 the app,
  // so it now degrades to the per-instance memory limiter: available, but
  // still enforcing the policy.
  describe("Redis outage → degrades to per-instance limiting (not unlimited)", () => {
    const downRedis = () =>
      ({
        pipeline: () => {
          throw new Error("redis down");
        },
        zcount: () => Promise.reject(new Error("redis down")),
      }) as never;

    it("still allows traffic through (no hard failure)", async () => {
      const rl = new RedisRateLimiter(downRedis());
      expect((await rl.check("ip:3", 3, 60_000)).ok).toBe(true);
    });

    it("but ENFORCES the limit instead of letting everything through", async () => {
      const rl = new RedisRateLimiter(downRedis());
      for (let i = 0; i < 3; i++) {
        expect((await rl.check("ip:4", 3, 60_000)).ok).toBe(true);
      }
      // Pre-fix this was `true` forever — the bypass.
      expect((await rl.check("ip:4", 3, 60_000)).ok).toBe(false);
    });

    it("peek() degrades the same way and stays side-effect free", async () => {
      const rl = new RedisRateLimiter(downRedis());
      for (let i = 0; i < 2; i++) await rl.check("ip:5", 2, 60_000);
      // Budget is spent: peek must report it, repeatedly and without consuming.
      expect((await rl.peek("ip:5", 2, 60_000)).ok).toBe(false);
      expect((await rl.peek("ip:5", 2, 60_000)).ok).toBe(false);
    });
  });
});

describe("getRateLimiter selection", () => {
  afterEach(() => _resetRateLimiterForTests());
  it("defaults to memory when REDIS_URL is unset", async () => {
    delete process.env.REDIS_URL;
    _resetRateLimiterForTests();
    const rl = await getRateLimiter();
    expect(rl).toBeInstanceOf(MemoryRateLimiter);
  });
});
