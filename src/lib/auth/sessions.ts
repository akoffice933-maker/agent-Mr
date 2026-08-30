// Server-side sessions (Phase B). The browser holds ONLY an HttpOnly cookie
// with the session id — no credentials in JS, no localStorage.
//
// Lifecycle:
//   login          → new session (rotation: every login issues a fresh id)
//   activity       → sliding expiry (lastSeenAt updated, expiresAt extended)
//   logout         → revoked (revokedAt set)
//   all-for-user   → revoked on password change / admin action
//
// Storage: PostgreSQL (`sessions` table) — multi-instance safe by design.

import { randomBytes } from "crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";

export const SESSION_TTL_MS = 12 * 3600 * 1000; // 12h sliding
export const COOKIE_NAME = "agentmr_sid";

export interface SessionRow {
  id: string;
  userId: number;
  expiresAt: Date;
  revokedAt: Date | null;
}

export function newSessionId(): string {
  return randomBytes(32).toString("hex");
}

export async function createSession(userId: number, ip?: string, userAgent?: string): Promise<SessionRow> {
  const now = new Date();
  const row = {
    id: newSessionId(),
    userId,
    ip: ip ?? null,
    userAgent: userAgent ?? null,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    revokedAt: null,
  };
  await db.insert(sessions).values(row);
  return row;
}

/** Validate a session id and slide its expiry. Returns null when invalid. */
export async function validateSession(id: string | undefined): Promise<SessionRow | null> {
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return null;
  const rows = await db.select().from(sessions).where(eq(sessions.id, id));
  const s = rows[0];
  if (!s || s.revokedAt) return null;
  if (s.expiresAt.getTime() < Date.now()) return null;
  // Sliding window: keep the session alive while in use.
  await db
    .update(sessions)
    .set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
    .where(eq(sessions.id, id));
  return s;
}

export async function revokeSession(id: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, id));
}

export async function revokeAllForUser(userId: number): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

export async function getUserById(id: number) {
  const rows = await db.select().from(users).where(eq(users.id, id));
  return rows[0] ?? null;
}

export async function getUserByEmail(email: string) {
  const rows = await db.select().from(users).where(eq(users.email, email.toLowerCase().trim()));
  return rows[0] ?? null;
}

// Review P3: `userExists()` and `countUsers()` were removed — nothing in the
// repository called them. `countUsers()` was also the finding itself: it
// SELECTed every row and returned `rows.length`, so counting users meant
// loading the whole table into JS. Rather than optimise it into a
// `count(*)`, the honest fix for dead code is to delete it; the proxy's own
// "does any user exist?" probe already runs a `SELECT 1 ... LIMIT 1`.

// ── Brute-force guard ───────────────────────────────────────────────────────
//
// Review P1.3. Two defects fixed here:
//
//  1. The counter lived in a per-process Map, so with N replicas an attacker
//     effectively got N × MAX_FAILS attempts, and a restart cleared all
//     lockouts. It now goes through the shared RateLimiter abstraction
//     (src/lib/rate-limit.ts) — Redis when REDIS_URL is set, in-memory
//     otherwise — so the limit holds across instances.
//
//  2. The caller keyed the counter on a spoofable IP (see the route). The IP
//     is now resolved with the trusted-proxy logic; this module just consumes
//     whatever key it is given.
//
// Semantics: MAX_FAILS failures inside WINDOW_MS lock the key for the rest of
// the window. Only FAILURES consume budget — a successful login does not.

import { getRateLimiter } from "@/lib/rate-limit";

const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60 * 1000;

/** Namespaced key so login attempts never collide with request rate limits. */
const failKey = (ip: string) => `login:fail:${ip}`;

/**
 * Whether this client has exhausted its failed-login budget.
 * Read-only: checking the lock never consumes budget itself.
 */
export async function loginLockout(ip: string): Promise<boolean> {
  const limiter = await getRateLimiter();
  const r = await limiter.peek(failKey(ip), MAX_FAILS, WINDOW_MS);
  return !r.ok;
}

/** Record one failed attempt (the only thing that consumes budget). */
export async function recordLoginFailure(ip: string): Promise<void> {
  const limiter = await getRateLimiter();
  await limiter.check(failKey(ip), MAX_FAILS, WINDOW_MS);
}

/**
 * Successful login.
 *
 * The failure window is intentionally NOT reset: with a sliding window a reset
 * would let an attacker who guesses one valid credential clear the counter for
 * the whole IP. Entries age out on their own after WINDOW_MS.
 */
export async function recordLoginSuccess(_ip: string): Promise<void> {
  // no-op by design (see above)
}
