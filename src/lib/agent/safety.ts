// Safety layer: dry-run, spend limits, confirmations, audit log.
// Tenant-scoped via RLS: settings/metrics queries are automatically filtered
// to the current organization (src/lib/tenant/pool.ts).

import { eq, sql } from "drizzle-orm";
import { db, currentTenant, tenantOrgId } from "@/db";
import { auditLog, metricsDaily, settings } from "@/db/schema";
import { dateNDaysAgo } from "@/lib/format";

export interface SafetySettings {
  dryRun: boolean;
  readOnly: boolean;
  dailyLimit: number;
  weeklyLimit: number;
  monthlyLimit: number;
}

const DEFAULTS: SafetySettings = {
  dryRun: true,
  readOnly: true, // read-only by default: the agent can manage accounts only after an explicit opt-in (14-day plan, Day 11)
  dailyLimit: 50000,
  weeklyLimit: 250000,
  monthlyLimit: 900000,
};

export async function getSettings(): Promise<SafetySettings> {
  // Read the jsonb TYPE alongside the value.
  //
  // Why not a plain db.select(): the jsonb payload is parsed twice on the way
  // out (node-pg parses the column, drizzle parses the result again), so a row
  // holding the JSON *string* "false" arrives in JS as the boolean `false` —
  // indistinguishable from a real, deliberate `false`. A malformed row could
  // therefore switch read-only OFF. Asking Postgres for jsonb_typeof lets us
  // accept only values that are genuinely booleans in the database.
  const rows = (await db
    .select({ key: settings.key, value: settings.value, jsonType: sql<string>`jsonb_typeof(${settings.value})` })
    .from(settings)) as { key: string; value: unknown; jsonType: string | null }[];

  const map = new Map(rows.map((r) => [r.key, r]));

  /**
   * Read a stored boolean flag, falling back to the DEFAULT when the row does
   * not exist.
   *
   * SECURITY (review P1): this used to be `map.get("read_only") === true`,
   * which silently evaluated to FALSE for any organization without an explicit
   * settings row — i.e. DEFAULTS.readOnly / DEFAULTS.dryRun were never applied.
   * Only the seeded org #1 ever had those rows, so every organization created
   * later (invite, API, manual insert) started with read-only and dry-run
   * DISABLED — the exact inverse of the product's core promise that "the agent
   * is read-only until you explicitly opt in".
   *
   * `map.has()` distinguishes "not configured" (use the safe default) from
   * "explicitly configured", and the `=== true` comparison keeps a stray
   * non-boolean jsonb value (e.g. the string "false") from reading as enabled.
   */
  const flag = (key: string, fallback: boolean): boolean => {
    const row = map.get(key);
    // Only a value that is a BOOLEAN in the database counts as configuration.
    // Anything else (a stray JSON string "false", a number, null from a bad
    // migration) falls back to the SAFE default rather than the unsafe
    // direction — a malformed row must never switch read-only/dry-run off.
    if (!row || row.jsonType !== "boolean") return fallback;
    return row.value === true;
  };

  const num = (key: string, fallback: number): number => {
    const row = map.get(key);
    if (!row || row.jsonType !== "number") return fallback;
    const v = Number(row.value);
    return Number.isFinite(v) ? v : fallback;
  };

  return {
    dryRun: flag("dry_run", DEFAULTS.dryRun),
    readOnly: flag("read_only", DEFAULTS.readOnly),
    dailyLimit: num("daily_limit", DEFAULTS.dailyLimit),
    weeklyLimit: num("weekly_limit", DEFAULTS.weeklyLimit),
    monthlyLimit: num("monthly_limit", DEFAULTS.monthlyLimit),
  };
}

export async function updateSettings(patch: Partial<SafetySettings>): Promise<SafetySettings> {
  const entries: [string, unknown][] = [];
  if (patch.dryRun !== undefined) entries.push(["dry_run", patch.dryRun]);
  if (patch.readOnly !== undefined) entries.push(["read_only", patch.readOnly]);
  if (patch.dailyLimit !== undefined) entries.push(["daily_limit", patch.dailyLimit]);
  if (patch.weeklyLimit !== undefined) entries.push(["weekly_limit", patch.weeklyLimit]);
  if (patch.monthlyLimit !== undefined) entries.push(["monthly_limit", patch.monthlyLimit]);
  const org = tenantOrgId();
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
    organizationId: tenantOrgId(),
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
