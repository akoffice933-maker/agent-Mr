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
  it("fails OPEN on a Redis error (never blocks the app)", async () => {
    const rl = new RedisRateLimiter({
      pipeline: () => {
        throw new Error("redis down");
      },
    } as never);
    expect((await rl.check("ip:3", 1, 60_000)).ok).toBe(true);
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
