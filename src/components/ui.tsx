import type { ReactNode } from "react";
import type { Platform } from "@/lib/agent/types";
import { PLATFORM_LABEL } from "@/lib/agent/types";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-line bg-panel ${className}`}>{children}</div>;
}

export function SectionTitle({
  title,
  sub,
  right,
}: {
  title: string;
  sub?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-xl font-bold tracking-tight sm:text-2xl">{title}</h1>
        {sub ? <p className="mt-1 text-sm text-fog">{sub}</p> : null}
      </div>
      {right}
    </div>
  );
}

const PLATFORM_COLORS: Record<Platform, string> = {
  google: "text-google",
  yandex: "text-yandex",
  avito: "text-avito",
};

const PLATFORM_DOTS: Record<Platform, string> = {
  google: "bg-google",
  yandex: "bg-yandex",
  avito: "bg-avito",
};

export function platformDot(p: Platform): string {
  return PLATFORM_DOTS[p];
}

export function PlatformBadge({ p, small = false }: { p: Platform; small?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border border-line bg-panel2 font-medium text-mist ${
        small ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-xs"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${PLATFORM_DOTS[p]}`} />
      {PLATFORM_LABEL[p]}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    active: { label: "Активна", cls: "text-good border-good/30 bg-good/10" },
    paused: { label: "Пауза", cls: "text-warn border-warn/30 bg-warn/10" },
    new: { label: "Новый", cls: "text-google border-google/30 bg-google/10" },
    consult: { label: "Консультация", cls: "text-mist border-line2 bg-panel2" },
    lead: { label: "Лид", cls: "text-good border-good/30 bg-good/10" },
    closed: { label: "Закрыт", cls: "text-fog border-line bg-panel2" },
    open: { label: "Открыта", cls: "text-accent border-accent/30 bg-accent/10" },
    applied: { label: "Применена", cls: "text-good border-good/30 bg-good/10" },
    boost7: { label: "Продвигается", cls: "text-accent border-accent/30 bg-accent/10" },
    turbo: { label: "Турбо", cls: "text-yandex border-yandex/30 bg-yandex/10" },
    none: { label: "Без продвижения", cls: "text-fog border-line bg-panel2" },
  };
  const s = map[status] ?? { label: status, cls: "text-fog border-line bg-panel2" };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}>
      {s.label}
    </span>
  );
}

export function AuditStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    ok: { label: "выполнено", cls: "text-good border-good/30 bg-good/10" },
    applied: { label: "применено", cls: "text-good border-good/30 bg-good/10" },
    dry_run: { label: "dry-run", cls: "text-warn border-warn/30 bg-warn/10" },
    pending: { label: "ожидает", cls: "text-google border-google/30 bg-google/10" },
    blocked: { label: "заблокировано", cls: "text-bad border-bad/30 bg-bad/10" },
    rejected: { label: "отклонено", cls: "text-fog border-line bg-panel2" },
  };
  const s = map[status] ?? { label: status, cls: "text-fog border-line bg-panel2" };
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${s.cls}`}>
      {s.label}
    </span>
  );
}

export function Delta({ value, invert = false }: { value: number; invert?: boolean }) {
  const good = invert ? value <= 0 : value >= 0;
  return (
    <span className={`num text-xs font-semibold ${good ? "text-good" : "text-bad"}`}>
      {value >= 0 ? "▲" : "▼"} {Math.abs(value).toFixed(1)}%
    </span>
  );
}

export function Sparkline({
  values,
  color = "#c6f052",
  width = 120,
  height = 32,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const span = Math.max(max - min, 1);
  const pts = values.map((v, idx) => {
    const x = (idx / (values.length - 1)) * (width - 2) + 1;
    const y = height - 3 - ((v - min) / span) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1].split(",")[0]} cy={pts[pts.length - 1].split(",")[1]} r="2.2" fill={color} />
    </svg>
  );
}

export interface StackedDay {
  label: string;
  values: number[]; // [google, yandex, avito]
}

const STACK_COLORS = ["#6aa6f5", "#fb5a3c", "#47d185"];

export function StackedBars({
  days,
  height = 180,
}: {
  days: StackedDay[];
  height?: number;
}) {
  const totals = days.map((d) => d.values.reduce((a, b) => a + b, 0));
  const max = Math.max(...totals, 1);
  return (
    <div>
      <div className="flex items-end gap-[3px]" style={{ height }}>
        {days.map((d, i) => {
          const total = totals[i];
          const hFull = Math.max((total / max) * (height - 18), total > 0 ? 4 : 2);
          let acc = 0;
          return (
            <div key={i} className="group relative flex flex-1 flex-col justify-end" style={{ height: "100%" }}>
              <div
                className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-panel3 px-2 py-1 text-[10px] text-mist group-hover:block"
              >
                {d.label} · {Math.round(total).toLocaleString("ru-RU")} ₽
              </div>
              <div className="flex w-full flex-col-reverse overflow-hidden rounded-[3px]" style={{ height: hFull }}>
                {d.values.map((v, pi) => {
                  const seg = total > 0 ? (v / total) * hFull : 0;
                  acc += v;
                  return <div key={pi} style={{ height: seg, background: STACK_COLORS[pi] }} />;
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-fog">
        <span>{days[0]?.label}</span>
        <span>{days[Math.floor(days.length / 2)]?.label}</span>
        <span>{days[days.length - 1]?.label}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-mist">
        {["Google Ads", "Яндекс.Директ", "Авито"].map((l, i) => (
          <span key={l} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: STACK_COLORS[i] }} />
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}

export function HBar({
  label,
  value,
  max,
  color,
  suffix,
}: {
  label: ReactNode;
  value: number;
  max: number;
  color: string;
  suffix?: string;
}) {
  const w = max > 0 ? Math.max((value / max) * 100, 2) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-36 shrink-0">{label}</div>
      <div className="h-5 flex-1 overflow-hidden rounded-md bg-panel3">
        <div className="h-full rounded-md" style={{ width: `${w}%`, background: color, opacity: 0.85 }} />
      </div>
      <div className="num w-24 shrink-0 text-right text-sm font-semibold text-snow">
        {suffix ?? Math.round(value).toLocaleString("ru-RU")}
      </div>
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  icon?: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between text-fog">
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
        {icon ? <span className="text-fog/70">{icon}</span> : null}
      </div>
      <div className="num mt-2 font-display text-2xl font-bold tracking-tight text-snow">{value}</div>
      {sub ? <div className="mt-1.5 flex items-center gap-2 text-xs text-fog">{sub}</div> : null}
    </Card>
  );
}
