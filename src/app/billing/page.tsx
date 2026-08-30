"use client";

// /billing — plan, live usage and upgrade.
//
// The usage bars are the point of this page: a user who just got "исчерпан
// лимит" in the chat needs to see WHICH limit, how far over they are, and when
// it resets — not just a price list.

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

interface Plan {
  id: string;
  title: string;
  priceMinor: number;
  currency: string;
  maxPlatforms: number;
  maxWriteActionsPerMonth: number;
  maxMembers: number;
}

interface Usage {
  plan: string;
  planTitle: string;
  writeActions: { used: number; limit: number };
  platforms: { used: number; limit: number };
  members: { used: number; limit: number };
  periodResetsAt: string;
}

interface Payload {
  usage: Usage;
  plans: Plan[];
  providers: string[];
  canManageBilling: boolean;
}

const PROVIDER_LABEL: Record<string, string> = {
  yookassa: "ЮKassa",
  stripe: "Stripe",
};

function money(minor: number, currency: string) {
  if (minor === 0) return "0 ₽";
  const major = minor / 100;
  const sym = currency === "RUB" ? "₽" : "$";
  return `${major.toLocaleString("ru-RU")} ${sym}`;
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const full = used >= limit;
  const near = !full && pct >= 80;
  const color = full ? "#ef4444" : near ? "#f59e0b" : "#22c55e";

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
        <span>{label}</span>
        <span style={{ color: full ? "#ef4444" : "inherit", fontVariantNumeric: "tabular-nums" }}>
          {used} / {limit}
        </span>
      </div>
      <div style={{ height: 8, borderRadius: 999, background: "rgba(127,127,127,.22)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, transition: "width .3s" }} />
      </div>
      {full && (
        <div style={{ fontSize: 12, color: "#ef4444", marginTop: 5 }}>
          Лимит исчерпан — новые действия этого типа отклоняются.
        </div>
      )}
    </div>
  );
}

export default function BillingPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    apiFetch("/api/billing/usage")
      .then((r) => (r.ok ? r.json().then(setData) : Promise.reject(r)))
      .catch(() => setError("Не удалось загрузить данные тарифа."));
  }, []);

  const upgrade = async (plan: string, provider: string) => {
    setError("");
    setBusy(provider);
    try {
      const r = await apiFetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, provider }),
      });
      const d = (await r.json().catch(() => ({}))) as { url?: string; reason?: string };
      if (!r.ok || !d.url) {
        setError(d.reason ?? `Не удалось начать оплату (${r.status}).`);
        return;
      }
      // Hand off to the provider's hosted checkout. `assign` is a method call
      // rather than an assignment to a global, which keeps the
      // react-hooks/immutability rule satisfied while doing the same thing.
      window.location.assign(d.url);
    } catch {
      setError("Сеть недоступна — попробуйте ещё раз.");
    } finally {
      setBusy("");
    }
  };

  if (error && !data) return <div style={{ padding: 24 }}>{error}</div>;
  if (!data) return <div style={{ padding: 24, opacity: 0.7 }}>Загрузка…</div>;

  const { usage, plans, providers, canManageBilling } = data;
  const resets = new Date(usage.periodResetsAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });

  return (
    <div style={{ padding: 24, maxWidth: 940 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 4 }}>Тариф и лимиты</h1>
      <p style={{ opacity: 0.7, fontSize: 14, marginBottom: 22 }}>
        Текущий тариф: <strong>{usage.planTitle}</strong>. Счётчик изменений обнулится {resets}.
      </p>

      {error && (
        <div
          style={{
            border: "1px solid #ef4444",
            background: "rgba(239,68,68,.08)",
            borderRadius: 10,
            padding: "10px 14px",
            fontSize: 13,
            marginBottom: 18,
          }}
        >
          {error}
        </div>
      )}

      <section
        style={{
          border: "1px solid rgba(127,127,127,.28)",
          borderRadius: 12,
          padding: 18,
          marginBottom: 26,
        }}
      >
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Использовано в этом месяце</h2>
        <UsageBar label="Изменения в кабинетах" used={usage.writeActions.used} limit={usage.writeActions.limit} />
        <UsageBar label="Подключённые площадки" used={usage.platforms.used} limit={usage.platforms.limit} />
        <UsageBar label="Участники команды" used={usage.members.used} limit={usage.members.limit} />
        <p style={{ fontSize: 12, opacity: 0.65, marginTop: 12 }}>
          Чтение отчётов и аналитика не расходуют лимит ни на одном тарифе.
        </p>
      </section>

      <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Тарифы</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 16 }}>
        {plans.map((p) => {
          const current = p.id === usage.plan;
          return (
            <div
              key={p.id}
              style={{
                border: current ? "2px solid #22c55e" : "1px solid rgba(127,127,127,.28)",
                borderRadius: 12,
                padding: 18,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <h3 style={{ fontSize: 17, fontWeight: 600 }}>{p.title}</h3>
                {current && (
                  <span style={{ fontSize: 11, color: "#22c55e", border: "1px solid #22c55e", borderRadius: 999, padding: "1px 8px" }}>
                    текущий
                  </span>
                )}
              </div>
              <div style={{ fontSize: 24, fontWeight: 600, margin: "10px 0 2px" }}>{money(p.priceMinor, p.currency)}</div>
              <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 14 }}>{p.priceMinor === 0 ? "навсегда" : "в месяц"}</div>

              <ul style={{ fontSize: 13, lineHeight: 1.9, listStyle: "none", flexGrow: 1 }}>
                <li>
                  {p.maxPlatforms === 1 ? "1 рекламная площадка" : `${p.maxPlatforms} рекламные площадки`}
                </li>
                <li>{p.maxWriteActionsPerMonth.toLocaleString("ru-RU")} изменений в месяц</li>
                <li>{p.maxMembers} участник(ов) команды</li>
                <li style={{ opacity: 0.7 }}>Безлимитные отчёты и аналитика</li>
              </ul>

              {!current && p.priceMinor > 0 && (
                <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                  {providers.length === 0 && (
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Приём платежей не настроен на этом сервере.</div>
                  )}
                  {!canManageBilling && providers.length > 0 && (
                    <div style={{ fontSize: 12, opacity: 0.7 }}>
                      Сменить тариф может владелец или администратор организации.
                    </div>
                  )}
                  {canManageBilling &&
                    providers.map((prov) => (
                      <button
                        key={prov}
                        onClick={() => upgrade(p.id, prov)}
                        disabled={busy !== ""}
                        style={{
                          padding: "9px 14px",
                          borderRadius: 9,
                          border: "1px solid rgba(127,127,127,.35)",
                          background: busy === prov ? "rgba(127,127,127,.2)" : "#22c55e",
                          color: busy === prov ? "inherit" : "#04170a",
                          fontWeight: 600,
                          fontSize: 13,
                          cursor: busy ? "wait" : "pointer",
                        }}
                      >
                        {busy === prov ? "Переход к оплате…" : `Оплатить через ${PROVIDER_LABEL[prov] ?? prov}`}
                      </button>
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
