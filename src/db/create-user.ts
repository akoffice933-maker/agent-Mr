// CLI: create (or update the password of) a user + org membership (Phase C).
//   npm run create-user -- <email> <password> [name]
// The user is added to the default organization (id 1) with role 'admin'.
// Runs against DATABASE_URL (use the privileged DB user for a clean run).
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { organizations, orgMembers, users } from "./schema";
import { hashPassword } from "@/lib/auth/password";

const ROLES = ["owner", "admin", "media_buyer", "analyst", "viewer"] as const;

async function main() {
  const [email, password, name, ...rest] = process.argv.slice(2);
  let role: (typeof ROLES)[number] = "admin";
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--role") role = (rest[++i] ?? "admin") as (typeof ROLES)[number];
  }
  if (!email || !password) {
    console.error("Usage: npm run create-user -- <email> <password> [name] [--role owner|admin|media_buyer|analyst|viewer]");
    process.exit(1);
  }
  if (!ROLES.includes(role)) {
    console.error(`Bad role '${role}' (one of: ${ROLES.join(", ")})`);
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  // ensure default org exists
  let org = (await db.select().from(organizations).limit(1))[0];
  if (!org) {
    org = (await db.insert(organizations).values({ name: "Default" }).returning())[0];
    console.log(`✓ Organization created: Default (id ${org.id})`);
  }

  const norm = email.toLowerCase().trim();
  const existing = (await db.select().from(users).where(eq(users.email, norm)))[0];
  let userId: number;
  if (existing) {
    await db.update(users).set({ passwordHash: hashPassword(password), name: name ?? existing.name, updatedAt: new Date() }).where(eq(users.id, existing.id));
    userId = existing.id;
    console.log(`✓ Password updated for ${norm}`);
  } else {
    const u = (await db.insert(users).values({ email: norm, passwordHash: hashPassword(password), name: name ?? null }).returning())[0];
    userId = u.id;
    console.log(`✓ User created: ${norm} (id ${userId})`);
  }

  // membership in the default org (idempotent)
  const member = (await db.select().from(orgMembers).where(eq(orgMembers.userId, userId)))[0];
  if (!member) {
    await db.insert(orgMembers).values({ orgId: org.id, userId, role });
    console.log(`✓ Membership: org #${org.id} (role ${role})`);
  } else {
    console.log(`✓ Membership already exists (org #${member.orgId})`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
