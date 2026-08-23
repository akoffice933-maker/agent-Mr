// Intent router: natural language (RU/EN) → unified tool call.
// In production this layer is backed by an OpenRouter LLM (tool calling);
// the demo uses a deterministic rule-based parser so behaviour is reliable.

import type { Platform } from "./types";
import { dateNDaysAgo, todayISO } from "@/lib/format";

export interface ParsedPeriod {
  days: number;
  from: string;
  to: string;
}

export interface ParsedIntent {
  tool: string;
  platforms: Platform[];
  period: ParsedPeriod;
  params: Record<string, unknown>;
}

export const TOOL_LABEL: Record<string, string> = {
  get_spend_report: "get_spend_report",
  compare_cpa: "compare_cpa",
  pause_low_ctr_campaigns: "pause_low_ctr_campaigns",
  promote_low_view_listings: "promote_low_view_listings",
  run_account_audit: "run_account_audit",
  adjust_bids: "adjust_bids",
  create_campaign: "create_campaign",
  list_campaigns: "list_campaigns",
  get_keyword_performance: "get_keyword_performance",
  add_negative_keywords: "add_negative_keywords",
  get_avito_chat_summary: "get_avito_chat_summary",
  apply_recommendation: "apply_recommendation",
  list_recommendations: "list_recommendations",
  help: "help",
  fallback: "—",
};

export const WRITE_TOOLS = new Set([
  "pause_low_ctr_campaigns",
  "promote_low_view_listings",
  "adjust_bids",
  "create_campaign",
  "add_negative_keywords",
  "apply_recommendation",
]);

const PLATFORM_KEYWORDS: Record<Platform, RegExp> = {
  google: /google|гугл|адвордс|adwords|google\s?ads/,
  yandex: /яндекс|директ|yandex|direct/,
  avito: /авито|avito/,
};

function detectPlatforms(norm: string): Platform[] {
  const found: Platform[] = [];
  (Object.keys(PLATFORM_KEYWORDS) as Platform[]).forEach((p) => {
    if (PLATFORM_KEYWORDS[p].test(norm)) found.push(p);
  });
  return found;
}

function detectPeriod(norm: string): ParsedPeriod {
  let days = 7;
  const mDays = norm.match(/(\d{1,3})\s*(?:дн|день|дня|дней|д\.)/);
  if (mDays) days = Math.min(90, Math.max(1, parseInt(mDays[1], 10)));
  else if (/месяц|30 дн/.test(norm)) days = 30;
  else if (/недел/.test(norm)) days = 7;
  else if (/вчера/.test(norm)) days = 1;
  else if (/сегодня/.test(norm)) days = 1;
  return { days, from: dateNDaysAgo(days - 1), to: todayISO() };
}

function parseThreshold(norm: string, def: number): number {
  const m = norm.match(/ниже\s*([\d.,]+)\s*%?/);
  if (!m) return def;
  const v = parseFloat(m[1].replace(",", "."));
  return Number.isFinite(v) ? v : def;
}

function parsePercent(norm: string): number {
  const m = norm.match(/на\s*([\d.,]+)\s*%/);
  if (!m) return 10;
  const v = parseFloat(m[1].replace(",", "."));
  return Number.isFinite(v) && v > 0 ? Math.min(300, v) : 10;
}

function parseQuotedWords(norm: string): string[] {
  const words: string[] = [];
  const re = /[«"„']([^»"“']{2,60})[»"“']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) {
    for (const w of m[1].split(/,| и /)) {
      const t = w.trim();
      if (t.length > 1) words.push(t);
    }
  }
  return words;
}

