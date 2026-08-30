// Tenant-aware database access (Phase C — Tenant Isolation).
//
// How isolation is guaranteed:
//   1. Postgres RLS (FORCE) on every client-data table — the database itself
//      filters by `app.org_id` (see drizzle/0001_tenant_isolation.sql).
//   2. This module binds `app.org_id` to ONE pinned connection per tenant
//      context (AsyncLocalStorage). Every drizzle query in the request is
//      routed to that connection — so set_config and the data query can never
//      land on different pooled clients.
//   3. Fail-closed: code that runs WITHOUT a context issues queries on plain
//      pooled connections where `app.org_id` is empty → RLS matches nothing
//      → 0 rows. A bug that forgets the context loses data, never leaks it.
//
// Usage (routes):   await withTenantRequest(req, async (ctx) => { ... });
// Usage (pages):    await withTenantHeaders(await headers(), async (ctx) => { ... });

import { AsyncLocalStorage } from "async_hooks";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { isProductionMode } from "@/lib/auth-policy";

// Test hook: integration tests run against DATABASE_TEST_URL (the plain
// DATABASE_URL in unit tests is a dummy for module loading only).
const databaseUrl = process.env.DATABASE_TEST_URL || process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

/**
 * Connection pool sizing (review P2).
 *
 * `new Pool({connectionString})` alone means node-pg's default of max=10 and no
 * timeouts. That matters here because withTenant() PINS one connection for the
 * whole request (see below), and an agent request can sit inside an LLM call
 * for tens of seconds — so 10 concurrent chats exhausted the pool and every
 * further request queued indefinitely with no error to explain why.
 *
 * Explicit limits make the failure mode loud and bounded instead:
 *   * max                     — cap per instance; keep replicas x max under the
 *                               server's max_connections;
 *   * connectionTimeoutMillis — waiting for a free connection fails fast rather
 *                               than hanging the request forever;
 *   * idleTimeoutMillis       — release idle connections back to the server;
 *   * statement_timeout       — server-side ceiling so one pathological query
 *                               cannot pin a connection indefinitely.
 */
const poolMax = Number(process.env.DB_POOL_MAX ?? 10);
const rawPool = new Pool({
  connectionString: databaseUrl,
  max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 10,
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5_000),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS ?? 30_000),
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 30_000),
});

// A pool error (server restart, idle connection killed by the network) is
// emitted on the Pool itself; without a listener Node treats it as an unhandled
// 'error' event and crashes the process.
rawPool.on("error", (err) => {
  console.error("[db] idle client error:", err.message);
});

export interface TenantContext {
  orgId: number;
  userId: number | null;
  role: string;
  scopes?: string[] | null;
}

interface Store extends TenantContext {
  __client: PoolClientLike;
  __queue: Promise<unknown>;
}

// Minimal structural type so we don't import pg's PoolClient here.
interface PoolClientLike {
  query(text: string, values?: unknown[]): Promise<unknown>;
  release(): void;
}

const als = new AsyncLocalStorage<Store>();

export function currentTenant(): TenantContext | null {
  const s = als.getStore();
  return s ? { orgId: s.orgId, userId: s.userId, role: s.role, scopes: s.scopes } : null;
}

/**
 * Tenant org id with the project's fail-closed invariant made explicit (review
 * L3, decision: fail-closed in production).
 *
 * The old pattern `tenantOrgId()` silently fell back to org 1
 * whenever the tenant context was lost — a data-leak-across-tenants smell in a
 * multi-tenant SaaS, and a contradiction of the documented "without a context
 * → 0 rows" fail-closed design. In production we now THROW instead of guessing
 * org 1. In dev/sandbox (auth off, single default tenant) the fallback stays so
 * the demo keeps working.
 */
export function tenantOrgId(): number {
  const org = currentTenant()?.orgId;
  if (org != null && org > 0) return org;
  if (isProductionMode()) {
    throw new Error("Tenant context missing (orgId) in production — refusing to fall back to org 1");
  }
  return 1;
}

function contextClient(): PoolClientLike | null {
  return als.getStore()?.__client ?? null;
}

// Proxy over the raw pool: when a tenant context is active, all queries and
// transaction connections are routed to the context's pinned client.
const tenantPool: Pool = new Proxy(rawPool, {
  get(target, prop) {
    const value = (target as unknown as Record<string | symbol, unknown>)[prop];
    if (prop === "query") {
      return function proxiedQuery(a: unknown, b?: unknown) {
        const store = als.getStore();
        if (store) {
          // Serialize: one pinned connection per request — concurrent drizzle
          // calls (Promise.all in a route) must not interleave on it.
          const prev = store.__queue;
          const next = prev.then(() =>
            (store.__client as unknown as { query: (...x: unknown[]) => Promise<unknown> }).query(a, b)
          );
          store.__queue = next.catch(() => undefined);
          return next;
        }
        return (target as unknown as { query: (...x: unknown[]) => Promise<unknown> }).query(a, b);
      };
    }
    if (prop === "connect") {
      return async function proxiedConnect() {
        const c = contextClient();
        return (c ?? (await (target as Pool).connect())) as never;
      };
    }
    return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
  },
}) as Pool;

export const db = drizzle(tenantPool);

// Identity-plane pool (organizations/users/sessions/api_keys/org_members -
// no RLS by design: the proxy resolves the tenant FROM these tables before
// any tenant context exists).
// SECURITY: never use this pool for tenant data - queries here run without
// a tenant context and bypass RLS. Tenant queries go through `db`.
export const identityPool = rawPool;

/**
 * Run `fn` inside a tenant: pins ONE connection, opens a transaction, and
 * binds the tenant context with `SET LOCAL app.org_id` (transaction-scoped).
 *
 * Why transaction-scoped (not session-level set_config):
 *   - the context is impossible to leave behind: it vanishes with COMMIT/
 *     ROLLBACK, so a pooled connection is clean by construction;
 *   - a raw `set_config` misuse outside this function can at worst shadow
 *     the value inside no transaction — app queries always run inside one.
 *
 * All drizzle queries of the request are routed to this connection (proxy),
 * so they execute inside the tenant transaction.
 */
export async function withTenant<T>(ctx: TenantContext, fn: (ctx: TenantContext) => Promise<T>): Promise<T> {
  const client = (await rawPool.connect()) as unknown as {
    query: (sql: string, values?: unknown[]) => Promise<unknown>;
    release: () => void;
  };
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id', $1, true)", [String(ctx.orgId)]);
    const store: Store = {
      orgId: ctx.orgId,
      userId: ctx.userId,
      role: ctx.role,
      scopes: ctx.scopes ?? null,
      __client: client as PoolClientLike,
      __queue: Promise.resolve(),
    };
    // IMPORTANT: the fn's result is consumed INSIDE the als.run callback (via
    // the async wrapper). Drizzle queries are thenables: the actual pg query
    // is dispatched when the thenable is consumed (.then), not when it is
    // built. If a callback returns a query without awaiting it internally
    // (e.g. `() => db.select()...`), consumption would happen in this
    // function's frame — OUTSIDE the ALS context — and the pool proxy would
    // silently fall back to a plain pooled connection (no tenant, RLS 0 rows).
    // The wrapper makes withTenant safe for both sync and async callbacks.
    const result = await als.run(store, async () => await fn(ctx));
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
