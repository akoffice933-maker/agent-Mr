// Adapter registry: picks sandbox vs production client per platform (ТЗ 6.2).
import type { Platform } from "../agent/types";
import { isProduction } from "./oauth-store";
import { createAvitoClient } from "./avito/client";
import { createGoogleClient } from "./google-ads/client";
import { createYandexClient } from "./yandex-direct/client";
import { sandboxClient } from "./sandbox";
import type { ExecutionResult, PlatformClient, WriteOp } from "./types";
import { currentTenant } from "@/lib/tenant/pool";

export async function getAdapter(platform: Platform): Promise<PlatformClient> {
  // Simulator mode (Phase E, E8): the yandex "provider" is an in-process
  // simulator implementing the real API contract — full execution pipeline
  // (write → read-back → verified) without a real account.
  if (platform === "yandex" && process.env.YANDEX_SIMULATOR === "1") {
    return createYandexClient({ simulated: true });
  }
  if (await isProduction(platform)) {
    switch (platform) {
      case "google":
        return createGoogleClient();
      case "yandex":
        return createYandexClient();
      case "avito":
        return createAvitoClient();
    }
  }
  return sandboxClient(platform);
}

export interface AdapterOutcome {
  platform: Platform;
  mode: "sandbox" | "production";
  ok: boolean;
  verified: boolean;
  detail?: string;
  error?: string;
  providerResponse?: unknown;
  readback?: unknown;
}

/** Pull fresh state from all given platforms into the local mirror (no-op in sandbox). */
/**
 * Freshness cache for provider syncs (review P2).
 *
 * runAgent() calls syncAdapters() on EVERY chat message, so "what did I spend
 * yesterday?" asked three times in a row triggered three full pulls from Google
 * Ads / Direct / Avito. That is latency on the user's critical path and, more
 * importantly, burns third-party API quota — Direct in particular bills report
 * requests in units.
 *
 * Ad statistics update on the order of minutes at best, so a short TTL costs
 * nothing in accuracy. Keyed per (org, platform) so one tenant's sync never
 * satisfies another's — the cache must not become a cross-tenant leak.
 *
 * Deliberately in-process: this is a latency/quota optimisation, not a
 * correctness mechanism. With N replicas the worst case is N syncs per TTL,
 * which is still bounded and far below one-per-message.
 */
const SYNC_TTL_MS = Number(process.env.ADAPTER_SYNC_TTL_MS ?? 60_000);

const g = globalThis as typeof globalThis & { __syncCache?: Map<string, { at: number; outcome: AdapterOutcome }> };
const syncCache: Map<string, { at: number; outcome: AdapterOutcome }> = g.__syncCache ?? (g.__syncCache = new Map());

/** Test seam / explicit invalidation after a write changed provider state. */
export function invalidateSyncCache(org?: number, platform?: Platform): void {
  if (org === undefined) {
    syncCache.clear();
    return;
  }
  if (platform) syncCache.delete(`${org}:${platform}`);
  else for (const k of syncCache.keys()) if (k.startsWith(`${org}:`)) syncCache.delete(k);
}

export async function syncAdapters(platforms: Platform[]): Promise<AdapterOutcome[]> {
  // Read-only against each provider (no shared state between platforms), so
  // this is safe to parallelize — unlike executeAdapters (money writes),
  // which stays sequential pending a dedicated review pass.
  const unique = [...new Set(platforms)];
  const org = currentTenant()?.orgId ?? 0;
  const now = Date.now();

  // Serve platforms synced recently for THIS org straight from the cache.
  const fresh = new Map<Platform, AdapterOutcome>();
  const stale: Platform[] = [];
  for (const p of unique) {
    const hit = SYNC_TTL_MS > 0 ? syncCache.get(`${org}:${p}`) : undefined;
    if (hit && now - hit.at < SYNC_TTL_MS) fresh.set(p, hit.outcome);
    else stale.push(p);
  }
  if (stale.length === 0) return unique.map((p) => fresh.get(p)!);
  // Only the platforms whose cache entry is missing or stale hit the provider.
  const settled = await Promise.allSettled(
    stale.map(async (p) => {
      const client = await getAdapter(p);
      const mode: "sandbox" | "production" = client.isProduction ? "production" : "sandbox";
      try {
        await client.sync();
        return { platform: p, mode, ok: true, verified: true } satisfies AdapterOutcome;
      } catch (e) {
        return { platform: p, mode, ok: false, verified: false, detail: (e as Error).message } satisfies AdapterOutcome;
      }
    })
  );
  // getAdapter() itself can throw (e.g. missing credentials) before the
  // try/catch above starts — Promise.allSettled catches that as "rejected",
  // which the per-platform try/catch above doesn't. Surface it the same way.
  const synced: AdapterOutcome[] = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { platform: stale[i], mode: "sandbox", ok: false, verified: false, detail: (s.reason as Error)?.message ?? String(s.reason) }
  );

  // Cache SUCCESSES only: a failed sync must be retried on the next message,
  // not remembered for the whole TTL.
  for (const outcome of synced) {
    if (outcome.ok) syncCache.set(`${org}:${outcome.platform}`, { at: now, outcome });
    else syncCache.delete(`${org}:${outcome.platform}`);
  }

  // Preserve the caller's platform order regardless of cache hits.
  const bySynced = new Map(synced.map((o) => [o.platform, o]));
  return unique.map((p) => fresh.get(p) ?? bySynced.get(p)!);
}

/**
 * Execute confirmed writes with provider verification (Phase E):
 * write → provider response → read-back → verified | failed.
 */
export async function executeAdapters(ops: { platform: Platform; op: WriteOp }[]): Promise<AdapterOutcome[]> {
  const results: AdapterOutcome[] = [];
  for (const { platform, op } of ops) {
    const client = await getAdapter(platform);
    const mode = client.isProduction ? "production" : "sandbox";
    try {
      const r: ExecutionResult = await client.execute(op);
      results.push({
        platform,
        mode,
        ok: r.ok,
        verified: r.verified,
        detail: r.detail,
        error: r.error,
        providerResponse: r.providerResponse,
        readback: r.readback,
      });
    } catch (e) {
      results.push({ platform, mode, ok: false, verified: false, error: (e as Error).message });
    }
  }
  return results;
}

// legacy alias (kept for call sites during the Phase E rollout)
export const writeAdapters = executeAdapters;