export function parseIntent(raw: string): ParsedIntent {
  const norm = raw.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  const platforms = detectPlatforms(norm);
  const period = detectPeriod(norm);
  const base = { platforms, period };

  // 1. Negative keywords
  if (/минус[-\s]?(фраз|слов|ключ|ключев)|добавь минус|исключи (слова|фразы|запросы)/.test(norm)) {
    const words = parseQuotedWords(norm);
    return { ...base, tool: "add_negative_keywords", params: { words, campaignHint: norm } };
  }

  // 2. Apply recommendation(s)
  if (/рекомендац/.test(norm) && /(примен|внедри|выполни|запусти)/.test(norm)) {
    const all = /(все|всё|их)/.test(norm);
    const mId = norm.match(/(?:рекомедаци[ия]|рекоммендаци[ия]|рекомендаци[ия])\s*#?\s*(\d+)/) ?? norm.match(/#(\d+)/);
    const id = mId ? parseInt(mId[1], 10) : null;
    return { ...base, tool: "apply_recommendation", params: { id, all: all || id === null } };
  }

  // 3. List recommendations
  if (/рекомендац/.test(norm)) {
    return { ...base, tool: "list_recommendations", params: {} };
  }

  // 4. Avito promotion of low-view listings
  if (/(продвин|продвижени|подним|усил|буст|раскрут)/.test(norm) && /(объявлен|листинг|авито|просмотр|товар)/.test(norm)) {
    const m = norm.match(/просмотр[а-я]*\s*(?:ниже|меньше|до)\s*(\d+)/);
    const threshold = m ? parseInt(m[1], 10) : 10;
    return { ...base, tool: "promote_low_view_listings", platforms: ["avito"], params: { threshold } };
  }

  // 5. Pause low-CTR campaigns
  if (/(пауз|останов|выключ|приостанов|стоп|стопни|отключи|паузь)/.test(norm) && /ctr|кликабельн|клик/.test(norm)) {
    const threshold = parseThreshold(norm, 1.0);
    return { ...base, tool: "pause_low_ctr_campaigns", params: { threshold } };
  }

  // 6. Adjust bids
  if (/(ставк|бид|bid)/.test(norm) && /(подним|увелич|повыс|уменьш|сниз|опуст|измен|скорректир|плюс|коррект)/.test(norm)) {
    const percent = parsePercent(norm);
    const decrease = /(уменьш|сниз|опуст|пониз|минус)/.test(norm);
    const filter = /(конверси|конверт)/.test(norm) ? "with_conversions" : "all";
    return { ...base, tool: "adjust_bids", params: { percent, direction: decrease ? "down" : "up", filter } };
  }

  // 7. Create campaign
  if (/(создай|создать|запусти новую|новая кампани|сделай кампани)/.test(norm)) {
    const mName = norm.match(/под названием [«"']([^»"']+)[»"']/) ?? norm.match(/названи[ея]? [«"']([^»"']+)[»"']/);
    const mBudget = norm.match(/бюджет[а-я]*\s*(\d[\d\s]{2,9})/) ?? norm.match(/(\d[\d\s]{2,9})\s*\/?\s*день/);
    const budget = mBudget ? Math.min(500000, parseInt(mBudget[1].replace(/\s/g, ""), 10)) : 2000;
    return {
      ...base,
      tool: "create_campaign",
      platforms: platforms.length === 1 ? platforms : platforms.length === 0 ? ["google"] : platforms,
      params: { name: mName?.[1] ?? "Новая кампания (создана агентом)", budget },
    };
  }

  // 8. Compare CPA
  if (/cpa|цену (лида|конверси)|стоимость конверси/.test(norm) && /(сравни|сравнени|против|лучше|выгодн|эффективнее)/.test(norm)) {
    return { ...base, tool: "compare_cpa", platforms: platforms.length ? platforms : ["google", "yandex"], params: {} };
  }

  // 9. Audit
  if (/аудит|диагностик|провер(ь|ка|ить)\s(все|аккаунт|кабинет)/.test(norm)) {
    return { ...base, tool: "run_account_audit", params: {} };
  }

  // 10. Avito chat summary
  if (/(чат|лид|сообщени|диалог|обращени)/.test(norm) && (platforms.includes("avito") || /сводк/.test(norm))) {
    return { ...base, tool: "get_avito_chat_summary", platforms: ["avito"], params: {} };
  }

  // 11. Keyword performance
  if (/(ключ|фраз|запрос|keyword)/.test(norm) && /(статист|эффективн|показ|покаж|работ|топ|анализ|производительн)/.test(norm)) {
    return { ...base, tool: "get_keyword_performance", params: {} };
  }

  // 12. Spend report
  if (/(расход|потрач|затрат|спенд|спенд|потратил|отчет|отчёт|сводк|сколько ушло|бюджет.*за)/.test(norm)) {
    return { ...base, tool: "get_spend_report", params: {} };
  }
  if (/cpa/.test(norm)) {
    return { ...base, tool: "compare_cpa", platforms: platforms.length ? platforms : ["google", "yandex"], params: {} };
  }

  // 13. List campaigns
  if (/(кампани|объявлен|листинг)/.test(norm) && /(список|покажи|все|какие|статус|что запущено|активн|на паузе)/.test(norm)) {
    const status = /на паузе|остановл|выключен/.test(norm) ? "paused" : /активн|запущен|работают/.test(norm) ? "active" : "all";
    return { ...base, tool: "list_campaigns", params: { status } };
  }

  // 14. Help
  if (/(что (ты )?умеешь|помощь|команды|справка|возможности|помоги|help|что ты можешь)/.test(norm)) {
    return { ...base, tool: "help", params: {} };
  }

  return { ...base, tool: "fallback", params: {} };
}
