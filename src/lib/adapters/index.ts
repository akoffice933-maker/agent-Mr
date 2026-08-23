// Adapter registry: picks sandbox vs production client per platform (ТЗ 6.2).
import type { Platform } from "../agent/types";
import { isProduction } from "./oauth-store";
import { createAvitoClient } from "./avito/client";
import { createGoogleClient } from "./google-ads/client";
import { createYandexClient } from "./yandex-direct/client";
import { sandboxClient } from "./sandbox";
import type { PlatformClient, WriteOp, WriteResult } from "./types";

export async function getAdapter(platform: Platform): Promise<PlatformClient> {
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
  detail?: string;
}

/** Pull fresh state from all given platforms into the local mirror (no-op in sandbox). */
export async function syncAdapters(platforms: Platform[]): Promise<AdapterOutcome[]> {
  const results: AdapterOutcome[] = [];
  for (const p of [...new Set(platforms)]) {
    const client = await getAdapter(p);
    try {
      await client.sync();
      results.push({ platform: p, mode: client.isProduction ? "production" : "sandbox", ok: true });
    } catch (e) {
      results.push({ platform: p, mode: client.isProduction ? "production" : "sandbox", ok: false, detail: (e as Error).message });
    }
  }
  return results;
}

/** Push confirmed writes to the platforms they affect (no-op detail in sandbox). */
export async function writeAdapters(ops: { platform: Platform; op: WriteOp }[]): Promise<AdapterOutcome[]> {
  const results: AdapterOutcome[] = [];
  for (const { platform, op } of ops) {
    const client = await getAdapter(platform);
    try {
      const r: WriteResult = await client.write(op);
      results.push({ platform, mode: client.isProduction ? "production" : "sandbox", ok: r.ok, detail: r.detail });
    } catch (e) {
      results.push({ platform, mode: client.isProduction ? "production" : "sandbox", ok: false, detail: (e as Error).message });
    }
  }
  return results;
}
