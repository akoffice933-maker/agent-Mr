// CLI: manage org-scoped machine API keys (Phase C.1 lifecycle).
//   npm run api-keys -- create [name] [--ttl 30d]   create a key (printed once)
//   npm run api-keys -- list                        list keys (prefix, status)
//   npm run api-keys -- revoke <prefix>             revoke by prefix (rotation = create + revoke)
// Run with the privileged DB user (BYPASSRLS): DATABASE_URL=postgresql://dbowner:...
import "dotenv/config";
import { createHash, randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { apiKeys } from "./schema";
import { MACHINE_SCOPES, normalizeScopes } from "@/lib/agent/scopes";

function parseTtl(spec: string | undefined): Date | null {
  if (!spec) return null;
  const m = spec.match(/^(\d+)([hdw])$/);
  if (!m) {
    console.error(`Bad --ttl '${spec}' (use e.g. 12h, 30d, 4w)`);
    process.exit(1);
  }
  const mult = { h: 3600, d: 86400, w: 604800 }[m[2] as "h" | "d" | "w"]!;
  return new Date(Date.now() + Number(m[1]) * mult * 1000);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args: string[] = [];
  let ttl: string | undefined;
  let scopesArg: string | undefined;
  let orgId = 1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--ttl") ttl = rest[++i];
    else if (rest[i] === "--scopes") scopesArg = rest[++i];
    else if (rest[i] === "--org") orgId = Number(rest[++i]);
    else args.push(rest[i]);
  }

  if (cmd === "create") {
    const name = args[0] ?? "machine-key";
    const expiresAt = parseTtl(ttl);
    if (!Number.isInteger(orgId) || orgId < 1) throw new Error("Invalid --org");
    const key = `amr_${randomBytes(32).toString("hex")}`;
    const scopesRaw = scopesArg; // snapshot into a const so TS can narrow it below
    const scopes = scopesRaw == null ? null : normalizeScopes(scopesRaw.split(",").map((x) => x.trim()));
    if (scopesRaw != null && scopes === null) throw new Error("Invalid scopes");
    const requested = scopesRaw == null ? null : scopes!;
    if (scopesRaw != null && requested && requested.length !== scopesRaw.split(",").map((x) => x.trim()).filter(Boolean).length) {
      throw new Error(`Unknown scope. Allowed: ${MACHINE_SCOPES.join(", ")}`);
    }
    await db.insert(apiKeys).values({
      orgId,
      name,
      keyHash: createHash("sha256").update(key).digest("hex"),
      keyPrefix: key.slice(0, 8),
      expiresAt,
      scopes: requested,
    });
    console.log(`✓ API key created (${name}${ttl ? `, expires in ${ttl}` : ", no expiration"}${requested ? `, scopes: ${requested.join(",")}` : ", unrestricted legacy scope"}). Shown once — store it now:`);
    console.log(`  ${key}`);
  } else if (cmd === "list") {
    const rows = await db.select().from(apiKeys).orderBy(apiKeys.id);
    if (!rows.length) {
      console.log("No API keys.");
      return;
    }
    for (const r of rows) {
      const status = r.revokedAt ? "REVOKED" : r.expiresAt && r.expiresAt.getTime() < Date.now() ? "EXPIRED" : "active";
      const last = r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : "never";
      console.log(`  ${r.keyPrefix}…  ${r.name.padEnd(20)} ${status.padEnd(8)} scopes ${r.scopes ? (r.scopes as string[]).join(",") : "*"} last-used ${last}${r.expiresAt ? `  expires ${new Date(r.expiresAt).toISOString()}` : ""}`);
    }
  } else if (cmd === "revoke") {
    const prefix = args[0];
    if (!prefix) {
      console.error("Usage: npm run api-keys -- revoke <prefix>");
      process.exit(1);
    }
    const rows = await db.select().from(apiKeys).where(eq(apiKeys.keyPrefix, prefix));
    if (!rows.length) {
      console.error(`No key with prefix ${prefix}`);
      process.exit(1);
    }
    for (const r of rows) {
      await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, r.id));
    }
    console.log(`✓ Revoked ${rows.length} key(s) with prefix ${prefix}…`);
  } else {
    console.error("Usage: npm run api-keys -- create [name] [--org 1] [--ttl 30d] [--scopes read,campaigns:write] | list | revoke <prefix>");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
