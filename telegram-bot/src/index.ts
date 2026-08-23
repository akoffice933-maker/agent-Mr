// Telegram bot for Unified AI Ads Agent (ТЗ этап 8, US-6).
// Thin client: every message is proxied to POST /api/agent/chat, pending
// actions get approve/reject inline buttons → POST /api/agent/action.
//
// Run:  TELEGRAM_BOT_TOKEN=123:ABC node dist/index.js
//       (long polling — no public URL required)

import { Bot } from "grammy";
import { formatAgentReply, type AgentMetaLike } from "./format.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set (get one from @BotFather)");
  process.exit(1);
}

const API = process.env.AGENT_API_URL ?? "http://localhost:3000";
const API_KEY = process.env.AGENT_API_KEY ?? "";

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

bot.command("start", (ctx) =>
  ctx.reply(
    "Привет! Я Unified AI Ads Agent — управляю Google Ads, Яндекс.Директом и Авито.\n\n" +
      "Пишите команды на естественном языке:\n" +
      "• «Покажи расходы за неделю»\n" +
      "• «Сравни CPA между Google и Директом»\n" +
      "• «Поставь на паузу кампании с CTR ниже 1%»\n" +
      "• «Продвинь объявления Авито с низким охватом»\n" +
      "• «Сделай аудит всех кабинетов»\n\n" +
      "Действия, влияющие на бюджет, требуют подтверждения кнопками.",
  )
);

bot.command("help", (ctx) =>
  ctx.reply(
    "Команды (простым текстом):\n" +
      "• «Покажи расходы за последние 7 дней»\n" +
      "• «Сравни CPA между Google Ads и Яндекс.Директом»\n" +
      "• «Поставь на паузу кампании с CTR ниже 1%»\n" +
      "• «Поставь на паузу «Поиск — Диваны на заказ»»\n" +
      "• «Подними ставки на 10% по ключам с конверсиями»\n" +
      "• «Создай кампанию в Директе с бюджетом 3000»\n" +
      "• «Продвинь объявления на Авито с низким охватом»\n" +
      "• «Сводка по чатам Авито за неделю»\n" +
      "• «Сделай аудит всех кабинетов»\n" +
      "• «Покажи рекомендации» / «Примени все рекомендации»\n\n" +
      "Действия, влияющие на бюджет, отправляю на подтверждение кнопками.",
  )
);

// Free text → agent
bot.on("message:text", async (ctx) => {
  const message = ctx.message?.text;
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (!message || !chatId) return;
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
              { text: "✅ Подтвердить", callback_data: `act:${id}:ok:${chatId}:${confirm.message_id}` },
              { text: "❌ Отклонить", callback_data: `act:${id}:no:${chatId}:${confirm.message_id}` },
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
bot.callbackQuery(/^act:(\d+):(ok|no):(-?\d+):(-?\d+)$/, async (ctx) => {
  const m = ctx.match;
  if (!m) return;
  const [, , id, decision, chatIdRaw, msgIdRaw] = m;
  const chatId = Number(chatIdRaw);
  const msgId = Number(msgIdRaw);
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
