import { describe, expect, it } from "vitest";
import { suggestBudgetShift } from "@/lib/agent/cross-platform-advisor";
import type { PlatformStat } from "@/lib/agent/types";

const stat = (platform: PlatformStat["platform"], cpa: number | null, spend = 10000): PlatformStat => ({
  platform,
  spend,
  impressions: 1000,
  clicks: 100,
  conversions: cpa ? Math.max(1, Math.round(spend / cpa)) : 0,
  ctr: 10,
  cpa,
});

describe("suggestBudgetShift — кросс-платформенный советник", () => {
  it("предлагает перенос бюджета при большом разрыве CPA", () => {
    const s = suggestBudgetShift([stat("google", 3000), stat("yandex", 1000)]);
    expect(s).not.toBeNull();
    expect(s!.from).toBe("google");
    expect(s!.to).toBe("yandex");
    expect(s!.percent).toBe(15);
    expect(s!.insight).toContain("Google Ads");
  });

  it("не предлагает при небольшом разрыве CPA (< 25%)", () => {
    expect(suggestBudgetShift([stat("google", 1100), stat("yandex", 1000)])).toBeNull();
  });

  it("не работает с одной платформой с CPA", () => {
    expect(suggestBudgetShift([stat("google", 3000), stat("avito", null)])).toBeNull();
  });

  it("работает с тремя платформами — перенос от худшей к лучшей", () => {
    const s = suggestBudgetShift([stat("google", 5000), stat("yandex", 2000), stat("avito", 1200)]);
    expect(s!.from).toBe("google");
    expect(s!.to).toBe("avito");
  });

  it("уважает кастомный порог", () => {
    // diff = 100%: threshold 100 → suggestion (>=), threshold 101 → null
    expect(suggestBudgetShift([stat("google", 2000), stat("yandex", 1000)], 101)).toBeNull();
    expect(suggestBudgetShift([stat("google", 2000), stat("yandex", 1000)], 50)).not.toBeNull();
  });
});
