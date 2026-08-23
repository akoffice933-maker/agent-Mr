// Short-lived OAuth `state` store (CSRF protection) — tenant-bound (Phase C).
// The state carries the initiating user + org; the callback verifies that the
// completing session matches (never trusts state alone). In-memory, 10 min TTL.
import { randomBytes } from "crypto";

interface Entry {
  exp: number;
  userId: number | null;
  orgId: number;
  role: string;
}

const g = globalThis as typeof globalThis & { __oauthStates?: Map<string, Entry> };
const states: Map<string, Entry> = g.__oauthStates ?? (g.__oauthStates = new Map());

export function createOauthState(_platform: string, ctx: { orgId: number; userId: number | null; role: string }): string {
  const state = randomBytes(16).toString("hex");
  states.set(state, { exp: Date.now() + 600_000, orgId: ctx.orgId, userId: ctx.userId, role: ctx.role });
  for (const [k, v] of states) if (v.exp < Date.now()) states.delete(k);
  return state;
}

export function consumeOauthState(state: string): Entry | null {
  const e = states.get(state);
  if (!e || e.exp < Date.now()) return null;
  states.delete(state);
  return e;
}
