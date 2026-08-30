// Telegram bot for Unified AI Ads Agent (ТЗ этап 8, US-6; 14-day plan Day 12).
// Thin client of the agent's REST API:
//   /start, /help — intro
//   /report [days] — cross-platform spend report
//   /audit — run a full account audit
//   /pending — actions awaiting confirmation (with approve/reject buttons)
//   free text — proxied to the agent chat; budget-affecting actions get
//   approve/reject inline buttons.
//
// Run:  TELEGRAM_BOT_TOKEN=123:ABC node dist/index.js  (long polling, no public URL needed)
//
// IMPORTANT (grammy >=1.4x middleware semantics): a matched filter branch
// consumes the update — middleware registered after it never runs unless the
// handler calls next(). Therefore ALL text commands live in ONE dispatcher.
// Also, bot.command matches only messages with the `bot_command` entity (real
// typed commands); PASTED "/start" has no entity — the dispatcher covers those
// with a plain-text fallback.

import { pathToFileURL } from "node:url";
import { Bot, type BotConfig, type Context, type Filter } from "grammy";
type TextCtx = Filter<Context, "message:text">;
import { formatAgentReply, type AgentMetaLike } from "./format.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set (get one from @BotFather)");
  process.exit(1);
}

const API = process.env.AGENT_API_URL ?? "http://localhost:3000";
const API_KEY = process.env.AGENT_API_KEY ?? "";

/**
 * Chat allowlist (review P2).
 *
 * A Telegram bot token is a public endpoint: anyone who learns the bot's
 * @username can message it. This bot holds AGENT_API_KEY — a machine key with
 * write capabilities — and proxies free text straight to the agent, so without
 * an allowlist any stranger could read spend reports and approve budget
 * changes on someone else's ad accounts.
 *
 * TELEGRAM_ALLOWED_CHATS is a comma-separated list of numeric chat ids
 * (a user id for a private chat, a negative id for a group).
 *
 * FAIL-CLOSED: if the variable is unset or empty the bot answers nobody and
 * says so at startup. An open bot must be an explicit choice, never the
 * default you get by forgetting to configure it.
 */
const ALLOWED_CHATS: Set<number> = new Set(
  (process.env.TELEGRAM_ALLOWED_CHATS ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n !== 0)
);

export function isChatAllowed(chatId: number | undefined): boolean {
  if (chatId === undefined) return false;
  return ALLOWED_CHATS.has(chatId);
}

const PLAT_LABEL: Record<string, string> = { google: "Google Ads", yandex: "Яндекс.Директ", avito: "Авито" };
const money = (n: number) => `${new Intl.NumberFormat("ru-RU").format(Math.round(n))} ₽`;

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY ? { "x-api-key": API_KEY } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Agent API ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const HELP_TEXT =
  "Команды:\n" +
  "• /report — сводный расход по площадкам (можно /report 14)\n" +
  "• /audit — полный аудит кабинетов + рекомендации\n" +
  "• /pending — действия, ожидающие подтверждения\n" +
  "• любой текст — команда агенту: «Сравни CPA между Google и Директом», «Поставь на паузу кампании с CTR ниже 1%»\n\n" +
  "Действия, влияющие на бюджет, приходят на подтверждение кнопками.";
const INTRO = `Привет! Я Unified AI Ads Agent — Google Ads, Яндекс.Директ и Авито в одном чате.\n\n${HELP_TEXT}`;

