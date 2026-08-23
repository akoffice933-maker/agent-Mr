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

import { Bot } from "grammy";
import { formatAgentReply, type AgentMetaLike } from "./format.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set (get one from @BotFather)");
  process.exit(1);
}

const API = process.env.AGENT_API_URL ?? "http://localhost:3000";
const API_KEY = process.env.AGENT_API_KEY ?? "";

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

const bot = new Bot(TOKEN);

const HELP_TEXT =
  "Команды:\n" +
  "• /report — сводный расход по площадкам (можно /report 14)\n" +
  "• /audit — полный аудит кабинетов + рекомендации\n" +
  "• /pending — действия, ожидающие подтверждения\n" +
  "• любой текст — команда агенту: «Сравни CPA между Google и Директом», «Поставь на паузу кампании с CTR ниже 1%»\n\n" +
  "Действия, влияющие на бюджет, приходят на подтверждение кнопками.";

bot.command("start", (ctx) => ctx.reply(`Привет! Я Unified AI Ads Agent — Google Ads, Яндекс.Директ и Авито в одном чате.\n\n${HELP_TEXT}`));
bot.command("help", (ctx) => ctx.reply(HELP_TEXT));

// /report [days] — cross-platform spend report (direct REST, no chat noise)
bot.on("message:text", async (ctx) => {
  if (!/^\/report( \d+)?$/.test(ctx.message?.text ?? "")) return;
  try {
    const status = await ctx.reply("⏳ Собираю отчёт…");
    const d = (await api("/api/campaigns?days=7&status=all")) as { rows: { platform: string; spend: number; impressions: number; clicks: number; conversions: number; ctr: number; cpa: number | null }[] };
    const byPlat = new Map<string, { s: number; i: number; k: number; v: number }>();
    for (const r of d.rows) {
      const cur = byPlat.get(r.platform) ?? { s: 0, i: 0, k: 0, v: 0 };
      cur.s += r.spend; cur.i += r.impressions; cur.k += r.clicks; cur.v += r.conversions;
      byPlat.set(r.platform, cur);
    }
    const lines = byPlat.size
      ? [...byPlat.entries()].map(([p, a]) => {
          const cpa = a.v > 0 ? money(a.s / a.v) : "—";
          return `• ${PLAT_LABEL[p] ?? p}: ${money(a.s)} · CTR ${a.i ? ((a.k / a.i) * 100).toFixed(2) : "0"}% · CPA ${cpa}`;
        })
      : ["Нет данных."];
    const total = [...byPlat.values()].reduce((x, a) => x + a.s, 0);
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, `📊 Расход за 7 дней: ${money(total)}\n${lines.join("\n")}`);
  } catch (e) {
    await ctx.reply(`Ошибка: ${(e as Error).message}`);
  }
});

// /audit — run the full audit through the agent
bot.on("message:text", async (ctx) => {
  if (!/^\/audit$/.test(ctx.message?.text ?? "")) return;
  try {
    const status = await ctx.reply("⏳ Запускаю аудит…");
    const d = (await api("/api/agent/chat", { method: "POST", body: JSON.stringify({ message: "Сделай аудит всех кабинетов" }) })) as {
      agent: { content: string; meta: AgentMetaLike | null };
    };
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, formatAgentReply(d.agent.content, d.agent.meta));
  } catch (e) {
    await ctx.reply(`Ошибка: ${(e as Error).message}`);
  }
});

// /pending — list pending actions with approve/reject buttons
bot.on("message:text", async (ctx) => {
  if (!/^\/pending$/.test(ctx.message?.text ?? "")) return;
  try {
    const d = (await api("/api/agent/pending")) as { items: { id: number; tool: string; costDaily: number | null; preview?: { title?: string } }[] };
    const items = d.items ?? [];
    if (!items.length) return ctx.reply("Нет действий, ожидающих подтверждения.");
    const keyboard = items.map((i) => [
      { text: `✅ #${i.id}`, callback_data: `act:${i.id}:ok:${ctx.chat.id}` },
      { text: `❌ #${i.id}`, callback_data: `act:${i.id}:no:${ctx.chat.id}` },
    ]);
    const list = items.map((i) => `#${i.id} · ${i.tool}${i.preview?.title ? ` — ${i.preview.title}` : ""}${i.costDaily ? ` (≈ +${money(i.costDaily)}/день)` : ""}`).join("\n");
    await ctx.reply(`Ожидают подтверждения:\n${list}`, { reply_markup: { inline_keyboard: keyboard } });
  } catch (e) {
    await ctx.reply(`Ошибка: ${(e as Error).message}`);
  }
});

// Free text → agent
bot.on("message:text", async (ctx) => {
  const message = ctx.message?.text;
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (!message || !chatId || message.startsWith("/")) return;
  try {
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

bot.start({
  onStart: (me) => console.log(`[agent-mr tg] @${me.username} started, proxying ${API}`),
});
