import { describe, expect, it } from "vitest";
import { fmtMoney, fmtPct, plural, dateNDaysAgo } from "@/lib/format";

describe("format helpers", () => {
  it("fmtMoney formats ru-RU with ₽", () => {
    expect(fmtMoney(1234567).replace(/\u00a0/g, " ")).toBe("1 234 567 ₽");
    expect(fmtMoney(null)).toBe("—");
  });

  it("fmtPct", () => {
    expect(fmtPct(1.234, 2)).toBe("1,23%");
  });

  it("plural russian cases", () => {
    expect(plural(1, "день", "дня", "дней")).toBe("день");
    expect(plural(2, "день", "дня", "дней")).toBe("дня");
    expect(plural(5, "день", "дня", "дней")).toBe("дней");
    expect(plural(11, "день", "дня", "дней")).toBe("дней");
    expect(plural(21, "день", "дня", "дней")).toBe("день");
  });

  it("dateNDaysAgo", () => {
    const d = new Date("2026-08-23T12:00:00Z");
    expect(dateNDaysAgo(3, d)).toBe("2026-08-20");
  });
});
