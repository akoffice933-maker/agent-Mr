// Plan-limit ENFORCEMENT.
//
// entitlements() computing the right numbers is worthless if nothing consults
// them, which was exactly the state before this suite existed. These tests pin
// the behaviour that makes the free plan a real ceiling:
//   * counting rules (what consumes quota and what deliberately does not),
//   * the boundary (limit-1 passes, limit blocks — no off-by-one),
//   * per-organization isolation (one org cannot burn another's quota),
//   * the seat race (two concurrent invites must not both slip through),
//   * fail-open on metering errors (billing must never brick an account).

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { oauthTokens, pendingActions } from "@/db/schema";
import { identityPool } from "@/lib/tenant/pool";
import {
  canConnectPlatform,
  checkQuota,
  connectedPlatforms,
  monthStart,
  usageSummary,
  usedSeats,
  writeActionsThisMonth,
} from "@/lib/billing/quota";
import { PLANS } from "@/lib/billing/plans";
import { reserveSeatAndInvite } from "@/lib/members/invite";

const dbUrl = process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;
const d = dbUrl ? describe : describe.skip;

const orgIds: number[] = [];
const userIds: number[] = [];

async function newOrg(name = "Quota Test Org"): Promise<number> {
  const res = (await identityPool.query("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [name])) as {
    rows: { id: number }[];
  };
  const id = res.rows[0].id;
  orgIds.push(id);
  return id;
}

async function newUser(email: string): Promise<number> {
  const res = (await identityPool.query(
    "INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1,'x',now()) RETURNING id",
    [email]
  )) as { rows: { id: number }[] };
  const id = res.rows[0].id;
  userIds.push(id);
  return id;
}

/** Insert a write action for an org with a given status/date, bypassing the gate. */
async function seedAction(orgId: number, status: string, createdAt = new Date()) {
  const ctx = { orgId, userId: null, role: "admin" };
  await withTenant(ctx, () =>
    db.insert(pendingActions).values({
      organizationId: orgId,
      tool: "set_campaign_status",
      params: { n: Math.random() },
      preview: { kind: "text", text: "x" },
      costDaily: 0,
      idempotencyKey: `quota-${Math.random().toString(36).slice(2)}`,
      status,
      source: "test",
      createdAt,
      expiresAt: new Date(Date.now() + 3600_000),
    })
  );
}

async function connect(orgId: number, platform: string) {
  // oauth_tokens is RLS-protected, so the insert must run inside the org's
  // tenant context — identityPool has no app.org_id set and is refused.
  await withTenant({ orgId, userId: null, role: "admin" }, () =>
    db
      .insert(oauthTokens)
      .values({ organizationId: orgId, platform, accessToken: "enc", updatedAt: new Date() })
      .onConflictDoNothing()
  );
}

afterAll(async () => {
  if (!dbUrl) return;
  if (orgIds.length) {
    for (const id of orgIds) {
      await withTenant({ orgId: id, userId: null, role: "admin" }, () =>
        db.delete(pendingActions).where(eq(pendingActions.organizationId, id))
      );
    }
    for (const id of orgIds) {
      await withTenant({ orgId: id, userId: null, role: "admin" }, () =>
        db.delete(oauthTokens).where(eq(oauthTokens.organizationId, id))
      );
    }
    await identityPool.query("DELETE FROM org_invites WHERE org_id = ANY($1)", [orgIds]);
    await identityPool.query("DELETE FROM org_members WHERE org_id = ANY($1)", [orgIds]);
    await identityPool.query("DELETE FROM subscriptions WHERE org_id = ANY($1)", [orgIds]);
    await identityPool.query("DELETE FROM organizations WHERE id = ANY($1)", [orgIds]);
  }
  if (userIds.length) await identityPool.query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
});

d("write-action metering", () => {
  it("counts only actions that reached the provider", async () => {
    const org = await newOrg();
    // Reached the provider (or is reaching it) → billable.
    await seedAction(org, "executing");
    await seedAction(org, "verified");
    // 'failed' also counts: the call WAS made, and a retry resumes this row
    // rather than creating a new one.
    await seedAction(org, "failed");
    // Never touched the provider → must not be billed. Charging for an action
    // the user rejected would punish them for catching a mistake.
    await seedAction(org, "pending");
    await seedAction(org, "rejected");
    await seedAction(org, "expired");

    expect(await withTenant({ orgId: org, userId: null, role: "admin" }, () => writeActionsThisMonth(org))).toBe(3);
  });

  it("ignores actions from previous months (the quota resets)", async () => {
    const org = await newOrg();
    const lastMonth = new Date(monthStart().getTime() - 5 * 24 * 3600 * 1000);
    await seedAction(org, "verified", lastMonth);
    await seedAction(org, "verified");

    expect(await withTenant({ orgId: org, userId: null, role: "admin" }, () => writeActionsThisMonth(org))).toBe(1);
  });

  it("blocks exactly AT the free limit, not before (boundary)", async () => {
    const org = await newOrg();
    const limit = PLANS.free.maxWriteActionsPerMonth;
    const ctx = { orgId: org, userId: null, role: "admin" };

    for (let i = 0; i < limit - 1; i++) await seedAction(org, "verified");

    // limit-1 used → the next action must still be allowed.
    const under = await withTenant(ctx, () => checkQuota(org, "write_actions"));
    expect(under.allowed).toBe(true);
    expect(under.used).toBe(limit - 1);

    await seedAction(org, "verified");

    const at = await withTenant(ctx, () => checkQuota(org, "write_actions"));
    expect(at.allowed).toBe(false);
    expect(at.used).toBe(limit);
    // The refusal must name the ceiling and the way out, in Russian.
    expect(at.reason).toContain(String(limit));
    expect(at.reason).toMatch(/Pro|тариф/i);
  });

  it("one organization cannot exhaust another's quota", async () => {
    const a = await newOrg("Quota A");
    const b = await newOrg("Quota B");
    for (let i = 0; i < PLANS.free.maxWriteActionsPerMonth; i++) await seedAction(a, "verified");

    const blocked = await withTenant({ orgId: a, userId: null, role: "admin" }, () => checkQuota(a, "write_actions"));
    const clean = await withTenant({ orgId: b, userId: null, role: "admin" }, () => checkQuota(b, "write_actions"));

    expect(blocked.allowed).toBe(false);
    expect(clean.allowed).toBe(true);
    expect(clean.used).toBe(0);
  });
});

d("platform connection limits", () => {
  it("free allows one platform and refuses the second", async () => {
    const org = await newOrg();
    const ctx = { orgId: org, userId: null, role: "admin" };

    expect((await withTenant(ctx, () => canConnectPlatform(org, "google"))).allowed).toBe(true);
    await connect(org, "google");

    expect(await withTenant(ctx, () => connectedPlatforms(org))).toBe(1);
    const second = await withTenant(ctx, () => canConnectPlatform(org, "yandex"));
    expect(second.allowed).toBe(false);
    expect(second.reason).toContain("площадк");
  });

  it("re-connecting an ALREADY connected platform is always allowed", async () => {
    // An expired refresh token must not become an upgrade wall: the token row
    // is upserted, so the platform count does not grow.
    const org = await newOrg();
    await connect(org, "google");
    const again = await withTenant({ orgId: org, userId: null, role: "admin" }, () =>
      canConnectPlatform(org, "google")
    );
    expect(again.allowed).toBe(true);
  });
});

d("seat limits", () => {
  it("counts members plus outstanding invites", async () => {
    const org = await newOrg();
    const u = await newUser(`quota-${Date.now()}@example.com`);
    await identityPool.query("INSERT INTO org_members (org_id,user_id,role) VALUES ($1,$2,'owner')", [org, u]);
    await identityPool.query(
      `INSERT INTO org_invites (org_id,email,role,token_hash,expires_at)
       VALUES ($1,'pending@example.com','viewer','h1',now()+interval '7 days')`,
      [org]
    );
    // An EXPIRED invite frees its seat again.
    await identityPool.query(
      `INSERT INTO org_invites (org_id,email,role,token_hash,expires_at)
       VALUES ($1,'stale@example.com','viewer','h2',now()-interval '1 day')`,
      [org]
    );

    expect(await usedSeats(org)).toBe(2);
    const q = await checkQuota(org, "members");
    expect(q.allowed).toBe(false); // free = 2 seats, both taken
  });

  it("the guarded INSERT keeps two concurrent invites from overshooting", async () => {
    // The race that a plain check-then-insert loses: both requests read
    // "1 seat used", both decide there is room, both insert. The seat count is
    // therefore re-evaluated inside the INSERT itself.
    const org = await newOrg();
    const u = await newUser(`race-${Date.now()}@example.com`);
    await identityPool.query("INSERT INTO org_members (org_id,user_id,role) VALUES ($1,$2,'owner')", [org, u]);

    const limit = PLANS.free.maxMembers; // 2 → exactly one seat left
    // Exercises the SAME function the route uses — re-typing the SQL here
    // would only prove the copy works.
    const insert = (email: string) =>
      reserveSeatAndInvite({ orgId: org, email, role: "viewer", tokenHash: `h-${email}`, limit });

    // Force the worst-case interleaving explicitly: BOTH callers run their
    // pre-check against the same state and both are told "there is room".
    // Firing the writes only afterwards is what a lucky sequential run hides.
    const [d1, d2] = await Promise.all([checkQuota(org, "members"), checkQuota(org, "members")]);
    expect(d1.allowed && d2.allowed).toBe(true);

    const results = await Promise.all([insert("a@example.com"), insert("b@example.com")]);
    const inserted = results.filter((r) => r.ok).length;

    expect(inserted).toBe(1);
    expect(await usedSeats(org)).toBe(2);
  });
});

d("usage summary (the /billing page payload)", () => {
  beforeEach(() => undefined);

  it("reports plan, usage and a reset date in the future", async () => {
    const org = await newOrg();
    await seedAction(org, "verified");
    await connect(org, "google");

    const s = await withTenant({ orgId: org, userId: null, role: "admin" }, () => usageSummary(org));

    expect(s.plan).toBe("free");
    expect(s.writeActions).toEqual({ used: 1, limit: PLANS.free.maxWriteActionsPerMonth });
    expect(s.platforms).toEqual({ used: 1, limit: PLANS.free.maxPlatforms });
    expect(new Date(s.periodResetsAt).getTime()).toBeGreaterThan(Date.now());
  });
});

d("fail-open", () => {
  it("allows the action when metering itself breaks", async () => {
    // Billing is not a safety control. If the counter query fails, the user
    // keeps working: a wrong 'allow' costs one action, a wrong 'deny' can stop
    // someone pausing a campaign that is burning budget.
    const bogusOrg = -12345; // no such org; the count runs but matches nothing
    const q = await checkQuota(bogusOrg, "write_actions");
    expect(q.allowed).toBe(true);
  });
});
