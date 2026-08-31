// RLS security audit (Phase C.1).
//
// Proves, against a live database:
//   1. Every tenant table has RLS enabled + FORCED + a policy.
//   2. Directly-scoped tables: organization_id NOT NULL + FK to organizations.
//   3. No SECURITY DEFINER functions exist (they could bypass the access model).
//   4. api_keys stores only a hash (no raw key column).
//   5. REGRESSION GUARD: any table in schema `public` must be on one of the
//      three known lists — an unknown new table (e.g. `secret_data`) fails the
//      audit, so it cannot silently appear without an isolation decision.
//
// Run:  npm run audit:rls        (DATABASE_URL required)
// Also executed by the integration test when a database is reachable.

export interface RlsAuditReport {
  ok: boolean;
  violations: string[];
  tables: {
    rlsForced: string[]; // direct + derived tables with FORCE RLS
    identity: string[]; // documented exceptions (no RLS by design)
    unknown: string[]; // REGRESSION: unexpected tables
  };
  securityDefinerFunctions: string[];
  apiKeysColumns: string[];
}

// Client-data tables: RLS (FORCE) + organization_id NOT NULL + FK.
export const DIRECT_TENANT_TABLES: string[] = [
  "accounts",
  "campaigns",
  "audit_log",
  "chat_messages",
  "oauth_states",
  "oauth_tokens",
  "pending_actions",
  "recommendations",
  "settings",
];

export const DERIVED_TENANT_TABLES: string[] = ["metrics_daily", "keywords", "negative_keywords", "avito_chats"];

// Documented exceptions: identity/credential plane, resolved by the proxy.
// Identity/credential plane: NO RLS by design (the proxy resolves the tenant
// context from these tables *before* any context exists). org_id invariants
// are still enforced structurally (NOT NULL + FK) via ORG_ID_TABLES.
// email_verifications: keyed by user_id, not org_id — it is consumed BEFORE any
//   tenant context exists (the link is opened from an email, often logged out).
// password_resets: same shape and the same reason — the person following the
//   link cannot log in by definition, so there is no tenant context to run
//   under. Only a hash of the token is stored, it is single-use and expires in
//   an hour (src/lib/auth/reset.ts).
// subscriptions / payment_events: the billing plane. Entitlements are read
//   while resolving what an org may do, and webhooks arrive with no session at
//   all — a provider calling in has no tenant context to run under. Access is
//   confined to src/lib/billing/*, which always filters by an org id derived
//   from the authenticated context or from a signature-verified payload.
export const IDENTITY_TABLES: string[] = [
  "organizations",
  "org_members",
  "api_keys",
  "users",
  "sessions",
  "org_invites",
  "email_verifications",
  "password_resets",
  "subscriptions",
  "payment_events",
];

