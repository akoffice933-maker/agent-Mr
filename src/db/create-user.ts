// CLI: create (or update the password of) a user.
//   npm run create-user -- <email> <password> [name]
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { users } from "./schema";
import { hashPassword } from "@/lib/auth/password";

async function main() {
  const [email, password, name] = process.argv.slice(2);
  if (!email || !password) {
    console.error("Usage: npm run create-user -- <email> <password> [name]");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const norm = email.toLowerCase().trim();
  const existing = (await db.select().from(users).where(eq(users.email, norm)))[0];

  if (existing) {
    await db.update(users).set({ passwordHash: hashPassword(password), name: name ?? existing.name, updatedAt: new Date() }).where(eq(users.id, existing.id));
    console.log(`✓ Password updated for ${norm}`);
  } else {
    await db.insert(users).values({ email: norm, passwordHash: hashPassword(password), name: name ?? null });
    console.log(`✓ User created: ${norm}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
