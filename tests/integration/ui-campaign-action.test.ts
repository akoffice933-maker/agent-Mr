// Review P1.5 regression: the UI quick actions must not lie.
//
// The bug: POST /api/campaigns/action updated ONLY the local mirror
// (db.update(campaigns).set({status:"paused"})) without ever calling the
// provider, and then wrote an audit entry saying the action was applied. The
// campaign kept running — and spending — at Yandex/Google while the UI and the
// compliance trail both reported "paused".
//
// These tests pin the contract that the route now goes through the real
// execution pipeline (pending action → provider write → read-back → verified)
// and that the audit trail reflects the TRUE outcome.
//
// Isolation: FORCE RLS is on, so every DB access runs inside withTenant(org 1).

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { auditLog, campaigns, organizations, pendingActions, settings } from "@/db/schema";
import { POST } from "@/app/api/campaigns/action/route";
import { TENANT_HEADERS } from "@/lib/tenant/request";

const ORG = 1;
const ctx = { orgId: ORG, userId: null, role: "admin" };

let campaignId = 0;

/** Build a request carrying the internal tenant headers the proxy would set. */
function makeRequest(body: unknown, role = "owner"): Request {
  return new Request("http://test.local/api/campaigns/action", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TENANT_HEADERS.orgId]: String(ORG),
      [TENANT_HEADERS.role]: role,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Write safety flags as REAL jsonb booleans.
 *
 * Note: `value` is jsonb and getSettings() compares with `=== true`, so writing
 * the string "true" would silently read back as FALSE. Passing the boolean
 * through keeps these tests honest.
 */
async function setFlags(flags: { dryRun?: boolean; readOnly?: boolean }) {
  await withTenant(ctx, async () => {
    for (const [key, value] of Object.entries(flags)) {
      const k = key === "dryRun" ? "dry_run" : "read_only";
      await db
        .insert(settings)
        .values({ organizationId: ORG, key: k, value: value as boolean })
        .onConflictDoUpdate({ target: [settings.organizationId, settings.key], set: { value: value as boolean } });
    }
  });
}

async function latestAudit() {
  return withTenant(ctx, async () =>
    (await db.select().from(auditLog).where(eq(auditLog.organizationId, ORG)).orderBy(desc(auditLog.id)).limit(1))[0]
  );
}

beforeAll(async () => {
  await withTenant(ctx, async () => {
    const org = await db.select().from(organizations).where(eq(organizations.id, ORG)).limit(1);
    if (org.length === 0) await db.insert(organizations).values({ name: "Test" }).onConflictDoNothing();
    const row = (
      await db
        .insert(campaigns)
        .values({
          organizationId: ORG,
          name: "UI Action Test Campaign",
          platform: "yandex",
          status: "active",
          budgetDaily: 1000,
        })
        .returning()
    )[0];
    campaignId = row.id;
  });
});

beforeEach(async () => {
  await setFlags({ dryRun: false, readOnly: false });
  await withTenant(ctx, async () => {
    await db.update(campaigns).set({ status: "active" }).where(eq(campaigns.id, campaignId));
    await db.delete(pendingActions).where(eq(pendingActions.organizationId, ORG));
  });
});

describe("POST /api/campaigns/action — honest execution (review P1.5)", () => {
  it("read-only mode blocks the write and records status=blocked (not applied)", async () => {
    await setFlags({ readOnly: true });
    const res = await POST(makeRequest({ campaignId, action: "pause" }));
    expect(res.status).toBe(403);

    const after = await withTenant(ctx, async () =>
      (await db.select().from(campaigns).where(eq(campaigns.id, campaignId)))[0]
    );
    expect(after.status).toBe("active"); // mirror untouched

    const audit = await latestAudit();
    expect(audit.status).toBe("blocked");
    expect(audit.status).not.toBe("applied");
  });

  it("dry-run does not change the mirror and records status=dry_run", async () => {
    await setFlags({ dryRun: true });
    const res = await POST(makeRequest({ campaignId, action: "pause" }));
    const body = (await res.json()) as { dryRunBlocked?: boolean };
    expect(body.dryRunBlocked).toBe(true);

    const after = await withTenant(ctx, async () =>
      (await db.select().from(campaigns).where(eq(campaigns.id, campaignId)))[0]
    );
    expect(after.status).toBe("active");

    const audit = await latestAudit();
    expect(audit.status).toBe("dry_run");
    // The old code wrote "applied" here — the campaign was never paused.
    expect(audit.status).not.toBe("applied");
  });

  it("a real pause creates a pending action and resolves it (no blind mirror write)", async () => {
    const res = await POST(makeRequest({ campaignId, action: "pause" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; status?: string };

    // The action went through the pending-action pipeline rather than a bare
    // UPDATE: a row exists for it and it is no longer 'pending'.
    const pend = await withTenant(ctx, async () =>
      db.select().from(pendingActions).where(eq(pendingActions.organizationId, ORG)).orderBy(desc(pendingActions.id))
    );
    expect(pend.length).toBeGreaterThan(0);
    expect(["verified", "failed", "executing", "rejected"]).toContain(pend[0].status);

    // Whatever the provider outcome was, the reported state must match the
    // mirror — the route reads it back instead of assuming success.
    const after = await withTenant(ctx, async () =>
      (await db.select().from(campaigns).where(eq(campaigns.id, campaignId)))[0]
    );
    expect(body.status).toBe(after.status);
    if (body.ok) expect(after.status).toBe("paused");
  });

  it("a viewer is denied and cannot change campaign state", async () => {
    const res = await POST(makeRequest({ campaignId, action: "pause" }, "viewer"));
    expect(res.status).toBe(403);
    const after = await withTenant(ctx, async () =>
      (await db.select().from(campaigns).where(eq(campaigns.id, campaignId)))[0]
    );
    expect(after.status).toBe("active");
  });
});