// Tables whose org column must stay NOT NULL + FK even without RLS.
const ORG_ID_TABLES: { table: string; column: string }[] = [
  ...DIRECT_TENANT_TABLES.map((t) => ({ table: t, column: "organization_id" })),
  { table: "api_keys", column: "org_id" },
  { table: "org_members", column: "org_id" },
  { table: "org_invites", column: "org_id" },
  // Billing rows must stay bound to a real organization: a subscription whose
  // org vanished would keep granting a plan to nobody.
  { table: "subscriptions", column: "org_id" },
];

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export async function runRlsAudit(query: QueryFn): Promise<RlsAuditReport> {
  const violations: string[] = [];

  // 1. All tables in public schema
  const all = (await query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows.map(
    (r) => String(r.tablename)
  );

  const mustHaveRls = [...DIRECT_TENANT_TABLES, ...DERIVED_TENANT_TABLES].filter((t) => all.includes(t));
  const knownIdentity = IDENTITY_TABLES.filter((t) => all.includes(t));
  const protectedSet = new Set([...mustHaveRls, ...knownIdentity]);
  const unknown = all.filter((t) => !protectedSet.has(t));
  if (unknown.length) {
    violations.push(`UNKNOWN TABLES (no isolation decision): ${unknown.join(", ")}`);
  }

  // 2. RLS state per protected table
  const rls = (
    await query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`
    )
  ).rows;
  const rlsMap = new Map(rls.map((r) => [String(r.relname), r]));
  const rlsForced: string[] = [];
  for (const t of mustHaveRls) {
    const row = rlsMap.get(t);
    if (!row) {
      violations.push(`TABLE ${t}: missing entirely`);
      continue;
    }
    if (row.relrowsecurity !== true || row.relforcerowsecurity !== true) {
      violations.push(`TABLE ${t}: RLS not enabled+FORCED (enabled=${row.relrowsecurity}, force=${row.relforcerowsecurity})`);
    } else {
      rlsForced.push(t);
      const pol = (
        await query(`SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`, [t])
      ).rows;
      if (pol.length === 0) violations.push(`TABLE ${t}: no RLS policy defined`);
    }
  }
  // Identity tables must NOT have RLS (documented design) — if someone adds it, review.
  for (const t of knownIdentity) {
    const row = rlsMap.get(t);
    if (row && row.relrowsecurity === true) {
      violations.push(`TABLE ${t}: RLS enabled on an identity-plane table — review the design decision`);
    }
  }

  // 3. organization_id/org_id NOT NULL on every table in ORG_ID_TABLES — driven
  // by that array (not a separately hand-maintained list) so a new identity-
  // plane table can't silently skip this check, as oauth_states/org_invites
  // both did before being wired into ORG_ID_TABLES.
  const orgIdTablesPresent = ORG_ID_TABLES.filter((t) => all.includes(t.table));
  const notNullCheck = orgIdTablesPresent.length
    ? (
        await query(
          `SELECT table_name, column_name, is_nullable
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND (table_name, column_name) IN (${orgIdTablesPresent.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ")})`,
          orgIdTablesPresent.flatMap((t) => [t.table, t.column])
        )
      ).rows
    : [];
  const nnMap = new Map(
    notNullCheck.map((r) => [`${r.table_name}.${r.column_name}`, r.is_nullable === "NO"])
  );
  for (const { table, column } of ORG_ID_TABLES) {
    if (all.includes(table) && nnMap.get(`${table}.${column}`) !== true) {
      violations.push(`TABLE ${table}: column ${column} must be NOT NULL (tenant invariant)`);
    }
  }
  const fks = (
    await query(
      `SELECT tc.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`
    )
  ).rows;
  const fkSet = new Set(fks.map((r) => `${r.table_name}.${r.column_name}`));
  for (const { table, column } of ORG_ID_TABLES) {
    if (!all.includes(table)) continue;
    if (!fkSet.has(`${table}.${column}`)) violations.push(`TABLE ${table}: FK ${column} → organizations missing`);
  }

  // 4. No SECURITY DEFINER functions
  const definer = (
    await query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef = true`
    )
  ).rows;
  const securityDefinerFunctions = definer.map((r) => String(r.proname));
  if (securityDefinerFunctions.length) {
    violations.push(`SECURITY DEFINER functions exist (potential access-model bypass): ${securityDefinerFunctions.join(", ")}`);
  }

  // 5. api_keys: hash only, no raw key column
  const akCols = (
    await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'api_keys' AND table_schema = 'public'`)
  ).rows.map((r) => String(r.column_name));
  if (all.includes("api_keys")) {
    if (!akCols.includes("key_hash")) violations.push("api_keys: key_hash column missing");
    if (akCols.some((c) => /(^key$|raw_key|key_value|secret_key$)/i.test(c))) {
      violations.push(`api_keys: raw key column detected (${akCols.filter((c) => /(^key$|raw_key|key_value|secret_key$)/i.test(c)).join(", ")})`);
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    tables: { rlsForced, identity: knownIdentity, unknown },
    securityDefinerFunctions,
    apiKeysColumns: akCols,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].includes("rls-audit")) {
  import("dotenv/config")
    .catch(() => undefined)
    .then(async () => {
      const url = process.env.DATABASE_URL;
      if (!url) {
        console.error("DATABASE_URL is required");
        process.exit(2);
      }
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: url });
      const query: QueryFn = (sql, params) => pool.query(sql, params as unknown[]).then((r) => ({ rows: r.rows }));
      try {
        const report = await runRlsAudit(query);
        console.log(report.ok ? "✓ RLS AUDIT PASSED" : "✗ RLS AUDIT FAILED");
        console.log(`  RLS FORCED: ${report.tables.rlsForced.length} tables`);
        console.log(`  identity (no RLS by design): ${report.tables.identity.join(", ")}`);
        for (const v of report.violations) console.log("  VIOLATION: " + v);
        await pool.end();
        process.exit(report.ok ? 0 : 1);
      } finally {
        await pool.end().catch(() => undefined);
      }
    });
}
