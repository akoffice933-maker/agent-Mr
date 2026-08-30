// Short-lived OAuth `state` store (CSRF protection) — tenant-bound (Phase C).
//
// Review P1.4: this used to be a per-process `Map`. The `oauth_states` table,
// its migration and its RLS policy already existed and were simply never used.
// The in-memory store broke every multi-instance deployment: an OAuth callback
// load-balanced to a different replica than the one that started the flow
// found no state and failed with "could not connect the platform" — roughly
// 50% of attempts with two replicas, and 100% across a restart/deploy.
//
// Security model (unchanged in intent, now enforced by the database):
//
//   * single use — consumption is an atomic UPDATE ... WHERE consumed_at IS
//     NULL RETURNING, so a replayed state loses the race and gets nothing;
//   * expiry — 10 minute TTL checked in SQL;
//   * tenant binding — `oauth_states` is under FORCE RLS (migration 0003), and
//     consumption runs inside the COMPLETING SESSION's tenant context. A state
//     created for another organization is therefore invisible: the cross-org
//     check is enforced by Postgres, not only by an application `if`.
//     The explicit org/user comparison in the routes is kept as defense in
//     depth (and to distinguish "wrong user, same org").

import { randomBytes } from "crypto";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { oauthStates } from "@/db/schema";

const TTL_MS = 600_000; // 10 minutes

export interface OauthStateEntry {
  userId: number | null;
  orgId: number;
  role: string;
}

/**
 * Issue a state token for the given tenant context.
 * MUST run inside that context (withTenant) — RLS binds the row to the org.
 */
export async function createOauthState(
  platform: string,
  ctx: { orgId: number; userId: number | null; role: string }
): Promise<string> {
  const state = randomBytes(32).toString("hex");
  await db.insert(oauthStates).values({
    state,
    organizationId: ctx.orgId,
    userId: ctx.userId,
    platform,
    expiresAt: new Date(Date.now() + TTL_MS),
  });

  // Opportunistic cleanup of this org's stale rows (cheap, index-backed).
  await db
    .delete(oauthStates)
    .where(or(lt(oauthStates.expiresAt, new Date()), sql`${oauthStates.consumedAt} < now() - interval '1 day'`))
    .catch(() => undefined);

  return state;
}

/**
 * Atomically consume a state token. Returns null when it is unknown, expired,
 * already used, or belongs to a different organization (RLS).
 *
 * MUST run inside the completing session's tenant context.
 */
export async function consumeOauthState(state: string): Promise<OauthStateEntry | null> {
  if (!state || !/^[a-f0-9]{64}$/.test(state)) return null;

  const rows = await db
    .update(oauthStates)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(oauthStates.state, state),
        isNull(oauthStates.consumedAt),
        gt(oauthStates.expiresAt, new Date())
      )
    )
    .returning();

  const row = rows[0];
  if (!row) return null;
  return { orgId: row.organizationId, userId: row.userId, role: "admin" };
}
