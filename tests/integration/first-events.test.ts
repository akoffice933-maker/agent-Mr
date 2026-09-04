// События активации first_agent_message / first_approve (ТЗ §9.2).
//
// Метрика отвечает на вопрос «какая доля зарегистрировавшихся дошла до
// первого ответа агента и первого подтверждения». Ключевое слово —
// ПЕРВОГО: если событие запишется дважды, метрика начнёт измерять
// активность вместо активации.
//
// Проверка «уже есть такая строка?» в коде приложения от этого не
// защищает — два одновременных запроса оба увидят пустую таблицу.
// Гарантию даёт частичный уникальный индекс (миграция 0014), и тест
// бьёт именно в него: последовательный повтор и параллельная гонка.

import { beforeAll, describe, expect, it } from "vitest";
import { recordAnalyticsEvent, recordFirstEvent } from "@/lib/analytics-events";
import { identityPool } from "@/lib/tenant/pool";

async function freshOrg(name: string): Promise<number> {
  const r = await identityPool.query<{ id: number }>(
    "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
    [`${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`]
  );
  return r.rows[0].id;
}

async function countOf(event: string, orgId: number): Promise<number> {
  const r = await identityPool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM analytics_events WHERE event = $1 AND org_id = $2",
    [event, orgId]
  );
  return Number(r.rows[0].n);
}

describe("события активации записываются один раз на организацию", () => {
  beforeAll(async () => {
    // Индекс — предмет проверки; без него тесты ниже бессмысленны.
    const r = await identityPool.query(
      "SELECT 1 FROM pg_indexes WHERE tablename = 'analytics_events' AND indexname = 'analytics_events_first_once_idx'"
    );
    expect(r.rowCount, "миграция 0014 не применена").toBe(1);
  });

  it("первый вызов записывает событие и сообщает об этом", async () => {
    const org = await freshOrg("first-msg");
    await expect(recordFirstEvent("first_agent_message", org)).resolves.toBe(true);
    expect(await countOf("first_agent_message", org)).toBe(1);
  });

  it("повторный вызов не создаёт дубль и возвращает false", async () => {
    const org = await freshOrg("repeat");
    expect(await recordFirstEvent("first_approve", org, { tool: "set_campaign_status" })).toBe(true);
    expect(await recordFirstEvent("first_approve", org, { tool: "adjust_bids" })).toBe(false);
    expect(await recordFirstEvent("first_approve", org)).toBe(false);
    expect(await countOf("first_approve", org)).toBe(1);
  });

  it("ПАРАЛЛЕЛЬНЫЕ вызовы: побеждает ровно один, без исключений", async () => {
    const org = await freshOrg("race");
    // Именно этот сценарий не ловится проверкой «select, потом insert».
    const results = await Promise.all(
      Array.from({ length: 8 }, () => recordFirstEvent("first_agent_message", org))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await countOf("first_agent_message", org)).toBe(1);
  });

  it("организации не мешают друг другу", async () => {
    const a = await freshOrg("org-a");
    const b = await freshOrg("org-b");
    expect(await recordFirstEvent("first_approve", a)).toBe(true);
    expect(await recordFirstEvent("first_approve", b)).toBe(true);
    expect(await countOf("first_approve", a)).toBe(1);
    expect(await countOf("first_approve", b)).toBe(1);
  });

  it("разные события одной организации независимы", async () => {
    const org = await freshOrg("both");
    expect(await recordFirstEvent("first_agent_message", org)).toBe(true);
    expect(await recordFirstEvent("first_approve", org)).toBe(true);
    expect(await countOf("first_agent_message", org)).toBe(1);
    expect(await countOf("first_approve", org)).toBe(1);
  });

  it("ограничение НЕ распространяется на обычные события воронки", async () => {
    const org = await freshOrg("plain");
    // landing_view и подобные повторяются сколько угодно раз — частичный
    // индекс не должен их задевать.
    await recordAnalyticsEvent("demo_run", org, { scenario: "audit" });
    await recordAnalyticsEvent("demo_run", org, { scenario: "report" });
    expect(await countOf("demo_run", org)).toBe(2);
  });
});
