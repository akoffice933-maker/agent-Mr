// Review P3: buildSessionContext() used to SELECT every campaign of the
// organization on EVERY message and filter them in JS. Fine for the 20-row
// demo, linear in table size for a real account.
//
// The scan is now bounded, but the case-insensitive match stays in JS on
// purpose: this database runs the C collation, where Postgres lower()/ILIKE
// do not fold Cyrillic at all — a SQL rewrite silently stops matching Russian
// campaign names. These tests pin the BEHAVIOUR so that neither the current
// version nor a future "optimisation" can quietly change what the agent
// remembers:
//   * a campaign mentioned in the dialog is detected;
//   * short names (<= 4 chars) stay excluded, as before;
//   * matching is case-insensitive;
//   * at most 5 names are reported;
//   * and — the part a query rewrite can break — another organization's
//     campaigns are never visible.

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { campaigns, messages, organizations } from "@/db/schema";
import { buildSessionContext } from "@/lib/agent/session-context";

const ORG = 1;
const ctx1 = { orgId: ORG, userId: null, role: "admin" };

let otherOrgId = 0;
const createdCampaignIds: number[] = [];

/**
 * Replace the dialog with `text` as the previous turn.
 *
 * buildSessionContext() is called AFTER the incoming user message has already
 * been inserted, and it deliberately drops that newest row (`slice(0, -1)`) —
 * context is built from what came before. So a realistic fixture needs two
 * rows: the turn under test, then the "current" message standing in for the
 * request being served. Inserting a single row makes the history empty and
 * every detection assertion fails for the wrong reason.
 */
async function setDialog(text: string, org = ORG) {
  await withTenant({ orgId: org, userId: null, role: "admin" }, async () => {
    await db.delete(messages).where(eq(messages.organizationId, org));
    await db.insert(messages).values({ organizationId: org, role: "user", content: text });
    await db.insert(messages).values({ organizationId: org, role: "user", content: "и что дальше?" });
  });
}

async function addCampaign(org: number, name: string, platform = "yandex") {
  const row = await withTenant({ orgId: org, userId: null, role: "admin" }, async () =>
    (
      await db
        .insert(campaigns)
        .values({ organizationId: org, name, platform, status: "active", budgetDaily: 100 })
        .returning()
    )[0]
  );
  createdCampaignIds.push(row.id);
  return row;
}

beforeAll(async () => {
  const org = await db.select().from(organizations).where(eq(organizations.id, ORG)).limit(1);
  if (org.length === 0) await db.insert(organizations).values({ name: "Test" }).onConflictDoNothing();
  otherOrgId = (await db.insert(organizations).values({ name: "SessionCtx Other Org" }).returning())[0].id;

  await addCampaign(ORG, "Летняя распродажа обуви");
  await addCampaign(ORG, "Зимние Шины Москва", "google");
  await addCampaign(ORG, "SALE"); // <= 4 chars: must never match
  await addCampaign(otherOrgId, "Секретная кампания другой компании");
});

afterAll(async () => {
  if (createdCampaignIds.length) {
    await db.delete(campaigns).where(inArray(campaigns.id, createdCampaignIds));
  }
  await withTenant(ctx1, () => db.delete(messages).where(eq(messages.organizationId, ORG)));
  if (otherOrgId) await db.delete(organizations).where(eq(organizations.id, otherOrgId));
});

describe("buildSessionContext campaign detection (review P3)", () => {
  it("detects a campaign named in the dialog", async () => {
    await setDialog("Подними ставки в кампании Летняя распродажа обуви на 10%");
    const s = await withTenant(ctx1, () => buildSessionContext());
    expect(s.entities.campaignNames.join(" ")).toContain("Летняя распродажа обуви");
  });

  it("matches case-insensitively", async () => {
    await setDialog("что там по кампании зимние шины москва?");
    const s = await withTenant(ctx1, () => buildSessionContext());
    expect(s.entities.campaignNames.join(" ")).toContain("Зимние Шины Москва");
  });

  it("ignores campaigns that were not mentioned", async () => {
    await setDialog("Покажи общий расход за неделю");
    const s = await withTenant(ctx1, () => buildSessionContext());
    expect(s.entities.campaignNames).toHaveLength(0);
  });

  it("still excludes very short names (<= 4 chars)", async () => {
    // "SALE" appears verbatim, but short names match far too much to be useful.
    await setDialog("Нужен SALE прямо сейчас");
    const s = await withTenant(ctx1, () => buildSessionContext());
    expect(s.entities.campaignNames.join(" ")).not.toContain("SALE");
  });

  it("NEVER surfaces another organization's campaign", async () => {
    // The user of org 1 types the name of a campaign that belongs to another
    // organization. Nothing may come back confirming it exists.
    await setDialog("Расскажи про Секретная кампания другой компании");
    const s = await withTenant(ctx1, () => buildSessionContext());
    expect(s.entities.campaignNames).toHaveLength(0);
    // NB: assert on the "Упомянутые кампании" line, not on the whole block.
    // The block also echoes the recent dialog, which legitimately contains the
    // words the user just typed themselves — that is not a cross-tenant leak,
    // and asserting on the raw block would fail for the wrong reason.
    const mentioned = s.block.split("\n").find((l) => l.startsWith("Упомянутые кампании:"));
    expect(mentioned).toBeUndefined();
  });

  it("caps the number of reported campaigns at 5", async () => {
    const names: string[] = [];
    for (let i = 0; i < 7; i++) {
      const n = `Тестовая кампания номер ${i}`;
      await addCampaign(ORG, n);
      names.push(n);
    }
    await setDialog(names.join(", "));
    const s = await withTenant(ctx1, () => buildSessionContext());
    expect(s.entities.campaignNames.length).toBeLessThanOrEqual(5);
    expect(s.entities.campaignNames.length).toBeGreaterThan(0);
  });

  it("handles an empty dialog without querying for matches", async () => {
    await withTenant(ctx1, () => db.delete(messages).where(eq(messages.organizationId, ORG)));
    const s = await withTenant(ctx1, () => buildSessionContext());
    expect(s.entities.campaignNames).toHaveLength(0);
    expect(s.history).toHaveLength(0);
  });
});
