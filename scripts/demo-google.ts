// In-process Google Ads sandbox demo (bypasses the Next.js HTTP layer — the
// sandbox keeps killing background dev servers mid-request; the agent pipeline
// itself is exercised exactly as the routes would).
// Usage: npx tsx scripts/demo-google.ts
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig({ path: ".env" });

const ORG = 1;
const CTX = { orgId: ORG, userId: null, role: "owner" } as const;

async function main() {
  const { withTenant } = await import("@/lib/tenant/pool");
  const { updateSettings } = await import("@/lib/agent/safety");
  const { runAgent, resolvePending } = await import("@/lib/agent/run");

  await withTenant(CTX, async () => {
    const s = await updateSettings({ readOnly: false, dryRun: false });
    console.log("settings:", { readOnly: s.readOnly, dryRun: s.dryRun });
  });

  async function flow(msg: string) {
    await withTenant(CTX, async () => {
      const { agent } = await runAgent(msg, "chat", CTX);
      const pid = agent.meta?.pendingActionId;
      console.log(`\n=== ${msg.slice(0, 55)} (pending#${pid}) ===`);
      console.log("PREVIEW:", agent.content.slice(0, 150));
      const changes = (agent.meta?.result as { changes?: { entity?: string; name?: string; after?: string }[] })?.changes ?? [];
      for (const c of changes.slice(0, 4)) console.log(`  ${c.entity}: ${c.name} → ${c.after ?? ""}`);
      if (pid) {
        const r = await resolvePending(pid, "approve", "chat", CTX);
        console.log("RESULT:", r?.content.slice(0, 190));
      }
    });
  }

  await flow("Поставь на паузу кампанию Google «Поиск — Кухни под заказ Москва»");
  await flow("Повышай ставки на 20% по ключам с конверсиями в Google");
  await flow("Добавь минус-фразы: бесплатно, своими руками — в кампанию «Поиск — Кухни под заказ Москва»");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("demo failed:", e);
  process.exit(1);
});
