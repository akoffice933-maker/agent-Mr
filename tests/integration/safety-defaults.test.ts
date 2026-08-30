// Review P1.1 regression: safe-by-default settings for NEW organizations.
//
// The bug: getSettings() read flags as `map.get("read_only") === true`, so an
// organization with no settings rows got `false` — DEFAULTS.readOnly and
// DEFAULTS.dryRun were never applied. Only the seeded org #1 had those rows,
// which meant every organization created afterwards (invite, API, manual)
// started with read-only and dry-run DISABLED: the exact inverse of the
// product promise that the agent cannot touch a live account until you opt in.
//
// A brand-new org must therefore be read-only AND dry-run out of the box.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { organizations, settings } from "@/db/schema";
import { getSettings } from "@/lib/agent/safety";

let freshOrgId = 0;

beforeAll(async () => {
  // identity-plane table: organizations is not under RLS, insert directly.
  const row = (
    await db.insert(organizations).values({ name: "Safety Defaults Test Org" }).returning()
  )[0];
  freshOrgId = row.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, freshOrgId));
});

describe("safety defaults for a new organization (review P1.1)", () => {
  it("has no settings rows at all", async () => {
    const rows = await withTenant({ orgId: freshOrgId, userId: null, role: "admin" }, () =>
      db.select().from(settings)
    );
    expect(rows).toHaveLength(0);
  });

  it("is read-only and dry-run by default (fail-closed)", async () => {
    const s = await withTenant({ orgId: freshOrgId, userId: null, role: "admin" }, () => getSettings());
    expect(s.readOnly).toBe(true);
    expect(s.dryRun).toBe(true);
  });

  it("still applies the default spend limits", async () => {
    const s = await withTenant({ orgId: freshOrgId, userId: null, role: "admin" }, () => getSettings());
    expect(s.dailyLimit).toBeGreaterThan(0);
    expect(s.weeklyLimit).toBeGreaterThan(0);
    expect(s.monthlyLimit).toBeGreaterThan(0);
  });

  it("an explicit opt-out overrides the default", async () => {
    const tctx = { orgId: freshOrgId, userId: null, role: "admin" };
    await withTenant(tctx, async () => {
      // jsonb booleans, not strings — getSettings() compares with === true.
      await db.insert(settings).values({ organizationId: freshOrgId, key: "read_only", value: false });
    });
    const s = await withTenant(tctx, () => getSettings());
    expect(s.readOnly).toBe(false);
    expect(s.dryRun).toBe(true); // untouched flag keeps the safe default
  });

  it("a stray JSON STRING value does not read as enabled", async () => {
    const tctx = { orgId: freshOrgId, userId: null, role: "admin" };
    await withTenant(tctx, async () => {
      // NOTE: passing the JS string "true" to a jsonb column stores the
      // BOOLEAN true (Postgres parses it as JSON). To store a genuine JSON
      // string we must write the quoted form, which is what a sloppy writer
      // (or an older migration) could leave behind.
      await db
        .update(settings)
        .set({ value: sql`'"true"'::jsonb` })
        .where(eq(settings.key, "read_only"));
    });
    // Guard: assert the stored TYPE in SQL. A plain db.select() cannot tell us
    // this — jsonb is parsed twice on the way out (node-pg, then drizzle), so
    // the JSON string "true" arrives in JS as the boolean `true`. That
    // double-parsing is precisely why getSettings() checks jsonb_typeof.
    const stored = await withTenant(tctx, async () => {
      const r = await db.execute(
        sql`SELECT jsonb_typeof(value) AS t FROM settings WHERE key = 'read_only'`
      );
      return (r as unknown as { rows: { t: string }[] }).rows[0];
    });
    expect(stored.t).toBe("string"); // guard: we really stored a JSON string

    const s = await withTenant(tctx, () => getSettings());
    // Fail-closed: a malformed value must fall back to the SAFE default
    // (read-only ON), never silently enable writes to a live account.
    expect(s.readOnly).toBe(true);
  });
});
