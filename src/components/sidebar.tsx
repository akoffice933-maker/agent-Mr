"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { apiFetch } from "@/lib/api-client";

const NAV = [
  { href: "/", label: "Обзор", icon: "grid" },
  { href: "/agent", label: "AI-агент", icon: "bot" },
  { href: "/campaigns", label: "Кампании", icon: "layers" },
  { href: "/analytics", label: "Аналитика", icon: "chart" },
  { href: "/report", label: "Отчёт", icon: "target" },
  { href: "/audit", label: "Журнал аудита", icon: "scroll" },
  { href: "/safety", label: "Безопасность", icon: "shield" },
];

function SafetyStatus() {
  const [status, setStatus] = useState<{ dryRun: boolean; readOnly: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    const load = () =>
      apiFetch("/api/settings")
        .then((r) => r.json())
        .then((s) => active && setStatus({ dryRun: !!s.dryRun, readOnly: !!s.readOnly }))
        .catch(() => undefined);
    load();
    const t = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="rounded-lg border border-line bg-panel2 p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-fog">Safety-слой</span>
        <span className="flex items-center gap-1.5 font-semibold text-good">
          <span className="h-1.5 w-1.5 rounded-full bg-good pulse-soft" />
          активен
        </span>
      </div>
      <div className="mt-2 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-fog">Dry-run</span>
          {status === null ? (
            <span className="text-mist">…</span>
          ) : (
            <span className={status.dryRun ? "font-semibold text-warn" : "text-mist"}>
              {status.dryRun ? "включён" : "выключен"}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-fog">Доступ</span>
          {status === null ? (
            <span className="text-mist">…</span>
          ) : (
            <span className={status.readOnly ? "font-semibold text-bad" : "text-mist"}>
              {status.readOnly ? "только чтение" : "полный"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-line bg-panel lg:flex">
      <div className="flex items-center gap-3 border-b border-line px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-accent-ink">
          <Icon name="zap" className="h-5 w-5" />
        </div>
        <div>
          <div className="font-display text-sm font-bold leading-tight tracking-tight">Unified Ads Agent</div>
          <div className="text-[11px] text-fog">Google · Директ · Авито</div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                active
                  ? "bg-panel3 font-semibold text-snow"
                  : "text-fog hover:bg-panel2 hover:text-mist"
              }`}
            >
              <Icon name={item.icon} className={`h-4 w-4 ${active ? "text-accent" : ""}`} />
              {item.label}
              {item.href === "/agent" && (
                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent pulse-soft" />
              )}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-3 px-4 pb-5">
        <SafetyStatus />
        <div className="px-1 text-[10px] leading-relaxed text-fog">
          Адаптеры: Google Ads API · Direct API v5 · Avito Business API · AI Core: OpenRouter (fallback: rule-based)
        </div>
      </div>
    </aside>
  );
}
