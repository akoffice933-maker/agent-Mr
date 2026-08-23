import { desc, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { AuditStatusBadge, Card, SectionTitle } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

const ACTOR_LABEL: Record<string, string> = {
  chat: "AI-агент (чат)",
  ui: "Пользователь (веб-интерфейс)",
  system: "Система (планировщик)",
};

export default async function AuditPage() {
  const [rows, counts] = await Promise.all([
    db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(200),
    db
      .select({
        total: sql<number>`count(*)::int`,
        blocked: sql<number>`count(*) filter (where ${auditLog.status} = 'blocked')::int`,
        applied: sql<number>`count(*) filter (where ${auditLog.status} = 'applied')::int`,
        dryRun: sql<number>`count(*) filter (where ${auditLog.dryRun})::int`,
      })
      .from(auditLog),
  ]);

  const c = counts[0] ?? { total: 0, blocked: 0, applied: 0, dryRun: 0 };

  return (
    <div className="rise-in">
      <SectionTitle
        title="Журнал аудита"
        sub="Полная история действий агента и пользователей: кто, что, когда, с какими параметрами и каким результатом (включая dry-run и блокировки)"
      />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: "Всего записей", value: Number(c.total) },
          { label: "Применено изменений", value: Number(c.applied) },
          { label: "Dry-run предпросмотров", value: Number(c.dryRun) },
          { label: "Заблокировано политикой", value: Number(c.blocked) },
        ].map((s) => (
          <Card key={s.label} className="p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-fog">{s.label}</div>
            <div className="num mt-1 font-display text-2xl font-bold">{s.value}</div>
          </Card>
        ))}
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-fog">
              <th className="border-b border-line px-4 py-2.5">Время</th>
              <th className="border-b border-line px-4 py-2.5">Инициатор</th>
              <th className="border-b border-line px-4 py-2.5">Инструмент</th>
              <th className="border-b border-line px-4 py-2.5">Итог</th>
              <th className="border-b border-line px-4 py-2.5">Платформы</th>
              <th className="border-b border-line px-4 py-2.5">Статус</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="align-top hover:bg-panel2/50">
                <td className="num whitespace-nowrap border-b border-line/50 px-4 py-2.5 text-[11px] text-fog">{fmtDateTime(r.ts)}</td>
                <td className="whitespace-nowrap border-b border-line/50 px-4 py-2.5 text-xs text-mist">{ACTOR_LABEL[r.actor] ?? r.actor}</td>
                <td className="border-b border-line/50 px-4 py-2.5">
                  <code className="rounded bg-panel3 px-1.5 py-0.5 text-[11px] text-accent">{r.tool}</code>
                </td>
                <td className="max-w-md border-b border-line/50 px-4 py-2.5 text-xs text-mist">{r.summary}</td>
                <td className="whitespace-nowrap border-b border-line/50 px-4 py-2.5 text-[11px] text-fog">
                  {r.platforms ? r.platforms.split(",").join(" · ") : "—"}
                </td>
                <td className="border-b border-line/50 px-4 py-2.5">
                  <AuditStatusBadge status={r.status} />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-fog">
                  Журнал пуст.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
