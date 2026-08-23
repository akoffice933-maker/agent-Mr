"use client";

import { useMemo, useState } from "react";
import { Icon } from "./icons";
import { PlatformBadge, StatusPill } from "./ui";
import type { Platform } from "@/lib/agent/types";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/format";
import { apiFetch } from "@/lib/api-client";

export interface CampaignUiRow {
  id: number;
  platform: Platform;
  kind: string;
  name: string;
  status: string;
  budgetDaily: number;
  strategy: string;
  promotion: string;
  price: number | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cpa: number | null;
}

export function CampaignsTable({ rows }: { rows: CampaignUiRow[] }) {
  const [platform, setPlatform] = useState<"all" | Platform>("all");
  const [status, setStatus] = useState<"all" | "active" | "paused">("all");
  const [q, setQ] = useState("");
  const [local, setLocal] = useState<Record<number, Partial<CampaignUiRow>>>({});
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: "ok" | "warn" | "bad" }[]>([]);

  const notify = (text: string, kind: "ok" | "warn" | "bad" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  };

  const filtered = useMemo(() => {
    return rows
      .map((r) => ({ ...r, ...local[r.id] }))
      .filter((r) => platform === "all" || r.platform === platform)
      .filter((r) => status === "all" || r.status === status)
      .filter((r) => r.name.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => b.spend - a.spend);
  }, [rows, local, platform, status, q]);

  const act = async (row: CampaignUiRow, action: "pause" | "resume" | "promote") => {
    try {
      const res = await apiFetch("/api/campaigns/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId: row.id, action }),
      });
      const d = await res.json();
      if (res.status === 403) {
        notify("Заблокировано: включён режим «только чтение». Запись в audit-log создана.", "bad");
        return;
      }
      if (d.dryRunBlocked) {
        notify(`Dry-run: «${action === "pause" ? "пауза" : action === "resume" ? "запуск" : "продвижение"} — ${row.name}» не применено. Запись в audit-log создана.`, "warn");
        return;
      }
      if (action === "pause") setLocal((l) => ({ ...l, [row.id]: { status: "paused" } }));
      if (action === "resume") setLocal((l) => ({ ...l, [row.id]: { status: "active" } }));
      if (action === "promote") setLocal((l) => ({ ...l, [row.id]: { promotion: "boost7" } }));
      notify(`Выполнено: ${row.name}. Записано в audit-log.`, "ok");
    } catch {
      notify("Ошибка сети", "bad");
    }
  };

  const chips: { key: "all" | Platform; label: string }[] = [
    { key: "all", label: "Все платформы" },
    { key: "google", label: "Google Ads" },
    { key: "yandex", label: "Яндекс.Директ" },
    { key: "avito", label: "Авито" },
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {chips.map((c) => (
          <button
            key={c.key}
            onClick={() => setPlatform(c.key)}
            className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
              platform === c.key ? "border-accent/50 bg-accent/15 text-accent" : "border-line bg-panel2 text-fog hover:text-mist"
            }`}
          >
            {c.label}
          </button>
        ))}
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          className="rounded-lg border border-line bg-panel2 px-2.5 py-1.5 text-xs text-mist focus:outline-none"
        >
          <option value="all">Все статусы</option>
          <option value="active">Активные</option>
          <option value="paused">На паузе</option>
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Поиск по названию…"
          className="ml-auto w-52 rounded-lg border border-line bg-panel2 px-3 py-1.5 text-xs text-snow placeholder:text-fog/60 focus:border-accent/40 focus:outline-none"
        />
      </div>

      <div className="overflow-x-auto rounded-xl border border-line bg-panel">
        <table className="w-full">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-fog">
              <th className="border-b border-line px-3 py-2.5">Название</th>
              <th className="border-b border-line px-3 py-2.5">Платформа</th>
              <th className="border-b border-line px-3 py-2.5">Статус</th>
              <th className="border-b border-line px-3 py-2.5">Стратегия / продвижение</th>
              <th className="border-b border-line px-3 py-2.5 text-right">Бюджет/день</th>
              <th className="border-b border-line px-3 py-2.5 text-right">Расход 7д</th>
              <th className="border-b border-line px-3 py-2.5 text-right">Показы 7д</th>
              <th className="border-b border-line px-3 py-2.5 text-right">CTR</th>
              <th className="border-b border-line px-3 py-2.5 text-right">CPA</th>
              <th className="border-b border-line px-3 py-2.5 text-right">Действие</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="hover:bg-panel2/60">
                <td className="border-b border-line/50 px-3 py-2.5">
                  <div className="max-w-56 truncate text-xs font-semibold text-snow">{r.name}</div>
                  {r.kind === "listing" && r.price ? <div className="text-[10px] text-fog">цена {fmtMoney(r.price)}</div> : null}
                </td>
                <td className="border-b border-line/50 px-3 py-2.5"><PlatformBadge p={r.platform} small /></td>
                <td className="border-b border-line/50 px-3 py-2.5"><StatusPill status={r.status} /></td>
                <td className="border-b border-line/50 px-3 py-2.5 text-[11px] text-mist">
                  {r.kind === "listing" ? <StatusPill status={r.promotion} /> : r.strategy}
                </td>
                <td className="num border-b border-line/50 px-3 py-2.5 text-right text-xs">{r.budgetDaily ? fmtMoney(r.budgetDaily) : "—"}</td>
                <td className="num border-b border-line/50 px-3 py-2.5 text-right text-xs font-semibold">{fmtMoney(r.spend)}</td>
                <td className="num border-b border-line/50 px-3 py-2.5 text-right text-xs">{fmtNum(r.impressions)}</td>
                <td className="num border-b border-line/50 px-3 py-2.5 text-right text-xs">{fmtPct(r.ctr, 2)}</td>
                <td className="num border-b border-line/50 px-3 py-2.5 text-right text-xs">{r.cpa ? fmtMoney(r.cpa) : "—"}</td>
                <td className="border-b border-line/50 px-3 py-2.5 text-right">
                  {r.kind === "listing" ? (
                    r.promotion === "none" ? (
                      <button
                        onClick={() => act(r, "promote")}
                        className="rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-[10px] font-bold text-accent hover:bg-accent/20"
                      >
                        Продвинуть
                      </button>
                    ) : (
                      <span className="text-[10px] text-fog">—</span>
                    )
                  ) : r.status === "active" ? (
                    <button
                      onClick={() => act(r, "pause")}
                      className="inline-flex items-center gap-1 rounded-md border border-warn/40 bg-warn/10 px-2 py-1 text-[10px] font-bold text-warn hover:bg-warn/20"
                    >
                      <Icon name="pause" className="h-3 w-3" /> Пауза
                    </button>
                  ) : (
                    <button
                      onClick={() => act(r, "resume")}
                      className="inline-flex items-center gap-1 rounded-md border border-good/40 bg-good/10 px-2 py-1 text-[10px] font-bold text-good hover:bg-good/20"
                    >
                      <Icon name="play" className="h-3 w-3" /> Запустить
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-8 text-center text-sm text-fog">
                  Ничего не найдено — измените фильтры.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pointer-events-none fixed bottom-5 right-5 z-50 space-y-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rise-in max-w-sm rounded-lg border px-3.5 py-2.5 text-xs font-medium shadow-xl ${
              t.kind === "ok"
                ? "border-good/40 bg-[#0f1d16] text-good"
                : t.kind === "warn"
                  ? "border-warn/40 bg-[#1f1a0e] text-warn"
                  : "border-bad/40 bg-[#201110] text-bad"
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
