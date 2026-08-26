// Intent router: natural language (RU/EN) → unified tool call.
// Primary: OpenRouter LLM with tool calling (when OPENROUTER_API_KEY is set).
// Fallback: deterministic rule-based parser — keeps the agent reliable offline.

import type { Platform } from "./types";
import { dateNDaysAgo, todayISO } from "@/lib/format";
import { isLlmConfigured, llmChat, llmModel, type LLMMessage } from "./llm-client";
import { LLM_TOOLS, KNOWN_TOOLS } from "./tools-schema";
import { systemPrompt } from "./prompts/system";
import type { SessionContext } from "./session-context";

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
  delete_created_campaign: "delete_created_campaign",
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
  "delete_created_campaign",
  "add_negative_keywords",
  "apply_recommendation",
  "set_campaign_status",
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

  // 1. Negative keywords (not when the message is a create request — the
  // create grammar below parses "минус-фразы:" as part of the full spec)
  const isCreateRequest = /(создай|создать|запусти новую|новая кампани|сделай кампани)/.test(norm);
  if (!isCreateRequest && /минус[-\s]?(фраз|слов|ключ|ключев)|добавь минус|исключи (слова|фразы|запросы)/.test(norm)) {
    const words = parseQuotedWords(norm);
    return { ...base, tool: "add_negative_keywords", params: { words, campaignHint: norm } };
  }

  // 2. Apply recommendation(s)
  if (/рекомендац/.test(norm) && /(примен|внедри|выполни|запусти)/.test(norm)) {
    const all = /(все|всё|их)/.test(norm);
    const mId = norm.match(/(?:рекомедаци[юи]|рекоммендаци[юи]|рекомендаци[юи])\s*#?\s*(\d+)/) ?? norm.match(/#(\d+)/);
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

  // 4b. Pause/resume a SPECIFIC campaign by its quoted name (from the original text,
  // case preserved). Skipped for create requests: their spec QUOTES names (campaign,
  // ad text) and headline words like «Запуск кампаний…» must not be read as a
  // status command (E.2: the headline text must never steal the intent).
  {
    const rawQuoted: string[] = [];
    const re = /[«"„']([^»"“']{2,60})[»"“']/g;
    let qm: RegExpExecArray | null;
    while ((qm = re.exec(raw)) !== null) rawQuoted.push(qm[1].trim());
    if (!isCreateRequest && rawQuoted.length > 0 && /(пауз|запуск|запусти|включи|выключи|стопни|останов)/.test(norm)) {
      const status = /(запуск|запусти|включ)/.test(norm) ? "active" : "paused";
      return { ...base, tool: "set_campaign_status", params: { name: rawQuoted[0], status } };
    }
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
  if (isCreateRequest) {
    // Name is captured from the ORIGINAL text (case-preserving), not norm.
    const mName = raw.match(/под названием [«"']([^»"']+)[»"']/i) ?? raw.match(/названи[ея]? [«"']([^»"']+)[»"']/i);
    const mBudget = norm.match(/бюджет[а-я]*\s*(\d[\d\s]{2,9})/) ?? norm.match(/(\d[\d\s]{2,9})\s*\/?\s*день/);
    const budget = mBudget ? Math.min(500000, parseInt(mBudget[1].replace(/\s/g, ""), 10)) : 2000;
    const params: Record<string, unknown> = { name: mName?.[1] ?? "Новая кампания (создана агентом)", budget };

    // Full ad-tree spec (docs/YANDEX_E2E.md runbook). STRICT grammar: every
    // part is parsed only behind an explicit marker, values are taken from
    // the original text (case preserved). Nothing is guessed — a missing
    // marker simply means "not requested". The ad (title/text/url) is
    // all-or-nothing: a half ad is dropped rather than sent to the provider.
    const mGroup = raw.match(/групп[аи]\s+[«"']([^»"']+)[»"']/i);
    const mTitle = raw.match(/заголовок\s*[«"']([^»"']+)[»"']/i);
    const mText = raw.match(/текст\s*[«"']([^»"']+)[»"']/i);
    const mUrl = raw.match(/(?:url|ссылка|адрес)\s*:?\s*(https?:\/\/\S+)/i);
    // \S+ swallows trailing sentence punctuation (", ".) — trim it.
    const urlValue = mUrl?.[1] ? mUrl[1].replace(/[.,;]+$/, "") : undefined;
    const mKeywords = raw.match(/(?:ключевые фразы|ключи)\s*:\s*([^;.]+)/i);
    const mNegatives = raw.match(/минус[-\s]?(?:фразы|слова|ключи)?\s*:\s*([^;.]+)$/i);

    if (mGroup) params.adGroupName = mGroup[1].trim();
    if (mTitle && mText && urlValue) {
      params.title = mTitle[1].trim();
      params.text = mText[1].trim();
      params.url = urlValue;
    } else if (!mTitle && mText) {
      // E.2: headlines come from «заголовки: …» — text/url are independent
      // (ResponsiveAd allows an ad without a URL).
      params.text = mText[1].trim();
      if (urlValue) params.url = urlValue;
    }
    // Phase E.2: responsive ad surface — headlines, callouts, price, UTM, images.
    // Formats: «заголовки: A, B, C» · «уточнения: X, Y» · «цена 990» / «цена от 990»
    // · «старая цена 1990» · «utm: utm_source=agentmr&utm_medium=cpc»
    // · «изображения: https://… [https://…]»
    // List captures stop at the next known marker word / semicolon / end.
    const NEXT_MARKER = "(?:текст|url|ссылка|адрес|уточнения|цена|старая|utm|параметры|изображения|изображение|картинки|картинка|фото|ключи|ключевые|минус|бюджет|группа|название)";
    // NB: \b does NOT work for Cyrillic in JS (ASCII-only) — use a negative
    // lookahead for a letter/digit instead of a word boundary.
    const takeList = (label: string) =>
      raw.match(new RegExp(`(?:${label})\\s*[:\\-]\\s*([\\s\\S]*?)(?=\\s+(?:${NEXT_MARKER})(?![а-яёa-z0-9])|[;\\n]|$)`, "i"))?.[1];
    const mTitles = takeList("заголовки");
    if (mTitles) {
      const ts = mTitles.split(",").map((w) => w.replace(/[«»"']/g, "").trim()).filter(Boolean).slice(0, 7);
      if (ts.length) {
        params.titles = ts;
        if (!mTitle) params.title = ts[0]; // keep the legacy field in sync for previews
      }
    }
    const mCallouts = takeList("уточнения");
    if (mCallouts) {
      const cs = mCallouts.split(",").map((w) => w.trim()).filter(Boolean).slice(0, 5);
      if (cs.length) params.callouts = cs;
    }
    const mOldPrice = raw.match(/старая цена\s+(\d[\d\s\u00a0]*)/i);
    if (mOldPrice) params.priceOldRubles = Number(mOldPrice[1].replace(/[\s\u00a0]/g, ""));
    const mPrice = raw.match(/цена\s+(от\s+|до\s+)?(\d[\d\s\u00a0]*)/i);
    if (mPrice && mPrice.index != null) {
      const before = raw.slice(Math.max(0, mPrice.index - 12), mPrice.index).toLowerCase();
      if (!/старая\s*$/.test(before)) {
        const price = Number(mPrice[2].replace(/[\s\u00a0]/g, ""));
        if (price > 0) {
          params.priceRubles = price;
          if (mPrice[1]) params.priceQualifier = /от/i.test(mPrice[1]) ? "from" : "up_to";
        }
      }
    }
    const mUtm = takeList("utm|параметры url|url-параметры");
    if (mUtm && mUtm.includes("=")) params.trackingParams = mUtm.trim().replace(/[,;]+$/, "");
    const mImages = takeList("изображения|изображение|картинки|картинка|фото");
    if (mImages) {
      const urls = (mImages.match(/https?:\/\/\S+/g) ?? []).map((u) => u.replace(/[.,;]+$/, "")).slice(0, 5);
      if (urls.length) params.images = urls.map((url) => ({ url }));
    }
    if (mKeywords) {
      const kws = mKeywords[1].split(",").map((w) => w.trim()).filter(Boolean).slice(0, 1000);
      if (kws.length) params.keywords = kws;
    }
    if (mNegatives) {
      const negs = mNegatives[1].split(",").map((w) => w.trim()).filter(Boolean).slice(0, 100);
      if (negs.length) params.negativeKeywords = negs;
    }

    return {
      ...base,
      tool: "create_campaign",
      platforms: platforms.length === 1 ? platforms : platforms.length === 0 ? ["google"] : platforms,
      params,
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

// ─── LLM-backed intent resolution (ТЗ этап 1) ────────────────────────────────

/**
 * Deterministic spec wins (Phase E.2): when the user wrote the spec with explicit
 * markers («заголовки:», «уточнения:», «цена», «utm:», «изображение:»), the rule
 * parser extracts it exactly — small LLMs tend to drop such fields from tool
 * calls. Explicit marker values override LLM paraphrases; missing fields are
 * filled from the rules.
 */
export function mergeRuleSpecIntoLlmParams(params: Record<string, unknown>, text: string): Record<string, unknown> {
  const rules = parseIntent(text);
  if (rules.tool !== "create_campaign") return params;
  const rp = rules.params as Record<string, unknown>;
  const out: Record<string, unknown> = { ...params };
  if (Array.isArray(rp.titles) && rp.titles.length) {
    out.titles = rp.titles;
    if (!out.title) out.title = rp.titles[0];
  }
  if (!out.title && typeof rp.title === "string") out.title = rp.title;
  if (!out.text && typeof rp.text === "string") out.text = rp.text;
  if (!out.url && typeof rp.url === "string") out.url = rp.url;
  if (Array.isArray(rp.callouts) && rp.callouts.length) out.callouts = rp.callouts;
  if (typeof rp.priceRubles === "number") out.priceRubles = rp.priceRubles;
  if (typeof rp.priceOldRubles === "number") out.priceOldRubles = rp.priceOldRubles;
  if (rp.priceQualifier === "from" || rp.priceQualifier === "up_to") out.priceQualifier = rp.priceQualifier;
  if (typeof rp.trackingParams === "string") out.trackingParams = rp.trackingParams;
  if (Array.isArray(rp.images) && rp.images.length) out.images = rp.images;
  if (!out.keywords && Array.isArray(rp.keywords) && rp.keywords.length) out.keywords = rp.keywords;
  if (!out.negativeKeywords && Array.isArray(rp.negativeKeywords) && rp.negativeKeywords.length) out.negativeKeywords = rp.negativeKeywords;
  return out;
}

export interface ResolvedIntent {
  intent: ParsedIntent;
  engine: "llm" | "rules";
  model?: string;
  llmError?: string;
}

function clampDays(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(90, Math.max(1, n)) : 7;
}

const VALID_PLATFORMS: Platform[] = ["google", "yandex", "avito"];

async function llmResolveIntent(text: string, ctx: SessionContext): Promise<ParsedIntent | null> {
  const msgs: LLMMessage[] = [{ role: "system", content: systemPrompt(ctx.block) }];
  for (const m of ctx.history.slice(-8)) {
    msgs.push({ role: m.role === "user" ? "user" : "assistant", content: m.content.slice(0, 400) });
  }
  msgs.push({ role: "user", content: text });

  const resp = await llmChat({ messages: msgs, tools: LLM_TOOLS });
  const call = resp.toolCalls[0];
  if (!call) return null; // LLM answered in plain text — let rules decide

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return null;
  }

  const tool = call.function.name;
  if (!KNOWN_TOOLS.has(tool)) return null;

  let platforms: Platform[] = [];
  if (Array.isArray(args.platforms)) {
    platforms = (args.platforms as string[]).filter((p): p is Platform => VALID_PLATFORMS.includes(p as Platform));
  } else if (typeof args.platform === "string" && VALID_PLATFORMS.includes(args.platform as Platform)) {
    platforms = [args.platform as Platform];
  }

  const days = clampDays(args.days);
  const period = { days, from: dateNDaysAgo(days - 1), to: todayISO() };
  const params: Record<string, unknown> = {};

  switch (tool) {
    case "pause_low_ctr_campaigns":
      params.threshold = Number(args.threshold_pct ?? 1);
      break;
    case "adjust_bids": {
      const p = Number(args.percent);
      params.percent = Number.isFinite(p) && p > 0 ? Math.min(300, p) : 10;
      params.direction = args.direction === "down" ? "down" : "up";
      params.filter = args.filter === "with_conversions" ? "with_conversions" : "all";
      break;
    }
    case "set_campaign_status":
      if (typeof args.campaign_name !== "string" || !args.campaign_name.trim()) return null;
      params.name = String(args.campaign_name).trim();
      params.status = args.status === "active" ? "active" : "paused";
      break;
    case "promote_low_view_listings":
      params.threshold = Number(args.min_views_per_day ?? 10);
      platforms = []; // Avito-only tool
      break;
    case "add_negative_keywords":
      if (!Array.isArray(args.words) || args.words.length === 0) return null;
      params.words = (args.words as unknown[]).map(String).slice(0, 20);
      break;
    case "apply_recommendation":
      if (typeof args.id === "number") params.id = args.id;
      else params.all = true;
      break;
    case "create_campaign":
      if (typeof args.name === "string" && args.name.trim()) params.name = args.name.trim();
      if (typeof args.budget === "number") params.budget = Math.min(500000, Math.max(100, args.budget));
      if (typeof args.url === "string") params.url = args.url;
      if (typeof args.ad_group_name === "string") params.adGroupName = args.ad_group_name;
      if (typeof args.title === "string") params.title = args.title;
      if (typeof args.text === "string") params.text = args.text;
      if (Array.isArray(args.keywords)) params.keywords = args.keywords.map(String).slice(0, 1000);
      if (Array.isArray(args.negative_keywords)) params.negativeKeywords = args.negative_keywords.map(String).slice(0, 100);
      if (Array.isArray(args.region_ids)) params.regionIds = args.region_ids.map(Number);
      // Phase E.2: responsive ad surface
      if (Array.isArray(args.titles) && args.titles.length) params.titles = args.titles.map(String).filter(Boolean).slice(0, 7);
      if (Array.isArray(args.callouts) && args.callouts.length) params.callouts = args.callouts.map(String).filter(Boolean).slice(0, 5);
      if (typeof args.price_rubles === "number" && args.price_rubles > 0) params.priceRubles = Math.round(args.price_rubles);
      if (typeof args.price_old_rubles === "number" && args.price_old_rubles > 0) params.priceOldRubles = Math.round(args.price_old_rubles);
      if (args.price_qualifier === "from" || args.price_qualifier === "up_to") params.priceQualifier = args.price_qualifier;
      if (typeof args.tracking_params === "string" && args.tracking_params.trim()) params.trackingParams = args.tracking_params.trim().slice(0, 500);
      if (Array.isArray(args.images) && args.images.length)
        params.images = (args.images as { url?: string; name?: string }[])
          .filter((x) => x && typeof x.url === "string" && /^https?:\/\//i.test(x.url)).slice(0, 5);
      break;
    case "list_campaigns":
      params.status = ["all", "active", "paused"].includes(args.status as string) ? (args.status as string) : "all";
      break;
    case "get_avito_chat_summary":
      platforms = []; // Avito-only tool
      break;
    default:
      break;
  }

  return { tool, platforms, period, params: tool === "create_campaign" ? mergeRuleSpecIntoLlmParams(params, text) : params };
}

/**
 * Resolves the user's intent: LLM tool-calling first (when configured),
 * deterministic rule parser as a guaranteed fallback.
 */
export async function resolveIntent(text: string, ctx: SessionContext): Promise<ResolvedIntent> {
  if (isLlmConfigured()) {
    try {
      const intent = await llmResolveIntent(text, ctx);
      // Misfire guard (E.2): an explicit create-campaign spec in the user's text
      // is deterministic ground truth. Small LLMs occasionally read a headline
      // word (e.g. «Запуск кампаний…») as another tool — the rule parser wins.
      if (intent && intent.tool !== "create_campaign") {
        const rules = parseIntent(text);
        if (rules.tool === "create_campaign") {
          console.warn(`[router] LLM picked "${intent.tool}" but the text is an explicit create_campaign spec — using rules`);
          return { intent: rules, engine: "rules", llmError: `llm misfire (${intent.tool}) on explicit create spec` };
        }
      }
      if (intent) return { intent, engine: "llm", model: llmModel() };
    } catch (e) {
      const msg = (e as Error).message;
      console.error("[router] LLM intent failed, falling back to rules:", msg);
      return { intent: parseIntent(text), engine: "rules", llmError: msg };
    }
  }
  return { intent: parseIntent(text), engine: "rules" };
}
