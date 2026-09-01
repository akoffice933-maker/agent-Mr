// Онбординг первого дня (ТЗ §5.2).
//
// Продукт умел показать баннер ПОСЛЕ успешного OAuth («вот что я нашёл»), но
// не отвечал на вопрос «я только что зарегистрировался — что делать?». Здесь
// собирается состояние трёх шагов чек-листа; решение «показывать или нет»
// принимает клиент, а не сервер, — так одна и та же выборка годится и для
// дашборда, и для страницы агента.
//
// Всё считается ВНУТРИ tenant-транзакции (RLS), поэтому функция обязана
// вызываться из withTenantRequest/withTenant, как и любой другой доступ к
// данным организации.

import { count, eq } from "drizzle-orm";
import { db, tenantOrgId } from "@/db";
import { messages, orgMembers, settings } from "@/db/schema";
import { canConnectPlatform, connectedPlatforms, usageSummary } from "@/lib/billing/quota";
import type { Platform } from "@/lib/agent/types";

export const ONBOARDING_DISMISSED_KEY = "onboarding_dismissed";

/**
 * true — скрыт навсегда. { until } — скрыт до указанной ISO-даты (снюз на
 * несколько дней), после неё чек-лист снова появится сам. Старые записи
 * (просто boolean) читаются как раньше — обратная совместимость без миграции,
 * value уже jsonb.
 */
export type DismissState = boolean | { until: string };

function isDismissedNow(value: unknown): boolean {
  if (value === true) return true;
  if (value && typeof value === "object" && typeof (value as { until?: unknown }).until === "string") {
    const until = Date.parse((value as { until: string }).until);
    return Number.isFinite(until) && Date.now() < until;
  }
  return false;
}

const PLATFORMS: Platform[] = ["google", "yandex", "avito"];

export const PLATFORM_TITLE: Record<Platform, string> = {
  google: "Google Ads",
  yandex: "Яндекс.Директ",
  avito: "Авито",
};

/** Настроены ли OAuth-ключи площадки в окружении (иначе «Подключить» ведёт в никуда). */
export function platformConfigured(p: Platform): boolean {
  switch (p) {
    case "google":
      return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_ADS_DEVELOPER_TOKEN);
    case "yandex":
      return Boolean(process.env.YANDEX_OAUTH_CLIENT_ID && process.env.YANDEX_OAUTH_CLIENT_SECRET);
    case "avito":
      return Boolean(process.env.AVITO_CLIENT_ID && process.env.AVITO_CLIENT_SECRET);
  }
}

export interface PlatformSlot {
  platform: Platform;
  title: string;
  /** Токен уже сохранён — площадка подключена. */
  connected: boolean;
  /** Ключи приложения заданы в .env, кнопку «Подключить» есть смысл показывать. */
  configured: boolean;
  /** false → подключение упрётся в лимит тарифа. */
  allowed: boolean;
  /**
   * Человекочитаемая причина отказа — ровно та, что вернул quota.ts.
   * Фронтенд НЕ пересчитывает лимиты сам (ТЗ §8.3), только показывает текст.
   */
  reason: string | null;
}

export interface OnboardingState {
  dismissed: boolean;
  plan: string;
  planTitle: string;
  platforms: PlatformSlot[];
  steps: {
    /** Подключён хотя бы один рекламный кабинет. */
    connected: boolean;
    /** Пользователь задал агенту хотя бы один вопрос. */
    asked: boolean;
    /** В организации больше одного участника (шаг необязательный). */
    invited: boolean;
  };
  counts: {
    platforms: number;
    userMessages: number;
    members: number;
  };
  /** Онбординг завершён: обязательные шаги (1 и 2) пройдены. */
  complete: boolean;
}

export async function onboardingState(): Promise<OnboardingState> {
  const orgId = tenantOrgId();

  const [usage, connected, msgRows, memberRows, dismissedRows] = await Promise.all([
    usageSummary(orgId),
    connectedPlatforms(orgId),
    db.select({ n: count() }).from(messages).where(eq(messages.role, "user")),
    db.select({ n: count() }).from(orgMembers).where(eq(orgMembers.orgId, orgId)),
    db.select({ value: settings.value }).from(settings).where(eq(settings.key, ONBOARDING_DISMISSED_KEY)),
  ]);

  const slots: PlatformSlot[] = await Promise.all(
    PLATFORMS.map(async (p) => {
      const quota = await canConnectPlatform(orgId, p);
      // used === -1 — платформа уже подключена (см. canConnectPlatform).
      const isConnected = quota.used === -1 && quota.allowed;
      return {
        platform: p,
        title: PLATFORM_TITLE[p],
        connected: isConnected,
        configured: platformConfigured(p),
        allowed: quota.allowed,
        reason: quota.allowed ? null : (quota.reason ?? null),
      };
    })
  );

  const userMessages = Number(msgRows[0]?.n ?? 0);
  const members = Number(memberRows[0]?.n ?? 0);
  const steps = {
    connected: connected > 0,
    asked: userMessages > 0,
    invited: members > 1,
  };

  return {
    dismissed: isDismissedNow(dismissedRows[0]?.value),
    plan: usage.plan,
    planTitle: usage.planTitle,
    platforms: slots,
    steps,
    counts: { platforms: connected, userMessages, members },
    // Приглашение коллеги — необязательный шаг, он не держит чек-лист на экране.
    complete: steps.connected && steps.asked,
  };
}

export async function setOnboardingDismissed(value: DismissState): Promise<void> {
  const orgId = tenantOrgId();
  await db
    .insert(settings)
    .values({ organizationId: orgId, key: ONBOARDING_DISMISSED_KEY, value })
    .onConflictDoUpdate({ target: [settings.organizationId, settings.key], set: { value } });
}
