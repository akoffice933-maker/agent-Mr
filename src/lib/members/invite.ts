// Seat allocation for organization invites.
//
// Why this exists as its own module: the seat limit has to be enforced at the
// exact moment the invite row is written, and getting that right is subtle
// enough that the route and the tests must exercise the SAME code — a test
// that re-types the SQL only proves the copy works.
//
// The subtlety: counting rows in a subselect does NOT reserve anything. Under
// READ COMMITTED two concurrent INSERTs each run their count before either
// commits, both see a free seat, and both write — the plan is overshot. A
// unique index cannot help either, because "how many rows exist" is not a
// property of any single row (a phantom, not a duplicate).
//
// So seat allocation is serialized per organization with a transaction-scoped
// advisory lock. It is held only for the count+insert, released automatically
// on COMMIT/ROLLBACK, and is keyed by org id, so invites to different
// organizations never wait on each other.

import { identityPool } from "@/lib/tenant/pool";

/** Namespace for the advisory lock, so it cannot collide with other features. */
const SEAT_LOCK_NAMESPACE = 0x5ea7; // "seat"

export interface SeatReservation {
  ok: boolean;
  /** Seats in use after the attempt (for the error message). */
  used: number;
}

/**
 * Insert an invite iff the organization still has a free seat.
 *
 * `limit < 0` means metering failed upstream and deliberately failed open; the
 * invite is written without a ceiling rather than blocking a paying customer.
 */
export async function reserveSeatAndInvite(args: {
  orgId: number;
  email: string;
  role: string;
  tokenHash: string;
  limit: number;
}): Promise<SeatReservation> {
  const client = (await identityPool.connect()) as unknown as {
    query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    release: () => void;
  };
  try {
    await client.query("BEGIN");
    // Serialize seat allocation for THIS organization only.
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [SEAT_LOCK_NAMESPACE, args.orgId]);

    const cnt = await client.query(
      `SELECT (SELECT count(*) FROM org_members WHERE org_id = $1)
            + (SELECT count(*) FROM org_invites
                WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > now()) AS n`,
      [args.orgId]
    );
    const used = Number(cnt.rows[0]?.n ?? 0);

    if (args.limit >= 0 && used >= args.limit) {
      await client.query("ROLLBACK");
      return { ok: false, used };
    }

    await client.query(
      `INSERT INTO org_invites (org_id,email,role,token_hash,expires_at)
       VALUES ($1,$2,$3,$4,now()+interval '7 days')`,
      [args.orgId, args.email, args.role, args.tokenHash]
    );
    await client.query("COMMIT");
    return { ok: true, used: used + 1 };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
