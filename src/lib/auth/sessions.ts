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

export async function userExists(): Promise<boolean> {
  const rows = await db.select({ id: users.id }).from(users).limit(1);
  return rows.length > 0;
}

export async function countUsers(): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users);
  return rows.length;
}

// ── Brute-force guard (in-memory, single instance; move to Redis for multi) ─
const g = globalThis as typeof globalThis & { __loginAttempts?: Map<string, { fails: number; firstAt: number; lockedUntil: number }> };
const attempts: Map<string, { fails: number; firstAt: number; lockedUntil: number }> = g.__loginAttempts ?? (g.__loginAttempts = new Map());

const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

export function loginLockout(ip: string): boolean {
  const a = attempts.get(ip);
  if (!a) return false;
  if (a.lockedUntil > Date.now()) return true;
  if (a.firstAt + WINDOW_MS < Date.now()) {
    attempts.delete(ip);
    return false;
  }
  return false;
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.firstAt + WINDOW_MS < now) {
    attempts.set(ip, { fails: 1, firstAt: now, lockedUntil: 0 });
    return;
  }
  a.fails += 1;
  if (a.fails >= MAX_FAILS) a.lockedUntil = now + LOCK_MS;
}

export function recordLoginSuccess(ip: string): void {
  attempts.delete(ip);
}
