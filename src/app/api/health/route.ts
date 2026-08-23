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
  return Response.json({
    ok: dbOk,
    db: dbOk,
    mode: isProductionMode() ? "production" : "development",
    auth: getApiKey() ? "api-key" : "open",
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  });
}
