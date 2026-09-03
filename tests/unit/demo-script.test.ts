// Демо-агент на лендинге: содержание сценариев.
//
// Демо — публичное обещание продукта, поэтому тест сторожит не вёрстку, а
// смысл: сценарий с изменением обязан иметь и стоимость, и подтверждение, а
// сценарий чтения — не имитировать подтверждение там, где его нет и в
// настоящем продукте.

import { describe, expect, it } from "vitest";
import { DEMO_SCENARIOS, isReadOnly } from "@/lib/demo-script";
import { ANALYTICS_EVENTS } from "@/lib/analytics-events";

describe("demo script", () => {
  it("сценарии есть и у каждого уникальный id", () => {
    expect(DEMO_SCENARIOS.length).toBeGreaterThanOrEqual(2);
    const ids = DEMO_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("каждый сценарий заполнен целиком", () => {
    for (const s of DEMO_SCENARIOS) {
      expect(s.prompt.length).toBeGreaterThan(10);
      expect(s.chip.length).toBeGreaterThan(0);
      expect(s.intro.length).toBeGreaterThan(10);
      expect(s.rows.length).toBeGreaterThan(0);
      expect(s.impact.length).toBeGreaterThan(0);
      expect(s.budgetNote.length).toBeGreaterThan(0);
      for (const r of s.rows) {
        expect(r.name.length).toBeGreaterThan(0);
        expect(["g", "y", "a"]).toContain(r.platform);
        expect(r.metric.length).toBeGreaterThan(0);
        expect(r.action.length).toBeGreaterThan(0);
      }
    }
  });

  it("изменяющий сценарий показывает результат и запись в журнале", () => {
    const mutating = DEMO_SCENARIOS.filter((s) => !isReadOnly(s));
    expect(mutating.length).toBeGreaterThan(0);
    for (const s of mutating) {
      // Без этого демо покажет кнопку «Подтвердить», которая ведёт в пустоту.
      expect(s.applied.length).toBeGreaterThan(10);
      // Журнал действий — механизм продукта, а не украшение экрана.
      expect(s.audit).toContain("applied");
    }
  });

  it("read-only сценарий не имитирует подтверждение", () => {
    const readOnly = DEMO_SCENARIOS.filter(isReadOnly);
    expect(readOnly.length).toBeGreaterThan(0);
    for (const s of readOnly) {
      expect(s.applied).toBe("");
      expect(s.audit).toBe("");
    }
  });

  it("события демо объявлены в allowlist аналитики", () => {
    // Иначе track() тихо отбросит их: /api/analytics/event принимает только
    // известные имена.
    expect(ANALYTICS_EVENTS).toContain("demo_run");
    expect(ANALYTICS_EVENTS).toContain("demo_confirm");
  });
});
