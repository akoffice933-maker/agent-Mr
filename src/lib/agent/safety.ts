// Safety layer: dry-run, spend limits, confirmations, audit log.
// Tenant-scoped via RLS: settings/metrics queries are automatically filtered
// to the current organization (src/lib/tenant/pool.ts).

import { eq, sql } from "drizzle-orm";
import { db, currentTenant } from "@/db";
import { auditLog, metricsDaily, settings } from "@/db/schema";
import { dateNDaysAgo } from "@/lib/format";

export interface SafetySettings {
  dryRun: boolean;
  readOnly: boolean;
  dailyLimit: number;
  weeklyLimit: number;
  monthlyLimit: number;
  confirmBudget: boolean;
}

const DEFAULTS: SafetySettings = {
  dryRun: true,
  readOnly: true, // read-only by default: the agent can manage accounts only after an explicit opt-in (14-day plan, Day 11)
  dailyLimit: 50000,
  weeklyLimit: 250000,
  monthlyLimit: 900000,
  confirmBudget: true,
};

export async function getSettings(): Promise<SafetySettings> {
  const rows = await db.select().from(settings);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    dryRun: map.get("dry_run") === true,
    readOnly: map.get("read_only") === true,
    dailyLimit: Number(map.get("daily_limit") ?? DEFAULTS.dailyLimit),
    weeklyLimit: Number(map.get("weekly_limit") ?? DEFAULTS.weeklyLimit),
    monthlyLimit: Number(map.get("monthly_limit") ?? DEFAULTS.monthlyLimit),
    confirmBudget: map.get("confirm_budget") !== false,
  };
}

export async function updateSettings(patch: Partial<SafetySettings>): Promise<SafetySettings> {
  const entries: [string, unknown][] = [];
  if (patch.dryRun !== undefined) entries.push(["dry_run", patch.dryRun]);
  if (patch.readOnly !== undefined) entries.push(["read_only", patch.readOnly]);
  if (patch.dailyLimit !== undefined) entries.push(["daily_limit", patch.dailyLimit]);
  if (patch.weeklyLimit !== undefined) entries.push(["weekly_limit", patch.weeklyLimit]);
  if (patch.monthlyLimit !== undefined) entries.push(["monthly_limit", patch.monthlyLimit]);
  if (patch.confirmBudget !== undefined) entries.push(["confirm_budget", patch.confirmBudget]);
  const org = currentTenant()?.orgId ?? 1;
  for (const [key, value] of entries) {
    await db
      .insert(settings)
      .values({ organizationId: org, key, value })
      .onConflictDoUpdate({ target: [settings.organizationId, settings.key], set: { value } });
  }
  return getSettings();
}

export async function spendSince(days: number): Promise<number> {
  const from = dateNDaysAgo(days - 1);
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${metricsDaily.spend}), 0)` })
    .from(metricsDaily)
    .where(sql`${metricsDaily.date} >= ${from}`);
  return Number(rows[0]?.total ?? 0);
}

export interface BudgetCheck {
  ok: boolean;
  reason?: string;
  spendToday: number;
  spendWeek: number;
  spendMonth: number;
  limit: number;
}

function ru(n: number): string {
  return Math.round(n).toLocaleString("ru-RU");
}

/** Checks whether `additionalDaily` ₽/day of new spend fits daily, weekly and monthly limits (ТЗ 10). */
export async function checkBudgetHeadroom(additionalDaily: number): Promise<BudgetCheck> {
  const s = await getSettings();
  const spendToday = await spendSince(1);
  const spendWeek = await spendSince(7);
  const spendMonth = await spendSince(30);
  const base = { spendToday, spendWeek, spendMonth, limit: s.dailyLimit };
  const limit = s.dailyLimit;
  if (spendToday + additionalDaily > limit) {
    return {
      ...base,
      ok: false,
      reason: `Дневной лимит ${ru(limit)} ₽ будет превышен: сегодня уже потрачено ${ru(spendToday)} ₽, новое действие добавляет ещё ~${ru(additionalDaily)} ₽/день.`,
    };
  }
  if (s.weeklyLimit > 0 && spendWeek + additionalDaily * 7 > s.weeklyLimit) {
    return {
      ...base,
      ok: false,
      reason: `Недельный лимит ${ru(s.weeklyLimit)} ₽ будет превышен: за 7 дней уже потрачено ${ru(spendWeek)} ₽, новое действие добавляет ~${ru(additionalDaily * 7)} ₽/нед.`,
    };
  }
  if (s.monthlyLimit > 0 && spendMonth + additionalDaily * 30 > s.monthlyLimit) {
    return {
      ...base,
      ok: false,
      reason: `Месячный лимит ${ru(s.monthlyLimit)} ₽ будет превышен: за 30 дней уже потрачено ${ru(spendMonth)} ₽, новое действие добавляет ~${ru(additionalDaily * 30)} ₽/мес.`,
    };
  }
  return { ...base, ok: true };
}

export interface AuditEntry {
  actor: string;
  tool: string;
  params?: unknown;
  platforms: string[];
  dryRun: boolean;
  status: string;
  summary: string;
}

export async function writeAudit(e: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    organizationId: currentTenant()?.orgId ?? 1,
    actor: e.actor,
    tool: e.tool,
    params: (e.params ?? {}) as Record<string, unknown>,
    platforms: e.platforms.join(","),
    dryRun: e.dryRun,
    status: e.status,
    summary: e.summary,
  });
}

export { eq };
