// Sandbox adapter: data lives in the local mirror DB (seed data), no external calls.
// This is the fallback mode described in ТЗ 6.2 — the demo keeps working without real credentials.

import type { Platform } from "../agent/types";
import type { PlatformClient, WriteOp, WriteResult } from "./types";

export function sandboxClient(platform: Platform): PlatformClient {
  return {
    platform,
    isProduction: false,
    async sync(): Promise<void> {
      // No-op: mirror already contains seed/local data.
    },
    async write(_op: WriteOp): Promise<WriteResult> {
      return { ok: true, detail: `sandbox: изменения записаны локально, на ${platform} не отправлялись` };
    },
  };
}
