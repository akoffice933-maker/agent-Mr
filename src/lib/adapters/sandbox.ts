// Sandbox adapter: data lives in the local mirror DB (seed data), no external calls.
// This is the fallback mode described in ТЗ 6.2 — the demo keeps working without real credentials.

import type { Platform } from "../agent/types";
import type { ExecutionResult, PlatformClient, WriteOp } from "./types";

export function sandboxClient(platform: Platform): PlatformClient {
  return {
    platform,
    isProduction: false,
    async sync(): Promise<void> {
      // No-op: mirror already contains seed/local data.
    },
    async execute(op: WriteOp): Promise<ExecutionResult> {
      // Sandbox "provider" = the local mirror itself: the effect is applied by
      // the caller (applyEffect), so the read-back simply confirms the op shape.
      return {
        ok: true,
        verified: true,
        readback: { sandbox: true, op: op.kind },
        detail: `sandbox: изменения записаны локально, на ${platform} не отправлялись`,
      };
    },
  };
}
