// Dispatch self-test for the Telegram bot (no network, no real token).
// Verifies that EVERY text command and free text produces a reply — this is
// the regression test for the grammy middleware-chain bug where the first
// on("message:text") handler consumed all updates and later handlers died.
import assert from "node:assert";

process.env.TELEGRAM_BOT_TOKEN ??= "123:test-token";
const { createBot } = await import("./index.js");

// --- Mock the Telegram Bot API via the official client fetch hook ---
// grammy creates a fresh Api object per update, so the only clean interception
// point is `new Bot(token, { client: { fetch } })` (see createBot(config)).
type Sent = { kind: "send" | "edit"; text: string; extra?: any };
const sent: Sent[] = [];
const tgFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const method = String(input).split("/").pop() ?? "";
  const body = init?.body ? JSON.parse(init.body as string) : {};
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  if (method === "sendMessage") {
    sent.push({ kind: "send", text: body.text, extra: body });
    return ok({ message_id: sent.length, text: body.text });
  }
  if (method === "editMessageText") {
    sent.push({ kind: "edit", text: body.text, extra: body });
    return ok({ message_id: body.message_id, text: body.text });
  }
  if (method === "answerCallbackQuery") return ok(true);
  return ok({});
};

const bot = createBot({
  botInfo: {
    id: 8818601630,
    is_bot: true,
    first_name: "Agentmr",
    username: "Agentjoi_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    supports_guest_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  },
  client: { fetch: tgFetch },
});

// --- Mock the agent REST API (canned responses) ---
globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit) => {
  const u = String(url);
  const json = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200 });
  if (u.includes("/api/campaigns"))
    return json({
      rows: [
        { platform: "google", spend: 1000, impressions: 100, clicks: 10, conversions: 2 },
        { platform: "avito", spend: 500, impressions: 50, clicks: 5, conversions: 4 },
      ],
    });
  if (u.includes("/api/agent/pending"))
    return json({ items: [{ id: 7, tool: "pause_campaigns", costDaily: null, preview: { title: "Пауза 2 кампаний" } }] });
  if (u.includes("/api/agent/chat"))
    return json({
      user: { id: 1, role: "user", content: "", meta: null, createdAt: "" },
      agent: {
        id: 2,
        role: "agent",
        content: "Агент ответил",
        meta: {
          tool: "pause_campaigns",
          pendingActionId: 7,
          result: { kind: "preview", title: "Пауза 2 кампаний", cost: 100, changes: [{ name: "K1", before: "Активна", after: "Пауза" }] },
        },
      },
    });
  if (u.includes("/api/agent/action"))
    return json({ agent: { content: "Выполнено: действие подтверждено.", meta: null } });
  return new Response("not found", { status: 404 });
}) as typeof fetch;

// --- Update factories ---
const msgUpdate = (text: string, withEntity = false, uid = 1) =>
  ({
    update_id: uid,
    message: {
      message_id: 100,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 123, type: "private" as const },
      from: { id: 1, is_bot: false, first_name: "tester" },
      text,
      ...(withEntity ? { entities: [{ type: "bot_command", offset: 0, length: text.length }] } : {}),
    },
  }) as never;

const cbUpdate = (data: string) =>
  ({
    update_id: 900,
    callback_query: {
      id: "cb1",
      from: { id: 1, is_bot: false, first_name: "tester" },
      chat_instance: "1",
      data,
      message: { message_id: 55, date: 1, chat: { id: 123, type: "private" }, text: "Действие #7 ожидает подтверждения:" },
    },
  }) as never;

const lastText = () => sent[sent.length - 1]?.text ?? "";
const allTexts = () => sent.map((s) => s.text).join(" | ");

let n = 0;
const check = (name: string, cond: boolean, detail: string) => {
  n++;
  assert.ok(cond, `FAIL #${n} ${name}: ${detail}`);
  console.log(`ok ${n} - ${name}`);
};

// 1. Pasted /start (NO bot_command entity) — the case that broke in prod.
sent.length = 0;
await bot.handleUpdate(msgUpdate("/start"));
check("pasted /start", lastText().includes("Unified AI Ads Agent"), allTexts());

// 2. Typed /start (WITH entity) — goes through bot.command.
sent.length = 0;
await bot.handleUpdate(msgUpdate("/start", true));
check("typed /start (entity)", lastText().includes("Unified AI Ads Agent"), allTexts());

// 3. Pasted /help.
sent.length = 0;
await bot.handleUpdate(msgUpdate("/help"));
check("pasted /help", lastText().includes("Команды"), allTexts());

// 4. /report — status message then edited report.
sent.length = 0;
await bot.handleUpdate(msgUpdate("/report", true));
check("/report status", sent.some((s) => s.text === "⏳ Собираю отчёт…"), allTexts());
check("/report result", lastText().includes("📊 Расход за 7 дн.") && lastText().includes("Google Ads"), allTexts());

// 5. /report 14 — days argument honored.
sent.length = 0;
await bot.handleUpdate(msgUpdate("/report 14", true));
check("/report 14", lastText().includes("за 14 дн."), allTexts());

// 6. /pending — list + inline keyboard.
sent.length = 0;
await bot.handleUpdate(msgUpdate("/pending"));
check("/pending list", lastText().includes("#7 · pause_campaigns"), allTexts());
check("/pending keyboard", (sent[sent.length - 1]?.extra?.reply_markup?.inline_keyboard ?? []).length === 1, JSON.stringify(sent[sent.length - 1]?.extra));

// 7. Free text — proxied to agent, then confirmation with buttons (pendingActionId).
sent.length = 0;
await bot.handleUpdate(msgUpdate("Поставь на паузу кампании"));
check("freetext status", sent.some((s) => s.text === "⏳ Работаю…"), allTexts());
check("freetext agent reply", sent.some((s) => s.text.includes("Агент ответил") && s.text.includes("Действие #7")), allTexts());
check("freetext confirm buttons", (sent[sent.length - 1]?.extra?.reply_markup?.inline_keyboard?.[0]?.[0]?.text ?? "") === "✅ Подтвердить", JSON.stringify(sent[sent.length - 1]?.extra));

// 8. Unknown command.
sent.length = 0;
await bot.handleUpdate(msgUpdate("/xyz"));
check("unknown /xyz", lastText().includes("Не знаю такую команду"), allTexts());

// 9. Callback approve.
sent.length = 0;
await bot.handleUpdate(cbUpdate("act:7:ok:123"));
check("callback approve", lastText().includes("Выполнено"), allTexts());

console.log(`\nDISPATCH-SELFTEST OK (${n} checks)`);
