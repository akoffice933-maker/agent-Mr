// Self-serve signup: user + own organization + owner membership + free plan,
// created in one transaction.
//
// The high-stakes parts are duplicate prevention (two people must never share
// an account) and tenant separation (a new org must start empty and invisible
// to others).

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { identityPool } from "@/lib/tenant/pool";
import {
  registerAccount,
  verifyEmailToken,
  issueVerificationToken,
  normalizeEmail,
  validatePassword,
  defaultOrgName,
  hashToken,
} from "@/lib/auth/signup";

const dbUrl = process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;
const d = dbUrl ? describe : describe.skip;

const MARKER = "signuptest";
const createdUserIds: number[] = [];
const createdOrgIds: number[] = [];

function uniqueEmail(tag: string): string {
  return `${MARKER}-${tag}-${Math.random().toString(36).slice(2, 10)}@example.com`;
}

async function track(res: { ok: true; value: { userId: number; orgId: number } } | { ok: false }) {
  if (res.ok) {
    createdUserIds.push(res.value.userId);
    createdOrgIds.push(res.value.orgId);
  }
}

beforeEach(() => {
  delete process.env.SIGNUP_MODE;
  delete process.env.SIGNUP_INVITE_CODE;
});

afterAll(async () => {
  if (!dbUrl) return;
  // Order matters: memberships/verifications reference users.
  await identityPool.query("DELETE FROM email_verifications WHERE sent_to LIKE $1", [`${MARKER}-%`]);
  if (createdOrgIds.length) {
    await identityPool.query("DELETE FROM subscriptions WHERE org_id = ANY($1)", [createdOrgIds]);
    await identityPool.query("DELETE FROM org_members WHERE org_id = ANY($1)", [createdOrgIds]);
  }
  if (createdUserIds.length) await identityPool.query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds]);
  if (createdOrgIds.length) await identityPool.query("DELETE FROM organizations WHERE id = ANY($1)", [createdOrgIds]);
});

describe("signup input rules (pure)", () => {
  it("normalises case and whitespace", () => {
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
  });

  it("does NOT strip dots or +tags", () => {
    // Provider-specific aliasing rules; applying them globally would merge
    // genuinely different mailboxes into one account.
    expect(normalizeEmail("first.last+ads@example.com")).toBe("first.last+ads@example.com");
  });

  it("requires a password of at least 10 characters", () => {
    expect(validatePassword("short").ok).toBe(false);
    expect(validatePassword("0123456789").ok).toBe(true);
  });

  it("rejects absurdly long passwords", () => {
    // scrypt would happily burn CPU on a 1 MB input.
    expect(validatePassword("x".repeat(5000)).ok).toBe(false);
  });

  it("derives a readable org name from the email", () => {
    expect(defaultOrgName("ivan.petrov@shop.ru")).toBe("ivan petrov");
  });
});

