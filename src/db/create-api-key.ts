// CLI: create an org-scoped machine API key for MCP / Telegram / scripts.
//   npm run create-api-key -- [name]
// The key is printed ONCE — store it in the client's env (AGENT_API_KEY there).
import "dotenv/config";
import { createHash, randomBytes } from "crypto";
import { db } from "./index";
import { apiKeys, organizations } from "./schema";

async function main() {
  const name = process.argv[2] ?? "machine-key";
  const org = (await db.select().from(organizations).limit(1))[0];
  if (!org) {
    console.error("No organizations found — run drizzle migrations (0004 creates the default org).");
    process.exit(1);
  }
  const key = `amr_${randomBytes(32).toString("hex")}`;
  await db.insert(apiKeys).values({
    orgId: org.id,
    name,
    keyHash: createHash("sha256").update(key).digest("hex"),
    keyPrefix: key.slice(0, 8),
  });
  console.log(`✓ API key for org #${org.id} (${name}) — shown once, store it now:`);
  console.log(`  ${key}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
