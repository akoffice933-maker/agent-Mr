// Регрессионный тест ТЗ §8.4 / п. 10.8 ревью: лендинг и /api/public/plans
// обязаны читать одни и те же цифры из PLANS, а не два независимо
// написанных списка, которые могут разойтись при следующем изменении тарифа.
import { describe, expect, it } from "vitest";
import { PLANS } from "@/lib/billing/plans";
import { GET } from "@/app/api/public/plans/route";

describe("public plans endpoint matches PLANS (source of truth)", () => {
  it("returns every plan with values equal to lib/billing/plans.ts", async () => {
    const res = await GET();
    const body = (await res.json()) as {
      plans: { id: string; price: number; priceMinor: number; currency: string; limits: Record<string, unknown> }[];
    };

    const byId = new Map(body.plans.map((p) => [p.id, p]));
    expect(byId.size).toBe(Object.keys(PLANS).length);

    for (const plan of Object.values(PLANS)) {
      const served = byId.get(plan.id);
      expect(served, `plan ${plan.id} missing from /api/public/plans`).toBeTruthy();
      expect(served!.priceMinor).toBe(plan.priceMinor);
      expect(served!.price).toBe(plan.priceMinor / 100);
      expect(served!.currency).toBe(plan.currency);
      expect(served!.limits.platforms).toBe(plan.maxPlatforms);
      expect(served!.limits.writeActionsPerMonth).toBe(plan.maxWriteActionsPerMonth);
      expect(served!.limits.members).toBe(plan.maxMembers);
    }
  });
});
