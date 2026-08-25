// scripts/e2e-preflight.ts — pre-flight check before the FIRST real money
// moves to Yandex Direct (docs/YANDEX_E2E.md §3).
//
// Usage (server environment, where the app runs):
//   DATABASE_URL=... ENCRYPTION_KEY=... npx tsx scripts/e2e-preflight.ts
//
// Checks (read-only — never writes to the provider or the DB):
//   ✅ DB reachable + migrations applied
//   ✅ yandex account mode (sandbox → warning, production → ok)
//   ✅ OAuth token: present + decryptable
//   ✅ OAuth client id/secret configured (needed for token refresh)
//   ✅ safety settings (supervised profile)
//   ✅ LLM key (full ad-tree spec from chat; rule grammar works without it)
//   ✅ network to api.direct.yandex.com:443
//   ✅ REAL Direct API read-only probe (campaigns.get — proves token/scope/contract)
//
// Exit code: 0 = ready (warnings allowed), 1 = blocking problem.

import net from "node:net";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { accounts, oauthTokens, settings } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { DirectApi } from "@/lib/adapters/yandex-direct/api";

const ORG = 1;
const CTX = { orgId: ORG, userId: null, role: "admin" };
let blocking = 0;
const ok = (m: string) => console.log("  ✅ " + m);
const warn = (m: string) => console.log("  ⚠️  " + m);
const bad = (m: string) => {
  blocking++;
  console.log("  ❌ " + m);
};

function tcp(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
  });
}

async function main() {
  console.log("agent-Mr · pre-flight: real Yandex E2E (read-only checks)");

  // 1. Database + migrations.
  let dbOk = false;
  try {
    const rows = await withTenant(CTX, () => db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`));
    const count = (rows as unknown as { rows: { n: number }[] }).rows[0].n;
    dbOk = true;
    if (count >= 5) ok(`DB reachable, ${count} migrations applied`);
    else bad(`only ${count} migrations applied (expected >= 5) — run: npm run migrate`);
  } catch (e) {
    bad("DB unreachable: " + (e as Error).message.split("\n")[0]);
  }
  if (!dbOk) {
    console.log("\nAborting: database required for all remaining checks.");
    process.exit(1);
  }

  // 2. Yandex account.
  const acc = (await withTenant(CTX, () => db.select().from(accounts).where(eq(accounts.platform, "yandex")).limit(1)))[0];
  if (!acc) warn("no yandex account row — it appears after the first OAuth connect");
  else if (acc.mode === "production") ok(`yandex account in PRODUCTION mode (${acc.login})`);
  else warn(`yandex account mode = ${acc.mode} — the OAuth connect sets it to production`);

  // 3. OAuth token.
  const setKey = process.env.ENCRYPTION_KEY;
  if (!setKey) bad("ENCRYPTION_KEY is not set in this environment");
  const tokenRow = (await withTenant(CTX, () => db.select().from(oauthTokens).limit(10))).find((r) => r.platform === "yandex");
  if (!tokenRow) {
    warn("no yandex OAuth token stored — run the OAuth connect first (runbook §2.3)");
  } else if (setKey) {
    try {
      const plain = decrypt(tokenRow.accessToken);
      ok(`yandex token stored and decryptable (expires ${tokenRow.expiresAt ? new Date(tokenRow.expiresAt).toISOString() : "n/a"})`);
      // 7. Network + REAL read-only probe against the production endpoint.
      if (!(await tcp("api.direct.yandex.com", 443))) {
        bad("network: api.direct.yandex.com:443 unreachable");
      } else {
        ok("network: api.direct.yandex.com:443 reachable");
        try {
          const api = new DirectApi(async () => plain, "https://api.direct.yandex.com/json/v5");
          const res = (await api.call("campaigns", "get", {
            SelectionCriteria: { States: ["ON", "SUSPENDED"] },
            FieldNames: ["Id", "Name", "State", "Budget"],
            Page: { Limit: 10, Offset: 0 },
          })) as { Campaigns?: Record<string, unknown>[] } | null | undefined;
          if (res == null) {
            bad("REAL Direct API returned an empty body (possible network egress block or API change)");
          } else {
            const camps = res.Campaigns ?? [];
            ok(`REAL Direct API: token works, ${camps.length} campaign(s) visible (first: ${camps[0]?.Name ?? "—"})`);
          }
        } catch (e) {
          bad("REAL Direct API probe failed: " + (e as Error).message.split("\n")[0] + " (check token scope 'direct', account access, network egress)");
        }
      }
    } catch (e) {
      bad("token decrypt failed: " + (e as Error).message.split("\n")[0]);
    }
  }

  // 4. OAuth client credentials (token refresh depends on them).
  if (process.env.YANDEX_OAUTH_CLIENT_ID && process.env.YANDEX_OAUTH_CLIENT_SECRET) {
    ok("YANDEX_OAUTH_CLIENT_ID/SECRET configured");
  } else {
    warn("YANDEX_OAUTH_CLIENT_ID/SECRET not set — token refresh will fail after expiry");
  }

  // 5. Safety settings (supervised profile, runbook §3).
  const setRows = await withTenant(CTX, () => db.select().from(settings));
  const map = new Map(setRows.map((r) => [r.key, r.value]));
  if (map.get("dry_run") === true) warn("dry_run=true — approved actions will NOT execute (set false for the E2E)");
  else ok("dry_run=false — approved actions will execute");
  if (map.get("read_only") === true) warn("read_only=true — writes disabled (set false for the E2E)");
  else ok("read_only=false — writes enabled");
  ok(`limits: daily ${String(map.get("daily_limit"))} / weekly ${String(map.get("weekly_limit"))} / monthly ${String(map.get("monthly_limit"))} ₽`);

  // 8. LLM (full ad-tree spec from chat).
  if (process.env.OPENROUTER_API_KEY) ok("OPENROUTER_API_KEY set — the LLM fills the full ad-tree spec");
  else warn("no OPENROUTER_API_KEY — use the rule-grammar format (runbook §4); bare creates still work");

  if (blocking === 0) console.log("\n✅ READY (warnings do not block) — proceed with the supervised E2E (runbook §4)");
  else console.log("\n❌ BLOCKING PROBLEMS — fix before the first spend");
  process.exit(blocking === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("preflight crashed:", e);
  process.exit(1);
});
