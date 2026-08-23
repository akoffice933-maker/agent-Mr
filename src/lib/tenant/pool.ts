// Tenant-aware database access (Phase C — Tenant Isolation).
//
// How isolation is guaranteed:
//   1. Postgres RLS (FORCE) on every client-data table — the database itself
//      filters by `app.org_id` (see drizzle/0004_tenant_isolation.sql).
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

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const rawPool = new Pool({ connectionString: databaseUrl });

export interface TenantContext {
  orgId: number;
  userId: number | null;
  role: string;
}

interface Store extends TenantContext {
  __client: PoolClientLike;
}

// Minimal structural type so we don't import pg's PoolClient here.
interface PoolClientLike {
  query(text: string, values?: unknown[]): Promise<unknown>;
  release(): void;
}

const als = new AsyncLocalStorage<Store>();

export function currentTenant(): TenantContext | null {
  const s = als.getStore();
  return s ? { orgId: s.orgId, userId: s.userId, role: s.role } : null;
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
        const c = contextClient();
        if (c) return (c as unknown as { query: (...x: unknown[]) => Promise<unknown> }).query(a, b);
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

export const rawDbPool = rawPool; // for identity-plane queries (no RLS concern)

/**
 * Run `fn` inside a tenant: pins one connection, sets app.org_id, and routes
 * all drizzle queries of the request to it. Always releases + resets on exit.
 */
export async function withTenant<T>(ctx: TenantContext, fn: (ctx: TenantContext) => Promise<T>): Promise<T> {
  const client = (await rawPool.connect()) as PoolClientLike;
  try {
    await client.query("SELECT set_config('app.org_id', $1, false)", [String(ctx.orgId)]);
    const store: Store = { orgId: ctx.orgId, userId: ctx.userId, role: ctx.role, __client: client };
    return await als.run(store, () => fn(ctx));
  } finally {
    try {
      await client.query("SELECT set_config('app.org_id', '', false)");
    } catch {
      /* connection already broken */
    }
    client.release();
  }
}
