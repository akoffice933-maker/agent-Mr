// Review P2: syncAdapters() ran a full provider pull on EVERY chat message.
//
// Asking "what did I spend yesterday?" three times triggered three round trips
// to Google Ads / Direct / Avito — latency on the user's critical path and
// wasted third-party quota (Direct bills report requests in units).
//
// A short per-(org, platform) TTL cache fixes that. The risk such a cache
// introduces is a CROSS-TENANT LEAK, so that is the central test here: org 2
// must never be served org 1's sync.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/db";

const ctx1 = { orgId: 1, userId: null, role: "admin" };
const ctx2 = { orgId: 2, userId: null, role: "admin" };

/** Counts sync() calls per platform behind a mocked adapter factory. */
let syncCalls: Record<string, number>;
let failNext: Set<string>;

vi.mock("@/lib/adapters/sandbox", () => ({
  sandboxClient: (platform: string) => ({
    isProduction: false,
    platform,
    async sync() {
      syncCalls[platform] = (syncCalls[platform] ?? 0) + 1;
      if (failNext.has(platform)) throw new Error("provider unavailable");
    },
  }),
}));

let syncAdapters: typeof import("@/lib/adapters").syncAdapters;
let invalidateSyncCache: typeof import("@/lib/adapters").invalidateSyncCache;

// NOTE: do NOT call vi.resetModules() here. vi.mock is hoisted and bound to the
// current module registry; resetting it between tests re-imports the real
// sandbox client, so sync() calls stop being counted and every assertion
// silently measures nothing. Import once and reset state explicitly instead.
beforeEach(async () => {
  syncCalls = {};
  failNext = new Set();
  process.env.ADAPTER_SYNC_TTL_MS = "60000";
  const mod = await import("@/lib/adapters");
  syncAdapters = mod.syncAdapters;
  invalidateSyncCache = mod.invalidateSyncCache;
  invalidateSyncCache();
});

afterEach(() => {
  delete process.env.ADAPTER_SYNC_TTL_MS;
});

describe("syncAdapters TTL cache (review P2)", () => {
  it("hits the provider once, then serves repeats from cache", async () => {
    await withTenant(ctx1, () => syncAdapters(["yandex"]));
    await withTenant(ctx1, () => syncAdapters(["yandex"]));
    await withTenant(ctx1, () => syncAdapters(["yandex"]));
    expect(syncCalls.yandex).toBe(1);
  });

  it("NEVER serves one org's sync to another (tenant isolation)", async () => {
    await withTenant(ctx1, () => syncAdapters(["yandex"]));
    expect(syncCalls.yandex).toBe(1);

    // Org 2 has its own cache key and must trigger a real sync.
    await withTenant(ctx2, () => syncAdapters(["yandex"]));
    expect(syncCalls.yandex).toBe(2);
  });

  it("returns results for every requested platform, in order", async () => {
    const out = await withTenant(ctx1, () => syncAdapters(["yandex", "google", "avito"]));
    expect(out.map((o) => o.platform)).toEqual(["yandex", "google", "avito"]);

    // Second call is fully cached but must still answer for all three.
    const cached = await withTenant(ctx1, () => syncAdapters(["yandex", "google", "avito"]));
    expect(cached.map((o) => o.platform)).toEqual(["yandex", "google", "avito"]);
    expect(syncCalls.yandex).toBe(1);
    expect(syncCalls.google).toBe(1);
    expect(syncCalls.avito).toBe(1);
  });

  it("mixes cached and stale platforms in one call", async () => {
    await withTenant(ctx1, () => syncAdapters(["yandex"]));
    const out = await withTenant(ctx1, () => syncAdapters(["yandex", "google"]));

    expect(syncCalls.yandex).toBe(1); // served from cache
    expect(syncCalls.google).toBe(1); // freshly synced
    expect(out.map((o) => o.platform).sort()).toEqual(["google", "yandex"]);
  });

  it("does NOT cache a failure — the next call retries", async () => {
    failNext.add("yandex");
    const first = await withTenant(ctx1, () => syncAdapters(["yandex"]));
    expect(first[0].ok).toBe(false);
    expect(syncCalls.yandex).toBe(1);

    failNext.clear();
    const second = await withTenant(ctx1, () => syncAdapters(["yandex"]));
    expect(syncCalls.yandex).toBe(2); // retried rather than serving the error
    expect(second[0].ok).toBe(true);
  });

  it("a stale entry is re-synced once the TTL elapses", async () => {
    await withTenant(ctx1, () => syncAdapters(["yandex"]));
    expect(syncCalls.yandex).toBe(1);

    // Jump past the TTL rather than sleeping for it.
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      await withTenant(ctx1, () => syncAdapters(["yandex"]));
    } finally {
      Date.now = realNow;
    }
    expect(syncCalls.yandex).toBe(2);
  });

  it("explicit invalidation forces a fresh sync", async () => {
    await withTenant(ctx1, () => syncAdapters(["yandex"]));
    expect(syncCalls.yandex).toBe(1);

    invalidateSyncCache(1, "yandex");
    await withTenant(ctx1, () => syncAdapters(["yandex"]));
    expect(syncCalls.yandex).toBe(2);
  });
});
