// scripts/oauth-import.ts — complete the Yandex OAuth flow server-side after
// the user pasted the authorization code (e.g. from the Yandex verification
// code page, when the redirect can't reach this server automatically).
//
// Usage (server environment):
//   YANDEX_OAUTH_CLIENT_ID=... YANDEX_OAUTH_CLIENT_SECRET=... \
//   PUBLIC_URL=https://<host> DATABASE_URL=... ENCRYPTION_KEY=... \
//   npx tsx scripts/oauth-import.ts <authorization_code>
//
// Steps: authorization code → access/refresh token (oauth.yandex.ru/token) →
// encrypted oauth_tokens row (org 1) → account mode = production → read-only
// probe of the REAL Direct API (campaigns.get).
//
// The authorization code is SINGLE-USE and expires in a few minutes —
// request a fresh one if this fails with "invalid_grant".

import { withTenant } from "@/db";
import { setAccountMode } from "@/lib/adapters/oauth-store";
import { yandexExchangeCode } from "@/lib/adapters/yandex-direct/client";
import { DirectApi } from "@/lib/adapters/yandex-direct/api";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts } from "@/db/schema";

const ORG = 1;
const CTX = { orgId: ORG, userId: null, role: "admin" };

const code = process.argv[2];
if (!code) {
  console.error("usage: npx tsx scripts/oauth-import.ts <authorization_code>");
  process.exit(2);
}
if (!process.env.YANDEX_OAUTH_CLIENT_ID || !process.env.YANDEX_OAUTH_CLIENT_SECRET) {
  console.error("YANDEX_OAUTH_CLIENT_ID and YANDEX_OAUTH_CLIENT_SECRET are required");
  process.exit(2);
}

async function main() {
  console.log("agent-Mr · yandex oauth import (org " + ORG + ")");

  // 1. Code → tokens (real oauth.yandex.ru).
  const stored = await withTenant(CTX, async () => yandexExchangeCode(code));
  console.log("  ✅ tokens exchanged and stored encrypted (access expires " + (stored.expiresAt ? stored.expiresAt.toISOString() : "n/a") + ")");

  // 2. Account mode → production (adapters switch to the real API).
  await withTenant(CTX, async () => {
    await setAccountMode("yandex", "production");
    const acc = (await db.select().from(accounts).where(eq(accounts.platform, "yandex")).limit(1))[0];
    console.log("  ✅ yandex account mode = production" + (acc ? ` (${acc.login})` : ""));
  });

  // 3. Read-only probe of the REAL Direct API.
  const api = new DirectApi(async () => stored.accessToken, "https://api.direct.yandex.com/json/v5");
  try {
    const res = (await api.call("campaigns", "get", {
      SelectionCriteria: { States: ["ON", "SUSPENDED"] },
      FieldNames: ["Id", "Name", "State", "Budget"],
      Page: { Limit: 10, Offset: 0 },
    })) as { Campaigns?: Record<string, unknown>[] } | null | undefined;
    if (res == null) {
      console.log("  ⚠️  Direct API returned an empty body (check network egress)");
    } else {
      const camps = res.Campaigns ?? [];
      console.log(`  ✅ REAL Direct API reachable: ${camps.length} campaign(s) (first: ${camps[0]?.Name ?? "—"})`);
    }
    console.log("\nREADY — run: npx tsx scripts/e2e-preflight.ts, then the supervised E2E (docs/YANDEX_E2E.md §4)");
  } catch (e) {
    console.error("  ❌ Direct API probe failed: " + (e as Error).message.split("\n")[0]);
    console.error("     (token stored; check scope 'direct', account access, network egress)");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("oauth import failed:", (e as Error).message.split("\n")[0]);
  process.exit(1);
});
