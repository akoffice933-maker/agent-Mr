// Adapter registry: picks sandbox vs production client per platform (ТЗ 6.2).
import type { Platform } from "../agent/types";
import { isProduction } from "./oauth-store";
import { createAvitoClient } from "./avito/client";
import { createGoogleClient } from "./google-ads/client";
import { createYandexClient } from "./yandex-direct/client";
import { sandboxClient } from "./sandbox";
import type { ExecutionResult, PlatformClient, WriteOp } from "./types";

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
export async function syncAdapters(platforms: Platform[]): Promise<AdapterOutcome[]> {
  // Read-only against each provider (no shared state between platforms), so
  // this is safe to parallelize — unlike executeAdapters (money writes),
  // which stays sequential pending a dedicated review pass.
  const unique = [...new Set(platforms)];
  const settled = await Promise.allSettled(
    unique.map(async (p) => {
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
  return settled.map((s, i) =>
    s.status === "fulfilled" ? s.value : { platform: unique[i], mode: "sandbox", ok: false, verified: false, detail: (s.reason as Error)?.message ?? String(s.reason) }
  );
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
