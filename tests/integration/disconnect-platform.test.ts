// Отзыв доступа к рекламному кабинету и честное состояние токена.
//
// До появления этой функции удалить сохранённый токен было нельзя ничем, кроме
// прямого доступа к базе, хотя политика конфиденциальности обещает отзыв. Что
// закрепляем тестом:
//
//   1. Отзыв действительно удаляет строку и освобождает слот тарифа —
//      организация на Free, упёршаяся в лимит одной площадки, после отзыва
//      может подключить другую.
//   2. Отзыв не трогает локальную историю (campaigns/metrics_daily): человек
//      отзывает доступ к кабинету, а не просит стереть свою отчётность.
//   3. Повторный отзыв возвращает removed=false — вызывающий не пишет в журнал
//      несуществующее действие.
//   4. tokenState() отличает рабочий доступ от протухшего без refresh_token:
//      именно это состояние интерфейс раньше показывал как «токен сохранён».
//   5. Отзыв изолирован по организациям: RLS не даёт удалить чужой токен.

import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { campaigns, oauthTokens } from "@/db/schema";
import { identityPool } from "@/lib/tenant/pool";
import { deleteToken, storeToken, tokenState } from "@/lib/adapters/oauth-store";
import { canConnectPlatform, connectedPlatforms } from "@/lib/billing/quota";

const dbUrl = process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;
const d = dbUrl ? describe : describe.skip;

const MARKER = "disconnect-test";
const orgIds: number[] = [];

async function newOrg(): Promise<number> {
  const r = await identityPool.query<{ id: number }>("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [
    MARKER,
  ]);
  const id = r.rows[0].id;
  orgIds.push(id);
  return id;
}

function ctx(orgId: number) {
  return { orgId, userId: null, role: "admin" as const };
}

d("disconnect platform", () => {
  afterAll(async () => {
    if (!dbUrl) return;
    for (const org of orgIds) {
      await withTenant(ctx(org), async () => {
        await db.delete(oauthTokens).where(eq(oauthTokens.organizationId, org));
        await db.delete(campaigns).where(eq(campaigns.organizationId, org));
      });
      await identityPool.query("DELETE FROM audit_log WHERE organization_id = $1", [org]);
      await identityPool.query("DELETE FROM organizations WHERE id = $1", [org]);
    }
  });

  it("освобождает слот тарифа: Free с исчерпанным лимитом снова может подключать", async () => {
    const org = await newOrg();
    await withTenant(ctx(org), async () => {
      await storeToken(org, "yandex", { accessToken: "a-token" });
      expect(await connectedPlatforms(org)).toBe(1);

      // Free — одна площадка; вторая упирается в лимит.
      const before = await canConnectPlatform(org, "google");
      expect(before.allowed).toBe(false);

      expect(await deleteToken(org, "yandex")).toBe(true);
      expect(await connectedPlatforms(org)).toBe(0);

      const after = await canConnectPlatform(org, "google");
      expect(after.allowed).toBe(true);
    });
  });

  it("не удаляет историю кампаний вместе с доступом", async () => {
    const org = await newOrg();
    await withTenant(ctx(org), async () => {
      await storeToken(org, "google", { accessToken: "a-token" });
      await db.insert(campaigns).values({
        organizationId: org,
        platform: "google",
        kind: "campaign",
        externalId: "g-1",
        name: "Историческая кампания",
        status: "paused",
        budgetDaily: 1000,
        strategy: "Автостратегия",
      });

      await deleteToken(org, "google");

      const rows = await db.select().from(campaigns).where(eq(campaigns.organizationId, org));
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("Историческая кампания");
    });
  });

  it("повторный отзыв возвращает false", async () => {
    const org = await newOrg();
    await withTenant(ctx(org), async () => {
      await storeToken(org, "avito", { accessToken: "a-token" });
      expect(await deleteToken(org, "avito")).toBe(true);
      expect(await deleteToken(org, "avito")).toBe(false);
    });
  });

  it("tokenState отличает живой токен от протухшего без refresh", async () => {
    const org = await newOrg();
    await withTenant(ctx(org), async () => {
      expect(await tokenState(org, "yandex")).toBe("none");

      // Бессрочный токен.
      await storeToken(org, "yandex", { accessToken: "a-token" });
      expect(await tokenState(org, "yandex")).toBe("live");

      // Протух, но обновится сам.
      await storeToken(org, "yandex", {
        accessToken: "a-token",
        refreshToken: "r-token",
        expiresAt: new Date(Date.now() - 60_000),
      });
      expect(await tokenState(org, "yandex")).toBe("live");

      // Протух и обновиться нечем — интерфейс обязан сказать правду.
      await db
        .update(oauthTokens)
        .set({ refreshToken: null })
        .where(and(eq(oauthTokens.organizationId, org), eq(oauthTokens.platform, "yandex")));
      expect(await tokenState(org, "yandex")).toBe("stale");

      // Слот при этом остаётся занятым — иначе протухший токен давал бы
      // бесплатную лишнюю площадку (см. комментарий в quota.ts).
      expect(await connectedPlatforms(org)).toBe(1);
    });
  });

  it("нельзя отозвать доступ чужой организации", async () => {
    const mine = await newOrg();
    const theirs = await newOrg();
    await withTenant(ctx(theirs), () => storeToken(theirs, "yandex", { accessToken: "their-token" }));

    // Вызов из своего контекста: RLS не показывает чужую строку.
    const removed = await withTenant(ctx(mine), () => deleteToken(theirs, "yandex"));
    expect(removed).toBe(false);

    const still = await withTenant(ctx(theirs), () => tokenState(theirs, "yandex"));
    expect(still).toBe("live");
  });
});
