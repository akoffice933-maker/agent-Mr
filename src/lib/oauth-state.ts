// Short-lived OAuth `state` store (CSRF protection). In-memory with 10 min TTL.
import { randomBytes } from "crypto";

interface Entry {
  state: string;
  exp: number;
}

const g = globalThis as typeof globalThis & { __oauthStates?: Map<string, Entry> };
const states: Map<string, Entry> = g.__oauthStates ?? (g.__oauthStates = new Map());

export function createOauthState(platform: string): string {
  const state = randomBytes(16).toString("hex");
  states.set(state, { state, exp: Date.now() + 600_000 });
  for (const [k, v] of states) if (v.exp < Date.now()) states.delete(k);
  void platform;
  return state;
}

export function consumeOauthState(state: string): boolean {
  const e = states.get(state);
  if (!e || e.exp < Date.now()) return false;
  states.delete(state);
  return true;
}
