// Онбординг первого дня (ТЗ §5.2) — состояние чек-листа.
//
// Что здесь важно закрепить тестом, а не глазами:
//
//   1. Шаги считаются по фактам в базе (токен площадки, сообщение
//      пользователя, второй участник), а не по флагу «мы показали баннер».
//   2. Причина, по которой следующую площадку подключить нельзя, приходит из
//      quota.ts дословно. Фронтенд её не сочиняет (ТЗ §8.3), поэтому если
//      формулировка в quota.ts изменится, лендинг и чек-лист обязаны
//      измениться вместе с ней — и никакой тест не должен «застыть» на копии
//      старого текста.
//   3. «Скрыть» переживает перезагрузку страницы (settings, не localStorage) и
//      не протекает в соседнюю организацию.

import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { messages, oauthTokens, settings } from "@/db/schema";
import { identityPool } from "@/lib/tenant/pool";
import { ONBOARDING_DISMISSED_KEY, onboardingState, setOnboardingDismissed } from "@/lib/onboarding";

const dbUrl = process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;
const d = dbUrl ? describe : describe.skip;

const MARKER = "onboarding-test";

let orgA: number;
let orgB: number;

async function freshOrg(): Promise<number> {
  const r = await identityPool.query(`INSERT INTO organizations (name) VALUES ('${MARKER}') RETURNING id`);
  return (r as { rows: { id: number }[] }).rows[0].id;
}

function ctx(orgId: number) {
  return { orgId, userId: null, role: "admin" as const };
}

d("onboarding checklist state", () => {
  afterAll(async () => {
    if (!dbUrl) return;
    for (const org of [orgA, orgB].filter(Boolean)) {
      await withTenant(ctx(org), async () => {
        await db.delete(oauthTokens).where(eq(oauthTokens.organizationId, org));
        await db.delete(messages).where(eq(messages.organizationId, org));
        await db.delete(settings).where(eq(settings.organizationId, org));
      });
      await identityPool.query("DELETE FROM org_members WHERE org_id = $1", [org]);
      await identityPool.query("DELETE FROM organizations WHERE id = $1", [org]);
    }
    await identityPool.query("DELETE FROM users WHERE email LIKE $1", [`${MARKER}%`]);
  });

  it("пустая организация: ни один шаг не пройден, чек-лист не завершён", async () => {
    orgA = await freshOrg();
    const s = await withTenant(ctx(orgA), onboardingState);

    expect(s.steps).toEqual({ connected: false, asked: false, invited: false });
    expect(s.complete).toBe(false);
    expect(s.dismissed).toBe(false);
    expect(s.counts.platforms).toBe(0);
    // Free-план: первую площадку подключить можно.
    expect(s.platforms.every((p) => p.allowed)).toBe(true);
  });

  it("подключённая площадка закрывает шаг 1 и блокирует остальные на Free — причиной от quota.ts", async () => {
    await withTenant(ctx(orgA), () =>
      db.insert(oauthTokens).values({ organizationId: orgA, platform: "yandex", accessToken: "ciphertext" })
    );

    const s = await withTenant(ctx(orgA), onboardingState);
    expect(s.steps.connected).toBe(true);
    expect(s.counts.platforms).toBe(1);

    const yandex = s.platforms.find((p) => p.platform === "yandex")!;
    expect(yandex.connected).toBe(true);
    expect(yandex.allowed).toBe(true);
    expect(yandex.reason).toBeNull();

    // Остальные две упираются в лимит тарифа Free (maxPlatforms = 1).
    const blocked = s.platforms.filter((p) => p.platform !== "yandex");
    expect(blocked).toHaveLength(2);
    for (const p of blocked) {
      expect(p.connected).toBe(false);
      expect(p.allowed).toBe(false);
      // Текст не сверяем дословно: он живёт в quota.ts и может меняться.
      // Проверяем контракт — причина есть, она человекочитаемая и называет тариф.
      expect(p.reason).toBeTruthy();
      expect(p.reason).toContain("Free");
    }
  });

  it("первый вопрос пользователя закрывает шаг 2 и завершает обязательную часть", async () => {
    await withTenant(ctx(orgA), () =>
      db.insert(messages).values({ organizationId: orgA, role: "user", content: "Покажи расходы за 7 дней" })
    );

    const s = await withTenant(ctx(orgA), onboardingState);
    expect(s.steps.asked).toBe(true);
    expect(s.counts.userMessages).toBe(1);
    // Приглашение коллеги необязательно — чек-лист уже не должен висеть на экране.
    expect(s.steps.invited).toBe(false);
    expect(s.complete).toBe(true);
  });

  it("ответ агента шаг 2 не закрывает — считаются только сообщения пользователя", async () => {
    orgB = await freshOrg();
    await withTenant(ctx(orgB), () =>
      db.insert(messages).values({ organizationId: orgB, role: "agent", content: "Привет! Чем помочь?" })
    );

    const s = await withTenant(ctx(orgB), onboardingState);
    expect(s.steps.asked).toBe(false);
    expect(s.counts.userMessages).toBe(0);
  });

  it("второй участник закрывает шаг 3", async () => {
    const ids: number[] = [];
    for (const role of ["owner", "analyst"]) {
      const email = `${MARKER}-${role}-${Date.now()}@example.com`;
      const u = await identityPool.query(
        "INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', $2) RETURNING id",
        [email, role]
      );
      const userId = (u as { rows: { id: number }[] }).rows[0].id;
      ids.push(userId);
      await identityPool.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)", [
        orgB,
        userId,
        role,
      ]);
    }
    expect(ids).toHaveLength(2);

    const s = await withTenant(ctx(orgB), onboardingState);
    expect(s.counts.members).toBe(2);
    expect(s.steps.invited).toBe(true);
  });

  it("«скрыть» сохраняется в settings и не протекает в другую организацию", async () => {
    await withTenant(ctx(orgA), () => setOnboardingDismissed(true));

    const a = await withTenant(ctx(orgA), onboardingState);
    const b = await withTenant(ctx(orgB), onboardingState);
    expect(a.dismissed).toBe(true);
    expect(b.dismissed).toBe(false);

    // И это именно строка настроек текущей организации (RLS-scoped).
    const rows = await withTenant(ctx(orgA), () =>
      db
        .select({ value: settings.value })
        .from(settings)
        .where(and(eq(settings.organizationId, orgA), eq(settings.key, ONBOARDING_DISMISSED_KEY)))
    );
    expect(rows[0]?.value).toBe(true);

    await withTenant(ctx(orgA), () => setOnboardingDismissed(false));
    expect((await withTenant(ctx(orgA), onboardingState)).dismissed).toBe(false);
  });

});