d("registerAccount", () => {
  it("creates user, organization, owner membership and a free subscription", async () => {
    const email = uniqueEmail("happy");
    const res = await registerAccount({ email, password: "correct horse battery" });
    await track(res);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const { userId, orgId } = res.value;

    const member = await identityPool.query("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2", [
      orgId,
      userId,
    ]);
    // Owner is the only role that can manage members and billing — a self-serve
    // org is useless without one.
    expect((member as { rows: { role: string }[] }).rows[0]?.role).toBe("owner");

    const sub = await identityPool.query("SELECT plan, status FROM subscriptions WHERE org_id = $1", [orgId]);
    expect((sub as { rows: { plan: string; status: string }[] }).rows[0]).toEqual({ plan: "free", status: "active" });
  });

  it("stores the password hashed, never in clear text", async () => {
    const email = uniqueEmail("hash");
    const password = "correct horse battery staple";
    const res = await registerAccount({ email, password });
    await track(res);
    if (!res.ok) return;

    const row = (await identityPool.query("SELECT password_hash FROM users WHERE id = $1", [res.value.userId])) as {
      rows: { password_hash: string }[];
    };
    const stored = row.rows[0].password_hash;
    expect(stored).not.toContain(password);
    expect(stored.startsWith("scrypt$")).toBe(true);
  });

  it("REFUSES a duplicate email", async () => {
    const email = uniqueEmail("dup");
    const first = await registerAccount({ email, password: "correct horse battery" });
    await track(first);
    expect(first.ok).toBe(true);

    const second = await registerAccount({ email, password: "another password entirely" });
    await track(second);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("email_taken");
  });

  it("treats differently-cased emails as the same account", async () => {
    const email = uniqueEmail("case");
    const first = await registerAccount({ email, password: "correct horse battery" });
    await track(first);
    const second = await registerAccount({ email: email.toUpperCase(), password: "correct horse battery" });
    await track(second);
    expect(second.ok).toBe(false);
  });

  it("survives a CONCURRENT duplicate signup (only one wins)", async () => {
    // The dangerous case: two requests race past any SELECT check. Only the
    // unique index can decide, and the loser must get a clean error rather
    // than a 500 or a second account.
    const email = uniqueEmail("race");
    const results = await Promise.all([
      registerAccount({ email, password: "correct horse battery" }),
      registerAccount({ email, password: "correct horse battery" }),
      registerAccount({ email, password: "correct horse battery" }),
    ]);
    for (const r of results) await track(r);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) {
      if (!r.ok) expect(r.code).toBe("email_taken");
    }

    const count = (await identityPool.query("SELECT count(*)::int AS n FROM users WHERE email = $1", [
      normalizeEmail(email),
    ])) as { rows: { n: number }[] };
    expect(count.rows[0].n).toBe(1);
  });

  it("gives each signup its OWN organization", async () => {
    const a = await registerAccount({ email: uniqueEmail("orga"), password: "correct horse battery" });
    const b = await registerAccount({ email: uniqueEmail("orgb"), password: "correct horse battery" });
    await track(a);
    await track(b);
    if (!a.ok || !b.ok) throw new Error("setup failed");

    expect(a.value.orgId).not.toBe(b.value.orgId);

    // Neither user may be a member of the other's organization.
    const cross = (await identityPool.query(
      "SELECT count(*)::int AS n FROM org_members WHERE (org_id = $1 AND user_id = $2) OR (org_id = $3 AND user_id = $4)",
      [a.value.orgId, b.value.userId, b.value.orgId, a.value.userId]
    )) as { rows: { n: number }[] };
    expect(cross.rows[0].n).toBe(0);
  });

  it("rejects a weak password before touching the database", async () => {
    const email = uniqueEmail("weak");
    const res = await registerAccount({ email, password: "123" });
    expect(res.ok).toBe(false);
    const row = (await identityPool.query("SELECT count(*)::int AS n FROM users WHERE email = $1", [
      normalizeEmail(email),
    ])) as { rows: { n: number }[] };
    expect(row.rows[0].n).toBe(0);
  });

  it("honours SIGNUP_MODE=off", async () => {
    process.env.SIGNUP_MODE = "off";
    const res = await registerAccount({ email: uniqueEmail("off"), password: "correct horse battery" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("signup_disabled");
  });

  it("SIGNUP_MODE=code requires the right code and FAILS CLOSED without a secret", async () => {
    process.env.SIGNUP_MODE = "code";
    // No SIGNUP_INVITE_CODE configured: must not accept everyone.
    const noSecret = await registerAccount({ email: uniqueEmail("code1"), password: "correct horse battery" });
    expect(noSecret.ok).toBe(false);

    process.env.SIGNUP_INVITE_CODE = "let-me-in";
    const wrong = await registerAccount({
      email: uniqueEmail("code2"),
      password: "correct horse battery",
      inviteCode: "nope",
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe("bad_code");

    const right = await registerAccount({
      email: uniqueEmail("code3"),
      password: "correct horse battery",
      inviteCode: "let-me-in",
    });
    await track(right);
    expect(right.ok).toBe(true);
  });
});

d("email verification", () => {
  it("stores only the token HASH, never the token", async () => {
    const res = await registerAccount({ email: uniqueEmail("tok"), password: "correct horse battery" });
    await track(res);
    if (!res.ok) return;

    const token = res.value.verificationToken;
    const rows = (await identityPool.query("SELECT token_hash FROM email_verifications WHERE user_id = $1", [
      res.value.userId,
    ])) as { rows: { token_hash: string }[] };
    expect(rows.rows[0].token_hash).toBe(hashToken(token));
    expect(rows.rows[0].token_hash).not.toBe(token);
  });

  it("verifies with a valid token and marks the user verified", async () => {
    const res = await registerAccount({ email: uniqueEmail("verify"), password: "correct horse battery" });
    await track(res);
    if (!res.ok) return;

    const out = await verifyEmailToken(res.value.verificationToken);
    expect(out.ok).toBe(true);

    const u = (await identityPool.query("SELECT email_verified_at FROM users WHERE id = $1", [res.value.userId])) as {
      rows: { email_verified_at: Date | null }[];
    };
    expect(u.rows[0].email_verified_at).not.toBeNull();
  });

  it("is idempotent: clicking the link twice still reports success", async () => {
    const res = await registerAccount({ email: uniqueEmail("twice"), password: "correct horse battery" });
    await track(res);
    if (!res.ok) return;

    await verifyEmailToken(res.value.verificationToken);
    const second = await verifyEmailToken(res.value.verificationToken);
    // Re-clicking an email link is normal behaviour, not an error.
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.alreadyVerified).toBe(true);
  });

  it("rejects an unknown token", async () => {
    const out = await verifyEmailToken("0".repeat(64));
    expect(out.ok).toBe(false);
  });

  it("rejects an EXPIRED token", async () => {
    const res = await registerAccount({ email: uniqueEmail("exp"), password: "correct horse battery" });
    await track(res);
    if (!res.ok) return;

    await identityPool.query("UPDATE email_verifications SET expires_at = now() - interval '1 hour' WHERE user_id = $1", [
      res.value.userId,
    ]);
    const out = await verifyEmailToken(res.value.verificationToken);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("expired");
  });

  it("a re-issued token invalidates the previous one", async () => {
    const email = uniqueEmail("resend");
    const res = await registerAccount({ email, password: "correct horse battery" });
    await track(res);
    if (!res.ok) return;

    const old = res.value.verificationToken;
    const fresh = await issueVerificationToken(res.value.userId, email);

    // Leaving several live links scattered across a mailbox is exactly the
    // kind of thing that turns into an account-takeover report later.
    const oldOut = await verifyEmailToken(old);
    expect(oldOut.ok).toBe(false);
    const newOut = await verifyEmailToken(fresh);
    expect(newOut.ok).toBe(true);
  });
});
