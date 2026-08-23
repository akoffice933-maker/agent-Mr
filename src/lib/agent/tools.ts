// Unified Tool Layer: each tool routes to one or several platform "adapters"
// (Google Ads, Яндекс.Директ, Авито) through the unified data model.

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, currentTenant } from "@/db";
import {
  campaigns,
  chats,
  keywords,
  metricsDaily,
  negativeKeywords,
  recommendations,
} from "@/db/schema";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/format";
import type { ParsedIntent } from "./router";
import type { SafetySettings } from "./safety";
import { checkBudgetHeadroom } from "./safety";
import type {
  AuditIssue,
  CampaignRow,
  ChatRow,
  KeywordStat,
  Platform,
  PlatformStat,
  PreviewChange,
  RecRow,
  ResultPayload,
  SpendReportRow,
} from "./types";
import { PLATFORM_LABEL, PLATFORMS_ALL } from "./types";

export interface ToolOutput {
  result: ResultPayload;
  pending?: { params: Record<string, unknown>; costDaily?: number };
  auditSummary: string;
}

interface Agg {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

const emptyAgg = (): Agg => ({ spend: 0, impressions: 0, clicks: 0, conversions: 0 });

export async function loadCampaigns() {
  return db.select().from(campaigns);
}

export async function loadMetrics(from: string, to: string) {
  return db
    .select()
    .from(metricsDaily)
    .where(and(gte(metricsDaily.date, from), sql`${metricsDaily.date} <= ${to}`));
}

export function aggregateByCampaign(rows: { campaignId: number; spend: number; impressions: number; clicks: number; conversions: number }[]) {
  const map = new Map<number, Agg>();
  for (const r of rows) {
    const a = map.get(r.campaignId) ?? emptyAgg();
    a.spend += r.spend;
    a.impressions += r.impressions;
    a.clicks += r.clicks;
    a.conversions += r.conversions;
    map.set(r.campaignId, a);
  }
  return map;
}

function statOf(platform: Platform, a: Agg): PlatformStat {
  return {
    platform,
    spend: Math.round(a.spend),
    impressions: a.impressions,
    clicks: a.clicks,
    conversions: a.conversions,
    ctr: a.impressions > 0 ? (a.clicks / a.impressions) * 100 : 0,
    cpa: a.conversions > 0 ? a.spend / a.conversions : null,
  };
}

function defaultPlatforms(list: Platform[], fallback: Platform[]): Platform[] {
  return list.length > 0 ? list : fallback;
}

// ─── get_spend_report ──────────────────────────────────────────────────────
export async function getSpendReport(i: ParsedIntent): Promise<ToolOutput> {
  const platforms = defaultPlatforms(i.platforms, PLATFORMS_ALL);
  const camps = (await loadCampaigns()).filter((c) => platforms.includes(c.platform as Platform));
  const agg = aggregateByCampaign(await loadMetrics(i.period.from, i.period.to));

  const rows: SpendReportRow[] = platforms.map((p) => {
    const list = camps.filter((c) => c.platform === p);
    const total = list.reduce((acc, c) => {
      const m = agg.get(c.id) ?? emptyAgg();
      acc.spend += m.spend;
      acc.impressions += m.impressions;
      acc.clicks += m.clicks;
      acc.conversions += m.conversions;
      return acc;
    }, emptyAgg());
    return { ...statOf(p, total), campaigns: list.length };
  });

  const totalAgg = rows.reduce(
    (acc, r) => ({
      spend: acc.spend + r.spend,
      impressions: acc.impressions + r.impressions,
      clicks: acc.clicks + r.clicks,
      conversions: acc.conversions + r.conversions,
    }),
    emptyAgg()
  );

  return {
    result: {
      kind: "spend_report",
      period: i.period,
      rows,
      total: { ...statOf("google", totalAgg), campaigns: camps.length },
    },
    auditSummary: `Сводный расход за ${i.period.days} дн: ${fmtMoney(totalAgg.spend)} по ${platforms.length} платформам`,
  };
}

// ─── compare_cpa ───────────────────────────────────────────────────────────
export async function compareCpa(i: ParsedIntent): Promise<ToolOutput> {
  const platforms = defaultPlatforms(i.platforms, ["google", "yandex"]);
  const camps = (await loadCampaigns()).filter((c) => platforms.includes(c.platform as Platform));
  const agg = aggregateByCampaign(await loadMetrics(i.period.from, i.period.to));

  const rows: PlatformStat[] = platforms.map((p) => {
    const total = camps
      .filter((c) => c.platform === p)
      .reduce((acc, c) => {
        const m = agg.get(c.id) ?? emptyAgg();
        acc.spend += m.spend;
        acc.impressions += m.impressions;
        acc.clicks += m.clicks;
        acc.conversions += m.conversions;
        return acc;
      }, emptyAgg());
    return statOf(p, total);
  });

  const withCpa = rows.filter((r) => r.cpa !== null);
  if (withCpa.length < 2) {
    return {
      result: { kind: "text", text: "Недостаточно конверсий для сравнения CPA по выбранным платформам за этот период." },
      auditSummary: "compare_cpa: недостаточно данных",
    };
  }
  const sorted = [...withCpa].sort((a, b) => (a.cpa ?? 0) - (b.cpa ?? 0));
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const diffPct = best.cpa ? Math.round(((worst.cpa! - best.cpa!) / best.cpa!) * 100) : 0;

  return {
    result: {
      kind: "cpa_compare",
      period: i.period,
      rows,
      best: best.platform,
      diffPct,
      insight: `${PLATFORM_LABEL[best.platform]} даёт конверсию на ${diffPct}% дешевле, чем ${PLATFORM_LABEL[worst.platform]} (${fmtMoney(
        best.cpa
      )} против ${fmtMoney(worst.cpa)}). Рекомендуется перераспределить бюджет в пользу ${PLATFORM_LABEL[best.platform]}.`,
    },
    auditSummary: `Сравнение CPA за ${i.period.days} дн: дешевле всего ${PLATFORM_LABEL[best.platform]}`,
  };
}

// ─── list_campaigns ────────────────────────────────────────────────────────
export async function listCampaigns(i: ParsedIntent): Promise<ToolOutput> {
  const platforms = defaultPlatforms(i.platforms, PLATFORMS_ALL);
  const status = (i.params.status as string) ?? "all";
  const camps = (await loadCampaigns()).filter((c) => platforms.includes(c.platform as Platform));
  const agg = aggregateByCampaign(await loadMetrics(i.period.from, i.period.to));

  let rows: CampaignRow[] = camps.map((c) => {
    const m = agg.get(c.id) ?? emptyAgg();
    return {
      id: c.id,
      platform: c.platform as Platform,
      kind: c.kind,
      name: c.name,
      status: c.status,
      budgetDaily: c.budgetDaily,
      spend: Math.round(m.spend),
      impressions: m.impressions,
      clicks: m.clicks,
      conversions: m.conversions,
      ctr: m.impressions > 0 ? (m.clicks / m.impressions) * 100 : 0,
      cpa: m.conversions > 0 ? m.spend / m.conversions : null,
    };
  });
  if (status === "active") rows = rows.filter((r) => r.status === "active");
  if (status === "paused") rows = rows.filter((r) => r.status === "paused");
  rows.sort((a, b) => b.spend - a.spend);

  return {
    result: { kind: "campaigns", rows, note: `Период: ${i.period.days} дн · статус: ${status === "all" ? "все" : status}` },
    auditSummary: `Список из ${rows.length} кампаний/объявлений`,
  };
}

// ─── get_keyword_performance ───────────────────────────────────────────────
export async function getKeywordPerformance(i: ParsedIntent): Promise<ToolOutput> {
  const platforms = defaultPlatforms(i.platforms, ["google", "yandex"]);
  const rows = await db
    .select({ kw: keywords, campName: campaigns.name, campPlatform: campaigns.platform })
    .from(keywords)
    .innerJoin(campaigns, eq(keywords.campaignId, campaigns.id))
    .where(inArray(campaigns.platform, platforms))
    .orderBy(desc(keywords.spend))
    .limit(14);

  const stats: KeywordStat[] = rows.map((r) => ({
    id: r.kw.id,
    text: r.kw.text,
    platform: r.campPlatform as Platform,
    campaign: r.campName,
    bid: r.kw.bid,
    impressions: r.kw.impressions,
    clicks: r.kw.clicks,
    spend: Math.round(r.kw.spend),
    conversions: r.kw.conversions,
    ctr: r.kw.impressions > 0 ? (r.kw.clicks / r.kw.impressions) * 100 : 0,
    cpa: r.kw.conversions > 0 ? r.kw.spend / r.kw.conversions : null,
  }));

  return {
    result: {
      kind: "keywords",
      title: `Топ ключевых фраз по расходу (${platforms.map((p) => PLATFORM_LABEL[p]).join(", ")})`,
      rows: stats,
      note: "Данные за последние 28 дней. Ключи без конверсий — кандидаты на минус-фразы или понижение ставки.",
    },
    auditSummary: `Статистика по ${stats.length} ключевым фразам`,
  };
}

// ─── get_avito_chat_summary ────────────────────────────────────────────────
export async function getAvitoChatSummary(i: ParsedIntent): Promise<ToolOutput> {
  const since = new Date();
  since.setDate(since.getDate() - i.period.days);
  const rows = await db
    .select({ chat: chats, listing: campaigns.name })
    .from(chats)
    .leftJoin(campaigns, eq(chats.listingId, campaigns.id))
    .orderBy(desc(chats.startedAt));

  const inPeriod = rows.filter((r) => new Date(r.chat.startedAt) >= since);
  const leads = inPeriod.filter((r) => r.chat.status === "lead").length;
  const summary = {
    total: inPeriod.length,
    leads,
    convPct: inPeriod.length > 0 ? Math.round((leads / inPeriod.length) * 100) : 0,
  };

  const list: ChatRow[] = inPeriod.map((r) => ({
    id: r.chat.id,
    customer: r.chat.customer,
    listing: r.listing ?? "—",
    startedAt: r.chat.startedAt.toISOString(),
    messagesCount: r.chat.messagesCount,
    status: r.chat.status,
    lastMessage: r.chat.lastMessage ?? "",
  }));

  return {
    result: { kind: "chats", periodDays: i.period.days, summary, rows: list },
    auditSummary: `Сводка по чатам Авито: ${summary.total} диалогов, ${leads} лидов`,
  };
}

// ─── run_account_audit ─────────────────────────────────────────────────────
export async function runAccountAudit(i: ParsedIntent): Promise<ToolOutput> {
  const platforms = defaultPlatforms(i.platforms, PLATFORMS_ALL);
  const camps = (await loadCampaigns()).filter((c) => platforms.includes(c.platform as Platform));
  const from = i.period.from;
  const agg = aggregateByCampaign(await loadMetrics(from, i.period.to));
  const negCounts = await db
    .select({ campaignId: negativeKeywords.campaignId, cnt: sql<number>`count(*)::int` })
    .from(negativeKeywords)
    .groupBy(negativeKeywords.campaignId);
  const negMap = new Map(negCounts.map((r) => [r.campaignId, Number(r.cnt)]));

  const result: { platform: Platform; issues: AuditIssue[] }[] = [];
  let high = 0;
  let med = 0;
  let low = 0;

  for (const p of platforms) {
    const issues: AuditIssue[] = [];
    const list = camps.filter((c) => c.platform === p);

    for (const c of list) {
      const m = agg.get(c.id) ?? emptyAgg();
      const ctr = m.impressions > 0 ? (m.clicks / m.impressions) * 100 : 0;
      if (c.kind === "campaign" && c.status === "active") {
        if (m.impressions > 300 && ctr < 1) {
          issues.push({ severity: ctr < 0.7 ? "high" : "medium", text: `CTR ${fmtPct(ctr, 2)} у «${c.name}» ниже порога 1% — расход ${fmtMoney(m.spend)} без отдачи.` });
          if (ctr < 0.7) high++;
          else med++;
        }
        if (m.conversions > 0 && m.spend / m.conversions > 3000) {
          issues.push({ severity: "medium", text: `CPA ${fmtMoney(m.spend / m.conversions)} у «${c.name}» выше целевого порога 3 000 ₽.` });
          med++;
        }
        if (c.platform !== "avito" && (negMap.get(c.id) ?? 0) === 0 && /поиск|поисковые/.test(c.name)) {
          issues.push({ severity: "low", text: `В поисковой кампании «${c.name}» нет минус-фраз — вероятны нецелевые клики.` });
          low++;
        }
      }
      if (c.kind === "listing" && c.status === "active") {
        const viewsPerDay = m.impressions / i.period.days;
        if (viewsPerDay < 10 && c.promotion === "none") {
          issues.push({ severity: viewsPerDay < 5 ? "high" : "medium", text: `Объявление «${c.name}»: ${viewsPerDay.toFixed(1)} просмотра/день без платного продвижения.` });
          if (viewsPerDay < 5) high++;
          else med++;
        }
      }
    }

    if (p !== "avito") {
      const lowQ = await db
        .select({ cnt: sql<number>`count(*)::int` })
        .from(keywords)
        .innerJoin(campaigns, eq(keywords.campaignId, campaigns.id))
        .where(and(inArray(campaigns.platform, [p]), sql`${keywords.qualityScore} <= 4`));
      const n = Number(lowQ[0]?.cnt ?? 0);
      if (n > 0) {
        issues.push({ severity: "low", text: `${n} ключевых фраз с показателем качества ≤ 4/10 — ставки завышены из-за низкого рейтинга.` });
        low++;
      }
    }
    result.push({ platform: p, issues });
  }

  // create recommendations for detected problems (dedup by description)
  const open = await db.select().from(recommendations).where(eq(recommendations.status, "open"));
  const existing = new Set(open.map((r) => r.description));
  let created = 0;
  for (const block of result) {
    for (const iss of block.issues.filter((x) => x.severity !== "low").slice(0, 3)) {
      if (!existing.has(iss.text)) {
        await db.insert(recommendations).values({
          organizationId: currentTenant()?.orgId ?? 1,
          platform: block.platform,
          type: "auto_audit",
          description: iss.text,
          impact: "По итогам аудита",
          status: "open",
        });
        created++;
      }
    }
  }

  const score = Math.max(35, Math.min(98, Math.round(96 - high * 7 - med * 3.5 - low * 1.5)));
  return {
    result: { kind: "audit", platforms: result, score, recsCreated: created },
    auditSummary: `Аудит ${platforms.length} кабинетов: ${high + med + low} замечаний, ${created} новых рекомендаций`,
  };
}

// ─── pause_low_ctr_campaigns (write) ───────────────────────────────────────
export async function pauseLowCtrCampaigns(i: ParsedIntent): Promise<ToolOutput> {
  const threshold = Number(i.params.threshold ?? 1);
  const platforms = defaultPlatforms(i.platforms, ["google", "yandex", "avito"]);
  const camps = (await loadCampaigns()).filter(
    (c) => platforms.includes(c.platform as Platform) && c.status === "active" && c.kind === "campaign"
  );
  const agg = aggregateByCampaign(await loadMetrics(i.period.from, i.period.to));

  const victims = camps.filter((c) => {
    const m = agg.get(c.id) ?? emptyAgg();
    const ctr = m.impressions > 100 ? (m.clicks / m.impressions) * 100 : 100;
    return m.impressions > 100 && ctr < threshold;
  });

  if (victims.length === 0) {
    return {
      result: { kind: "text", text: `Активных кампаний с CTR ниже ${fmtPct(threshold)} за ${i.period.days} дн не найдено — пауза не требуется.` },
      auditSummary: `pause_low_ctr_campaigns: кандидаты не найдены (порог ${threshold}%)`,
    };
  }

  const changes: PreviewChange[] = victims.map((c) => {
    const m = agg.get(c.id) ?? emptyAgg();
    const ctr = m.impressions > 0 ? (m.clicks / m.impressions) * 100 : 0;
    return {
      entity: `${PLATFORM_LABEL[c.platform as Platform]} · кампания`,
      name: c.name,
      before: `Активна · CTR ${fmtPct(ctr, 2)} · расход ${fmtMoney(m.spend)}`,
      after: "Статус: Пауза",
    };
  });

  return {
    result: {
      kind: "preview",
      title: `Пауза ${victims.length} кампаний с CTR ниже ${fmtPct(threshold)}`,
      changes,
      verdict: "pending",
    },
    pending: { params: { ids: victims.map((c) => c.id), threshold } },
    auditSummary: `Подготовлена пауза ${victims.length} кампаний с CTR < ${threshold}%`,
  };
}

// ─── set_campaign_status (write) ───────────────────────────────────────────
export async function setCampaignStatus(i: ParsedIntent): Promise<ToolOutput> {
  const name = String(i.params.name ?? "").trim();
  const status = i.params.status === "active" ? "active" : "paused";
  const platform = (i.platforms[0] ?? undefined) as Platform | undefined;
  if (!name) {
    return {
      result: { kind: "text", text: "Не понял, какую именно кампанию вы имеете в виду. Укажите название, например: «Поставь на паузу „Поиск — Диваны на заказ“»." },
      auditSummary: "set_campaign_status: не указано название",
    };
  }

  const camps = await loadCampaigns();
  const norm = name.toLowerCase();
  const match =
    camps.find((c) => (!platform || c.platform === platform) && c.name.toLowerCase() === norm) ??
    camps.find((c) => (!platform || c.platform === platform) && (c.name.toLowerCase().includes(norm) || norm.includes(c.name.toLowerCase())));
  if (!match) {
    return {
      result: { kind: "text", text: `Кампания «${name}» не найдена${platform ? ` в ${PLATFORM_LABEL[platform]}` : ""}. Попробуйте «Покажи все кампании», чтобы увидеть названия.` },
      auditSummary: "set_campaign_status: кампания не найдена",
    };
  }

  if (match.status === (status === "active" ? "active" : "paused")) {
    return {
      result: { kind: "text", text: `«${match.name}» (${PLATFORM_LABEL[match.platform as Platform]}) уже ${status === "active" ? "активна" : "на паузе"} — менять нечего.` },
      auditSummary: `set_campaign_status: статус уже «${match.status}»`,
    };
  }

  const changes: PreviewChange[] = [
    {
      entity: `${PLATFORM_LABEL[match.platform as Platform]} · кампания`,
      name: match.name,
      before: `Статус: ${match.status === "active" ? "Активна" : "Пауза"}`,
      after: status === "active" ? "Статус: Активна" : "Статус: Пауза",
    },
  ];
  const costDaily = status === "active" ? match.budgetDaily : 0;

  return {
    result: {
      kind: "preview",
      title: `${status === "active" ? "Запуск" : "Пауза"} «${match.name}»`,
      changes,
      cost: costDaily > 0 ? costDaily : undefined,
      verdict: "pending",
    },
    pending: { params: { campaignId: match.id, status }, costDaily },
    auditSummary: `${status === "active" ? "Запуск" : "Пауза"} «${match.name}» (${PLATFORM_LABEL[match.platform as Platform]})`,
  };
}

// ─── adjust_bids (write) ───────────────────────────────────────────────────
export async function adjustBids(i: ParsedIntent): Promise<ToolOutput> {
  const percent = Number(i.params.percent ?? 10);
  const direction = (i.params.direction as string) ?? "up";
  const filter = (i.params.filter as string) ?? "all";
  const platforms = defaultPlatforms(i.platforms, ["google", "yandex"]);
  const factor = direction === "up" ? 1 + percent / 100 : 1 - percent / 100;

  const rows = await db
    .select({ kw: keywords, campName: campaigns.name })
    .from(keywords)
    .innerJoin(campaigns, eq(keywords.campaignId, campaigns.id))
    .where(and(inArray(campaigns.platform, platforms), eq(campaigns.status, "active")));

  let target = rows;
  if (filter === "with_conversions") target = rows.filter((r) => r.kw.conversions > 0);
  target = target.slice(0, 60);

  if (target.length === 0) {
    return {
      result: { kind: "text", text: "Не найдено ключевых фраз под заданный фильтр — ставки не изменены." },
      auditSummary: "adjust_bids: нет ключей под фильтр",
    };
  }

  const changes: PreviewChange[] = target.slice(0, 10).map((r) => ({
    entity: "Ставка · ключ",
    name: r.kw.text,
    before: fmtMoney(r.kw.bid, 1),
    after: `${fmtMoney(r.kw.bid * factor, 1)} ${direction === "up" ? "↑" : "↓"}`,
    note: r.campName,
  }));
  if (target.length > 10) {
    changes.push({ entity: "…", name: `и ещё ${target.length - 10} ключей`, note: "полный список — в audit-log" });
  }

  const totalSpend = target.reduce((acc, r) => acc + r.kw.spend, 0);
  const costDaily = direction === "up" ? (totalSpend / 28) * (percent / 100) : 0;

  return {
    result: {
      kind: "preview",
      title: `${direction === "up" ? "Повышение" : "Понижение"} ставок на ${percent}% · ${target.length} ключей`,
      changes,
      cost: direction === "up" ? Math.round(costDaily) : undefined,
      verdict: "pending",
    },
    pending: { params: { ids: target.map((r) => r.kw.id), factor, direction }, costDaily },
    auditSummary: `Изменение ставок ${direction === "up" ? "+" : "−"}${percent}% по ${target.length} ключам`,
  };
}

// ─── create_campaign (write) ───────────────────────────────────────────────
export async function createCampaign(i: ParsedIntent): Promise<ToolOutput> {
  const platform = (i.platforms[0] ?? "google") as Platform;
  const name = String(i.params.name ?? "Новая кампания (создана агентом)");
  const budget = Number(i.params.budget ?? 2000);
  const strategy = platform === "avito" ? "Продвижение «Турбо»" : "Максимум кликов (автостратегия)";

  return {
    result: {
      kind: "preview",
      title: `Создание кампании в ${PLATFORM_LABEL[platform]}`,
      changes: [
        { entity: "Кампания", name, before: "—", after: `Будет создана · бюджет ${fmtMoney(budget)}/день` },
        { entity: "Стратегия", name: strategy, note: "Можно изменить после запуска" },
      ],
      cost: budget,
      verdict: "pending",
    },
    pending: { params: { platform, name, budget, strategy }, costDaily: budget },
    auditSummary: `Создание кампании «${name}» в ${PLATFORM_LABEL[platform]} (${fmtMoney(budget)}/день)`,
  };
}

// ─── promote_low_view_listings (write, Avito) ──────────────────────────────
export async function promoteLowViewListings(i: ParsedIntent): Promise<ToolOutput> {
  const threshold = Number(i.params.threshold ?? 10);
  const days = Math.min(i.period.days, 14);
  const from = i.period.from;
  const camps = (await loadCampaigns()).filter(
    (c) => c.platform === "avito" && c.kind === "listing" && c.status === "active" && c.promotion === "none"
  );
  const agg = aggregateByCampaign(await loadMetrics(from, i.period.to));

  const victims = camps.filter((c) => {
    const m = agg.get(c.id) ?? emptyAgg();
    return m.impressions / days < threshold;
  });

  if (victims.length === 0) {
    return {
      result: { kind: "text", text: `Все активные объявления Авито набирают ≥ ${threshold} просмотров/день — продвижение не требуется.` },
      auditSummary: "promote_low_view_listings: кандидаты не найдены",
    };
  }

  const SERVICE_PER_DAY = 299;
  const changes: PreviewChange[] = victims.map((c) => {
    const m = agg.get(c.id) ?? emptyAgg();
    return {
      entity: "Авито · объявление",
      name: c.name,
      before: `${(m.impressions / days).toFixed(1)} просмотров/день · без продвижения`,
      after: `Услуга «Поднять в поиске», 7 дней`,
      note: `≈ ${fmtMoney(SERVICE_PER_DAY)}/день · ${fmtMoney(c.price)}`,
    };
  });

  return {
    result: {
      kind: "preview",
      title: `Продвижение ${victims.length} объявлений с просмотрами ниже ${threshold}/день`,
      changes,
      cost: victims.length * SERVICE_PER_DAY,
      verdict: "pending",
    },
    pending: { params: { ids: victims.map((c) => c.id), service: "boost7" }, costDaily: victims.length * SERVICE_PER_DAY },
    auditSummary: `Продвижение ${victims.length} объявлений Авито (≈${fmtMoney(victims.length * SERVICE_PER_DAY)}/день)`,
  };
}

// ─── add_negative_keywords (write) ─────────────────────────────────────────
export async function addNegativeKeywords(i: ParsedIntent): Promise<ToolOutput> {
  const words = (i.params.words as string[]) ?? [];
  if (words.length === 0) {
    return {
      result: {
        kind: "text",
        text: "Укажите минус-фразы в кавычках, например: «б/у, авито, ремонт». Я добавлю их в подходящую поисковую кампанию.",
      },
      auditSummary: "add_negative_keywords: не указаны фразы",
    };
  }

  const platform = (i.platforms[0] ?? "google") as Platform;
  const camps = (await loadCampaigns()).filter(
    (c) => c.platform === platform && c.kind === "campaign" && c.status === "active"
  );
  const search = camps.find((c) => /поиск|search/.test(c.name.toLowerCase())) ?? camps[0];
  if (!search) {
    return {
      result: { kind: "text", text: `Нет активной кампании в ${PLATFORM_LABEL[platform]} для добавления минус-фраз.` },
      auditSummary: "add_negative_keywords: нет кампании",
    };
  }

  return {
    result: {
      kind: "preview",
      title: `Добавление ${words.length} минус-фраз в «${search.name}»`,
      changes: [
        {
          entity: `${PLATFORM_LABEL[platform]} · минус-фразы`,
          name: search.name,
          before: "—",
          after: `+ ${words.map((w) => `«${w}»`).join(", ")}`,
        },
      ],
      verdict: "pending",
    },
    pending: { params: { campaignId: search.id, words } },
    auditSummary: `Минус-фразы (${words.length}) для «${search.name}»`,
  };
}

// ─── recommendations ───────────────────────────────────────────────────────
export async function listRecommendations(): Promise<ToolOutput> {
  const rows = await db.select().from(recommendations).orderBy(desc(recommendations.id)).limit(12);
  const campNames = new Map((await loadCampaigns()).map((c) => [c.id, c.name]));
  const list: RecRow[] = rows.map((r) => ({
    id: r.id,
    platform: r.platform as Platform,
    type: r.type,
    description: r.description,
    impact: r.impact,
    status: r.status,
    campaign: r.campaignId ? campNames.get(r.campaignId) : undefined,
  }));
  return {
    result: { kind: "recommendations", rows: list },
    auditSummary: `Показано ${list.filter((r) => r.status === "open").length} открытых рекомендаций`,
  };
}

export async function applyRecommendation(i: ParsedIntent): Promise<ToolOutput> {
  const open = await db.select().from(recommendations).where(eq(recommendations.status, "open")).orderBy(recommendations.id);
  const id = i.params.id as number | null;
  const target = id ? open.filter((r) => r.id === id) : open;

  if (target.length === 0) {
    return {
      result: { kind: "text", text: id ? `Открытой рекомендации #${id} не найдено.` : "Открытых рекомендаций нет — запустите аудит: «Сделай аудит всех кабинетов»." },
      auditSummary: "apply_recommendation: не найдено",
    };
  }

  const changes: PreviewChange[] = target.slice(0, 8).map((r) => ({
    entity: `${PLATFORM_LABEL[r.platform as Platform]} · рек. #${r.id}`,
    name: r.description,
    before: "Открыта",
    after: "Будет применена",
    note: r.impact,
  }));

  return {
    result: {
      kind: "preview",
      title: `Применение ${target.length === 1 ? `рекомендации #${target[0].id}` : `${target.length} рекомендаций`}`,
      changes,
      verdict: "pending",
    },
    pending: { params: { ids: target.map((r) => r.id) } },
    auditSummary: `Применение ${target.length} рекомендаций`,
  };
}

// ─── help / fallback ───────────────────────────────────────────────────────
export async function help(): Promise<ToolOutput> {
  return {
    result: {
      kind: "text",
      text: [
        "Я понимаю 12 унифицированных команд на естественном языке:",
        "• «Покажи расходы по всем площадкам за последние 7 дней» → get_spend_report",
        "• «Сравни CPA между Google Ads и Яндекс.Директ» → compare_cpa",
        "• «Поставь на паузу кампании с CTR ниже 1%» → pause_low_ctr_campaigns",
        "• «Продвинь объявления на Авито с низким количеством просмотров» → promote_low_view_listings",
        "• «Сделай аудит всех подключённых кабинетов» → run_account_audit",
        "• «Подними ставки на 10% по ключам с конверсиями» → adjust_bids",
        "• «Создай кампанию в Директе с бюджетом 3000» → create_campaign",
        "• «Покажи активные кампании» → list_campaigns",
        "• «Статистика по ключевым фразам» → get_keyword_performance",
        "• «Добавь минус-фразы «б/у, ремонт» в Google» → add_negative_keywords",
        "• «Сводка по чатам Авито за неделю» → get_avito_chat_summary",
        "• «Примени все рекомендации» → apply_recommendation",
        "Все операции записи проходят через safety-слой: dry-run, лимиты бюджета и подтверждение.",
      ].join("\n"),
    },
    auditSummary: "Показана справка по командам",
  };
}

export async function fallback(): Promise<ToolOutput> {
  return {
    result: {
      kind: "text",
      text: "Не смог распознать команду. Попробуйте, например: «Покажи расходы за последние 7 дней», «Поставь на паузу кампании с CTR ниже 1%» или напишите «помощь» для полного списка команд.",
    },
    auditSummary: "Нераспознанный запрос",
  };
}