export function createBot(config?: BotConfig<Context>): Bot {
  const bot = new Bot(TOKEN, config);

  // Observability: log every update so we can diagnose "bot doesn't answer".
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text ?? ctx.callbackQuery?.data;
    console.log(`[tg] update=${ctx.update.update_id} chat=${ctx.chat?.id ?? "?"} from=${ctx.from?.username ?? ctx.from?.id ?? "?"} text=${JSON.stringify(text ?? null)}`);
    await next();
  });

  // Authorization gate (review P2) — MUST stay ahead of every handler, so a
  // non-allowlisted chat can never reach the agent API. Registered after the
  // logger on purpose: rejected attempts should still be visible in the log.
  bot.use(async (ctx, next) => {
    if (isChatAllowed(ctx.chat?.id)) return next();
    console.warn(
      `[tg] BLOCKED chat=${ctx.chat?.id ?? "?"} from=${ctx.from?.username ?? ctx.from?.id ?? "?"} — not in TELEGRAM_ALLOWED_CHATS`
    );
    // Answer callback queries so the client's spinner stops, but reveal nothing.
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: "Нет доступа." }).catch(() => undefined);
      return;
    }
    await ctx
      .reply(`Нет доступа. Ваш chat id: ${ctx.chat?.id ?? "неизвестен"} — попросите администратора добавить его в TELEGRAM_ALLOWED_CHATS.`)
      .catch(() => undefined);
    // Do NOT call next(): the update stops here.
  });

  // bot.command works for real (typed) commands — Telegram tags them with the
  // bot_command entity.
  bot.command("start", (ctx) => ctx.reply(INTRO));
  bot.command("help", (ctx) => ctx.reply(HELP_TEXT));

  async function sendReport(ctx: TextCtx, days: number): Promise<void> {
    const status = await ctx.reply("⏳ Собираю отчёт…");
    const d = (await api(`/api/campaigns?days=${days}&status=all`)) as {
      rows: { platform: string; spend: number; impressions: number; clicks: number; conversions: number }[];
    };
    const byPlat = new Map<string, { s: number; i: number; k: number; v: number }>();
    for (const r of d.rows) {
      const cur = byPlat.get(r.platform) ?? { s: 0, i: 0, k: 0, v: 0 };
      cur.s += r.spend;
      cur.i += r.impressions;
      cur.k += r.clicks;
      cur.v += r.conversions;
      byPlat.set(r.platform, cur);
    }
    const lines = byPlat.size
      ? [...byPlat.entries()].map(([p, a]) => {
          const cpa = a.v > 0 ? money(a.s / a.v) : "—";
          return `• ${PLAT_LABEL[p] ?? p}: ${money(a.s)} · CTR ${a.i ? ((a.k / a.i) * 100).toFixed(2) : "0"}% · CPA ${cpa}`;
        })
      : ["Нет данных."];
    const total = [...byPlat.values()].reduce((x, a) => x + a.s, 0);
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, `📊 Расход за ${days} дн.: ${money(total)}\n${lines.join("\n")}`);
  }

  async function sendPending(ctx: TextCtx): Promise<void> {
    const d = (await api("/api/agent/pending")) as {
      items: { id: number; tool: string; costDaily: number | null; preview?: { title?: string } }[];
    };
    const items = d.items ?? [];
    if (!items.length) {
      await ctx.reply("Нет действий, ожидающих подтверждения.");
      return;
    }
    const keyboard = items.map((i) => [
      { text: `✅ #${i.id}`, callback_data: `act:${i.id}:ok:${ctx.chat.id}` },
      { text: `❌ #${i.id}`, callback_data: `act:${i.id}:no:${ctx.chat.id}` },
    ]);
    const list = items
      .map((i) => `#${i.id} · ${i.tool}${i.preview?.title ? ` — ${i.preview.title}` : ""}${i.costDaily ? ` (≈ +${money(i.costDaily)}/день)` : ""}`)
      .join("\n");
    await ctx.reply(`Ожидают подтверждения:\n${list}`, { reply_markup: { inline_keyboard: keyboard } });
  }

  async function proxyToAgent(ctx: TextCtx, message: string): Promise<void> {
    const chatId = ctx.chat.id;
    const status = await ctx.reply("⏳ Работаю…");
    const d = (await api("/api/agent/chat", { method: "POST", body: JSON.stringify({ message }) })) as {
      agent: { content: string; meta: AgentMetaLike | null };
    };
    await ctx.api.editMessageText(chatId, status.message_id, formatAgentReply(d.agent.content, d.agent.meta));
    const id = d.agent.meta?.pendingActionId;
    if (id) {
      const confirm = await ctx.reply(`Действие #${id} ожидает подтверждения:`);
      await ctx.api.editMessageText(chatId, confirm.message_id, confirm.text, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Подтвердить", callback_data: `act:${id}:ok:${chatId}` },
              { text: "❌ Отклонить", callback_data: `act:${id}:no:${chatId}` },
            ],
          ],
        },
      });
    }
  }

  // SINGLE text dispatcher — every free text and every command that
  // bot.command didn't consume (e.g. pasted commands without the entity).
  bot.on("message:text", async (ctx) => {
    const text = (ctx.message?.text ?? "").trim();
    const bare = text.startsWith("/") ? (text.slice(1).split(/[\s@]/)[0] ?? "").toLowerCase() : null;

    try {
      if (bare === "start") return ctx.reply(INTRO);
      if (bare === "help") return ctx.reply(HELP_TEXT);
      if (bare === "report") {
        const days = Math.min(90, Math.max(1, parseInt(text.split(/\s+/)[1] ?? "7", 10) || 7));
        return await sendReport(ctx, days);
      }
      if (bare === "audit") return await proxyToAgent(ctx, "Сделай аудит всех кабинетов");
      if (bare === "pending") return await sendPending(ctx);
      if (!text.startsWith("/")) return await proxyToAgent(ctx, text);
      return await ctx.reply("Не знаю такую команду. /help — список команд.");
    } catch (e) {
      await ctx.reply(`Ошибка: ${(e as Error).message}`);
    }
  });

  // Inline buttons: approve/reject (callback data: act:{id}:{ok|no}:{chatId})
  bot.callbackQuery(/^act:(\d+):(ok|no):(-?\d+)$/, async (ctx) => {
    const m = ctx.match;
    if (!m) return;
    const [, , id, decision, chatIdRaw] = m;
    const chatId = Number(chatIdRaw);
    const msgId = ctx.update.callback_query?.message?.message_id;
    if (!msgId) return;
    try {
      await ctx.answerCallbackQuery();
      const d = (await api("/api/agent/action", {
        method: "POST",
        body: JSON.stringify({ id: Number(id), decision: decision === "ok" ? "approve" : "reject" }),
      })) as { agent: { content: string; meta: AgentMetaLike | null } };
      await ctx.api.editMessageText(chatId, msgId, formatAgentReply(d.agent.content, d.agent.meta));
    } catch (e) {
      await ctx.api.editMessageText(chatId, msgId, `Ошибка: ${(e as Error).message}`).catch(() => undefined);
    }
  });

  bot.catch((err) => {
    console.error("bot error:", err.error);
  });

  return bot;
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // Loud warning rather than a silent no-op: an operator who forgot to set the
  // allowlist would otherwise just see a bot that ignores them.
  if (ALLOWED_CHATS.size === 0) {
    console.warn(
      "[agent-mr tg] WARNING: TELEGRAM_ALLOWED_CHATS is empty — the bot will refuse EVERY chat.\n" +
        "  Message the bot once and copy the chat id it replies with, then set e.g.\n" +
        "  TELEGRAM_ALLOWED_CHATS=123456789,-1001234567890"
    );
  }
  const bot = createBot();
  bot.start({
    onStart: (me) =>
      console.log(
        `[agent-mr tg] @${me.username} started, proxying ${API} (allowed chats: ${ALLOWED_CHATS.size || "none — all blocked"})`
      ),
  });
}
