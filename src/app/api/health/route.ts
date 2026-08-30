import { db } from "@/db";
import { sql } from "drizzle-orm";
import { getApiKey, isProductionMode } from "@/lib/auth-policy";

export const dynamic = "force-dynamic";

const startedAt = Date.now();

export async function GET() {
  let dbOk = false;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  // Review P2: this always returned HTTP 200, even with `db: false`. Every
  // orchestrator (k8s probes, ALB/NLB target groups, uptime monitors) decides
  // on the STATUS CODE, so a database outage looked perfectly healthy: no
  // instance was ever restarted or pulled from the load balancer.
  return Response.json(
    {
      ok: dbOk,
      db: dbOk,
      mode: isProductionMode() ? "production" : "development",
      auth: getApiKey() ? "api-key" : "open",
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    },
    {
      status: dbOk ? 200 : 503,
      headers: { "cache-control": "no-store" },
    }
  );
}
