import { describe, expect, it, vi, beforeEach } from "vitest";
import { evaluatePolicy } from "@/lib/agent/policy";
import type { SafetySettings } from "@/lib/agent/safety";

vi.mock("@/lib/agent/safety", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent/safety")>("@/lib/agent/safety");
  return { ...actual, checkBudgetHeadroom: vi.fn() };
});

import { checkBudgetHeadroom } from "@/lib/agent/safety";
const mockHeadroom = checkBudgetHeadroom as unknown as ReturnType<typeof vi.fn>;

const baseRole = "admin" as const;

const base: SafetySettings = {
  dryRun: true,
  readOnly: false,
  dailyLimit: 50000,
  weeklyLimit: 250000,
  monthlyLimit: 900000,
  confirmBudget: true,
};

beforeEach(() => {
  mockHeadroom.mockReset();
  mockHeadroom.mockResolvedValue({ ok: true, spendToday: 1000, spendWeek: 5000, spendMonth: 20000, limit: 50000 });
});

describe("Policy Engine", () => {
  it("read operations pass without restrictions", async () => {
    const d = await evaluatePolicy({ tool: "get_spend_report", isWrite: false, settings: base, role: baseRole });
    expect(d.action).toBe("allow");
  });

  it("read-only mode blocks ALL writes (even with zero cost)", async () => {
    const d = await evaluatePolicy({ tool: "adjust_bids", isWrite: true, settings: { ...base, readOnly: true }, costDaily: 0, role: baseRole });
    expect(d.action).toBe("block");
    if (d.action === "block") expect(d.reason).toContain("только чтение");
  });

  it("writes without extra cost require approval (dry-run preview)", async () => {
    const d = await evaluatePolicy({ tool: "pause_low_ctr_campaigns", isWrite: true, settings: base, role: baseRole, costDaily: 0 });
    expect(d.action).toBe("require_approval");
    if (d.action === "require_approval") expect(d.note).toContain("предпросмотр");
  });

  it("writes that add spend pass limits → require approval", async () => {
    const d = await evaluatePolicy({ tool: "create_campaign", isWrite: true, settings: base, role: baseRole, costDaily: 5000 });
    expect(d.action).toBe("require_approval");
    expect(mockHeadroom).toHaveBeenCalledWith(5000);
  });

  it("blocks writes when the budget limit would be exceeded", async () => {
    mockHeadroom.mockResolvedValue({
      ok: false,
      spendToday: 49000,
      spendWeek: 200000,
      spendMonth: 800000,
      limit: 50000,
      reason: "Дневной лимит 50 000 ₽ будет превышен.",
    });
    const d = await evaluatePolicy({ tool: "create_campaign", isWrite: true, settings: base, role: baseRole, costDaily: 5000 });
    expect(d.action).toBe("block");
    if (d.action === "block") expect(d.reason).toContain("лимит");
  });

  it("approval re-check uses fresh settings (limits evaluated again)", async () => {
    mockHeadroom.mockResolvedValue({
      ok: false,
      spendToday: 52000,
      spendWeek: 240000,
      spendMonth: 850000,
      limit: 50000,
      reason: "Недельный лимит превышен.",
    });
    // same call shape used by resolvePending at approval time
    const d = await evaluatePolicy({ tool: "promote_low_view_listings", isWrite: true, settings: base, role: baseRole, costDaily: 600 });
    expect(d.action).toBe("block");
  });
});
