"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { HBar, PlatformBadge, StatusPill } from "./ui";
import type { AgentMeta, ChatMessageRow, Platform, ResultPayload } from "@/lib/agent/types";
import { fmtDate, fmtMoney, fmtNum, fmtPct, fmtTime } from "@/lib/format";

const QUICK = [
  "Покажи расходы по Google, Директу и Авито за последние 7 дней",
  "Поставь на паузу кампании с CTR ниже 1%",
  "Продвинь объявления на Авито с низким количеством просмотров",
  "Сравни CPA между Google Ads и Яндекс.Директ",
  "Сделай аудит всех подключённых кабинетов",
  "Подними ставки на 10% по ключам с конверсиями",
];

const PLATFORM_HEX: Record<Platform, string> = { google: "#6aa6f5", yandex: "#fb5a3c", avito: "#47d185" };

export function Chat() {
  const [msgs, setMsgs] = useState<ChatMessageRow[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [resolved, setResolved] = useState<Record<number, "applied" | "rejected">>({});
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/agent/messages")
      .then((r) => r.json())
      .then((d) => {
        setMsgs(d.messages ?? []);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs, busy]);

  const send = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t || busy) return;
      setInput("");
      setBusy(true);
      try {
        const res = await fetch("/api/agent/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: t }),
        });
        const d = await res.json();
        if (d.user && d.agent) setMsgs((m) => [...m, d.user, d.agent]);
      } catch {
        setMsgs((m) => [...m, { id: -1, role: "agent", content: "Ошибка сети — попробуйте ещё раз.", meta: null, createdAt: new Date().toISOString() }]);
      } finally {
        setBusy(false);
      }
    },
    [busy]
  );

  const resolve = useCallback(async (id: number, decision: "approve" | "reject") => {
    try {
      const res = await fetch("/api/agent/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision }),
      });
      const d = await res.json();
      setResolved((r) => ({ ...r, [id]: decision === "approve" ? "applied" : "rejected" }));
      if (d.agent) setMsgs((m) => [...m, d.agent]);
    } catch {
      /* noop */
    }
  }, []);

  const clear = useCallback(async () => {
    await fetch("/api/agent/clear", { method: "POST" });
    const d = await (await fetch("/api/agent/messages")).json();
    setMsgs(d.messages ?? []);
    setResolved({});
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto pb-4 pr-1">
        {!loaded && (
          <div className="flex items-center gap-2 py-10 text-sm text-fog">
            <Icon name="refresh" className="h-4 w-4 animate-spin" /> Загружаем историю диалога…
          </div>
        )}
        {msgs.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="rise-in flex justify-end">
              <div className="max-w-[80%] rounded-xl rounded-br-sm border border-accent/30 bg-accent/10 px-4 py-2.5 text-sm text-snow">
                {m.content}
                <div className="mt-1 text-right text-[10px] text-fog">{fmtTime(m.createdAt)}</div>
              </div>
            </div>
          ) : (
            <AgentMessage key={m.id} msg={m} resolved={resolved} onResolve={resolve} onSend={send} />
          )
        )}
        {busy && (
          <div className="rise-in flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 text-sm text-fog">
            <span className="flex gap-1">
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-accent" />
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-accent" />
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-accent" />
            </span>
            Агент анализирует запрос: разбирает намерение, маршрутизирует адаптерам, проверяет safety-слой…
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {QUICK.map((q) => (
          <button
            key={q}
            onClick={() => send(q)}
            disabled={busy}
            className="rounded-full border border-line bg-panel2 px-3 py-1.5 text-[11px] text-mist transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-40"
          >
            {q}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="mt-3 flex items-center gap-2 rounded-xl border border-line bg-panel p-2 focus-within:border-accent/50"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Напишите команду на русском или английском… (например: покажи расходы за неделю)"
          className="min-w-0 flex-1 bg-transparent px-2 py-2 text-sm text-snow placeholder:text-fog/60 focus:outline-none"
          maxLength={500}
        />
        <button
          type="button"
          onClick={clear}
          title="Очистить историю"
          className="rounded-lg p-2 text-fog transition-colors hover:bg-panel3 hover:text-bad"
        >
          <Icon name="trash" className="h-4 w-4" />
        </button>
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-accent-ink transition-transform hover:-translate-y-px disabled:opacity-40 disabled:hover:translate-y-0"
        >
          <Icon name="send" className="h-4 w-4" />
          Отправить
        </button>
      </form>
    </div>
  );
}

function AgentMessage({
  msg,
  resolved,
  onResolve,
  onSend,
}: {
  msg: ChatMessageRow;
  resolved: Record<number, "applied" | "rejected">;
  onResolve: (id: number, d: "approve" | "reject") => void;
  onSend: (text: string) => void;
}) {
  const meta = msg.meta;
  return (
    <div className="rise-in rounded-xl border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 text-accent">
          <Icon name="bot" className="h-3.5 w-3.5" />
        </span>
        <span className="text-xs font-bold uppercase tracking-wide text-fog">Агент</span>
        {meta && (
          <>
            <code className="rounded bg-panel3 px-1.5 py-0.5 text-[11px] text-accent">{meta.tool}</code>
            {meta.platforms.map((p) => (
              <PlatformBadge key={p} p={p} small />
            ))}
            <span className="ml-auto flex items-center gap-1 text-[10px] text-fog">
              <Icon name="clock" className="h-3 w-3" />
              {meta.durationMs} мс · {fmtTime(msg.createdAt)}
            </span>
          </>
        )}
      </div>

      <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-snow">{msg.content}</p>

      {meta && (
        <>
          <Trace trace={meta.trace} />
          <div className="mt-3">
            <ResultView result={meta.result} resolved={resolved} onResolve={onResolve} onSend={onSend} />
          </div>
        </>
      )}
    </div>
  );
}

function Trace({ trace }: { trace: AgentMeta["trace"] }) {
  return (
    <details className="mt-3 rounded-lg border border-line bg-panel2">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-fog hover:text-mist">
        Трассировка выполнения · {trace.length} шагов
      </summary>
      <div className="space-y-1.5 border-t border-line px-3 py-2.5">
        {trace.map((t, i) => (
          <div key={i} className="flex items-start gap-2 text-xs">
            <span
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
                t.status === "ok" ? "bg-good/15 text-good" : t.status === "warn" ? "bg-warn/15 text-warn" : "bg-bad/15 text-bad"
              }`}
            >
              <Icon name={t.status === "ok" ? "check" : t.status === "warn" ? "alert" : "x"} className="h-2.5 w-2.5" />
            </span>
            <div>
              <span className="text-mist">{t.label}</span>
              {t.detail ? <span className="text-fog"> — {t.detail}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function Th({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th className={`whitespace-nowrap border-b border-line px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-fog ${right ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

function Td({ children, right = false, className = "" }: { children: React.ReactNode; right?: boolean; className?: string }) {
  return <td className={`num whitespace-nowrap border-b border-line/50 px-2 py-1.5 text-xs ${right ? "text-right" : "text-left"} ${className}`}>{children}</td>;
}

function ResultView({
  result,
  resolved,
  onResolve,
  onSend,
}: {
  result: ResultPayload;
  resolved: Record<number, "applied" | "rejected">;
  onResolve: (id: number, d: "approve" | "reject") => void;
  onSend: (text: string) => void;
}) {
  switch (result.kind) {
    case "text":
      return <div className="whitespace-pre-line rounded-lg border border-line bg-panel2 p-3 text-xs leading-relaxed text-mist">{result.text}</div>;

    case "spend_report":
      return (
        <div className="overflow-x-auto rounded-lg border border-line bg-panel2">
          <table className="w-full">
            <thead>
              <tr>
                <Th>Платформа</Th>
                <Th right>Расход</Th>
                <Th right>Показы</Th>
                <Th right>Клики</Th>
                <Th right>Конверсии</Th>
                <Th right>CTR</Th>
                <Th right>CPA</Th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.platform}>
                  <Td><PlatformBadge p={r.platform} small /></Td>
                  <Td right className="font-semibold text-snow">{fmtMoney(r.spend)}</Td>
                  <Td right>{fmtNum(r.impressions)}</Td>
                  <Td right>{fmtNum(r.clicks)}</Td>
                  <Td right>{fmtNum(r.conversions)}</Td>
                  <Td right>{fmtPct(r.ctr, 2)}</Td>
                  <Td right>{r.cpa ? fmtMoney(r.cpa) : "—"}</Td>
                </tr>
              ))}
              <tr className="bg-panel3/50">
                <Td className="font-bold text-accent">Итого · {result.total.campaigns} объектов</Td>
                <Td right className="font-bold text-accent">{fmtMoney(result.total.spend)}</Td>
                <Td right>{fmtNum(result.total.impressions)}</Td>
                <Td right>{fmtNum(result.total.clicks)}</Td>
                <Td right>{fmtNum(result.total.conversions)}</Td>
                <Td right>{fmtPct(result.total.ctr, 2)}</Td>
                <Td right>{result.total.cpa ? fmtMoney(result.total.cpa) : "—"}</Td>
              </tr>
            </tbody>
          </table>
          <div className="px-3 py-2 text-[10px] text-fog">
            Период: {fmtDate(result.period.from)} — {fmtDate(result.period.to)} · Клики для Авито = контакты, показы = просмотры (единая схема)
          </div>
        </div>
      );

    case "cpa_compare": {
      const max = Math.max(...result.rows.map((r) => r.cpa ?? 0), 1);
      return (
        <div className="rounded-lg border border-line bg-panel2 p-4">
          <div className="mb-3 text-[10px] uppercase tracking-wide text-fog">
            CPA по площадкам · {fmtDate(result.period.from)} — {fmtDate(result.period.to)}
          </div>
          <div className="space-y-2.5">
            {result.rows.map((r) => (
              <HBar
                key={r.platform}
                label={<PlatformBadge p={r.platform} small />}
                value={r.cpa ?? 0}
                max={max}
                color={r.platform === result.best ? "#4ecb8d" : PLATFORM_HEX[r.platform]}
                suffix={r.cpa ? fmtMoney(r.cpa) : "нет конверсий"}
              />
            ))}
          </div>
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-good/30 bg-good/10 px-3 py-2 text-xs text-mist">
            <Icon name="sparkle" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" />
            {result.insight}
          </div>
        </div>
      );
    }

    case "campaigns":
      return (
        <div className="overflow-x-auto rounded-lg border border-line bg-panel2">
          <table className="w-full">
            <thead>
              <tr>
                <Th>Кампания / объявление</Th>
                <Th>Платформа</Th>
                <Th>Статус</Th>
                <Th right>Бюджет/день</Th>
                <Th right>Расход</Th>
                <Th right>CTR</Th>
                <Th right>CPA</Th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.id}>
                  <Td className="max-w-56 truncate whitespace-normal">{r.name}</Td>
                  <Td><PlatformBadge p={r.platform} small /></Td>
                  <Td><StatusPill status={r.status} /></Td>
                  <Td right>{r.budgetDaily ? fmtMoney(r.budgetDaily) : "—"}</Td>
                  <Td right className="font-semibold text-snow">{fmtMoney(r.spend)}</Td>
                  <Td right>{fmtPct(r.ctr, 2)}</Td>
                  <Td right>{r.cpa ? fmtMoney(r.cpa) : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.note ? <div className="px-3 py-2 text-[10px] text-fog">{result.note}</div> : null}
        </div>
      );

    case "keywords":
      return (
        <div className="overflow-x-auto rounded-lg border border-line bg-panel2">
          <table className="w-full">
            <thead>
              <tr>
                <Th>Ключевая фраза</Th>
                <Th>Кампания</Th>
                <Th right>Ставка</Th>
                <Th right>Клики</Th>
                <Th right>Расход</Th>
                <Th right>Конв.</Th>
                <Th right>CPA</Th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.id}>
                  <Td className="max-w-52 truncate">{r.text}</Td>
                  <Td className="max-w-44 truncate text-fog">{r.campaign}</Td>
                  <Td right>{fmtMoney(r.bid, 1)}</Td>
                  <Td right>{fmtNum(r.clicks)}</Td>
                  <Td right>{fmtMoney(r.spend)}</Td>
                  <Td right className={r.conversions > 0 ? "text-good" : "text-bad"}>{r.conversions}</Td>
                  <Td right>{r.cpa ? fmtMoney(r.cpa) : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.note ? <div className="px-3 py-2 text-[10px] text-fog">{result.note}</div> : null}
        </div>
      );

    case "audit":
      return (
        <div className="rounded-lg border border-line bg-panel2 p-4">
          <div className="mb-3 flex items-center gap-3">
            <div
              className={`flex h-14 w-14 items-center justify-center rounded-full border-4 font-display text-lg font-bold ${
                result.score >= 80 ? "border-good/40 text-good" : result.score >= 60 ? "border-warn/40 text-warn" : "border-bad/40 text-bad"
              }`}
            >
              {result.score}
            </div>
            <div>
              <div className="text-sm font-bold">Оценка здоровья аккаунтов</div>
              <div className="text-xs text-fog">
                {result.recsCreated > 0 ? `Создано ${result.recsCreated} новых рекомендаций · ` : ""}
                напишите «покажи рекомендации» или «примени все рекомендации»
              </div>
            </div>
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            {result.platforms.map((b) => (
              <div key={b.platform} className="rounded-lg border border-line bg-panel p-3">
                <PlatformBadge p={b.platform} small />
                <div className="mt-2 space-y-2">
                  {b.issues.length === 0 && <div className="text-xs text-good">Замечаний нет — всё в порядке.</div>}
                  {b.issues.map((iss, i) => (
                    <div key={i} className="flex items-start gap-2 text-[11px] leading-snug text-mist">
                      <span
                        className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                          iss.severity === "high" ? "bg-bad" : iss.severity === "medium" ? "bg-warn" : "bg-fog"
                        }`}
                      />
                      {iss.text}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      );

    case "recommendations":
      return (
        <div className="space-y-2">
          {result.rows.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel2 p-3">
              <PlatformBadge p={r.platform} small />
              <span className="text-xs text-mist" style={{ flex: 1, minWidth: 200 }}>
                <span className="font-semibold text-snow">#{r.id}</span> · {r.description}
                {r.impact ? <span className="text-fog"> · эффект: {r.impact}</span> : null}
              </span>
              {r.status === "open" ? (
                <button
                  onClick={() => onSend(`Примени рекомендацию #${r.id}`)}
                  className="rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-semibold text-accent hover:bg-accent/20"
                >
                  Применить
                </button>
              ) : (
                <StatusPill status={r.status} />
              )}
            </div>
          ))}
        </div>
      );

    case "chats":
      return (
        <div className="rounded-lg border border-line bg-panel2 p-4">
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            <span className="rounded-md border border-line bg-panel px-2 py-1">Диалогов: <b className="num">{result.summary.total}</b></span>
            <span className="rounded-md border border-good/30 bg-good/10 px-2 py-1 text-good">Лидов: <b className="num">{result.summary.leads}</b></span>
            <span className="rounded-md border border-line bg-panel px-2 py-1">Конверсия в лид: <b className="num">{result.summary.convPct}%</b></span>
          </div>
          <div className="space-y-2">
            {result.rows.map((c) => (
              <div key={c.id} className="rounded-lg border border-line bg-panel p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold">{c.customer}</span>
                  <span className="text-[11px] text-fog">· {c.listing}</span>
                  <span className="ml-auto"><StatusPill status={c.status} /></span>
                </div>
                <div className="mt-1 truncate text-[11px] text-mist">«{c.lastMessage}»</div>
                <div className="mt-0.5 text-[10px] text-fog">{fmtNum(c.messagesCount)} сообщений · {fmtDate(c.startedAt)}</div>
              </div>
            ))}
          </div>
        </div>
      );

    case "preview": {
      const pendingId = result.pendingActionId;
      const state = pendingId ? resolved[pendingId] : undefined;
      return (
        <div
          className={`rounded-lg border p-4 ${
            result.verdict === "blocked" ? "border-bad/40 bg-bad/5" : "border-warn/30 bg-warn/5"
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Icon name={result.verdict === "blocked" ? "lock" : "shield"} className={`h-4 w-4 ${result.verdict === "blocked" ? "text-bad" : "text-warn"}`} />
            <span className="text-sm font-bold">{result.title}</span>
            {result.verdict === "blocked" ? (
              <span className="ml-auto rounded-full border border-bad/40 bg-bad/10 px-2 py-0.5 text-[10px] font-bold uppercase text-bad">заблокировано</span>
            ) : (
              <span className="ml-auto rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-[10px] font-bold uppercase text-warn">
                {state ? (state === "applied" ? "выполнено" : "отклонено") : "требует подтверждения"}
              </span>
            )}
          </div>

          <div className="mt-3 space-y-1.5">
            {result.changes.map((c, i) => (
              <div key={i} className="rounded-md border border-line bg-panel px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-fog">{c.entity}</span>
                  <span className="font-semibold text-snow">{c.name}</span>
                  {c.note ? <span className="text-fog">· {c.note}</span> : null}
                </div>
                {(c.before || c.after) && (
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {c.before ? <span className="rounded bg-panel3 px-1.5 py-0.5 text-[11px] text-fog line-through decoration-fog/50">{c.before}</span> : null}
                    <Icon name="arrow" className="h-3 w-3 text-accent" />
                    {c.after ? <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-semibold text-accent">{c.after}</span> : null}
                  </div>
                )}
              </div>
            ))}
          </div>

          {typeof result.cost === "number" && (
            <div className="mt-2 text-[11px] text-fog">
              Ожидаемые дополнительные расходы: <b className="text-warn">{fmtMoney(result.cost)}/день</b>
            </div>
          )}

          {result.verdict === "blocked" && result.reason ? (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-mist">
              <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bad" />
              {result.reason}
            </div>
          ) : null}

          {result.verdict === "pending" && pendingId && !state && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => onResolve(pendingId, "approve")}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-bold text-accent-ink hover:-translate-y-px"
              >
                <Icon name="check" className="h-3.5 w-3.5" /> Подтвердить и выполнить
              </button>
              <button
                onClick={() => onResolve(pendingId, "reject")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3.5 py-1.5 text-xs font-semibold text-mist hover:border-bad/40 hover:text-bad"
              >
                <Icon name="x" className="h-3.5 w-3.5" /> Отклонить
              </button>
              <span className="self-center text-[10px] text-fog">Dry-run: пока изменения не применены</span>
            </div>
          )}
        </div>
      );
    }

    default:
      return null;
  }
}
