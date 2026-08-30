// Self-serve signup: create a user, their own organization, and an owner
// membership — the three inserts that used to require SSH + `npm run create-user`.
//
// Identity-plane writes go through identityPool (no RLS): the organization
// does not exist yet, so there is no tenant context to run them under.

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { identityPool } from "@/lib/tenant/pool";
import { hashPassword } from "@/lib/auth/password";
import { log } from "@/lib/log";

export const VERIFICATION_TTL_MS = 24 * 3600 * 1000;

/** Signup availability. Controlled by env so a deployment can stay private. */
export type SignupMode = "open" | "code" | "off";

export function signupMode(): SignupMode {
  const raw = (process.env.SIGNUP_MODE ?? "open").trim().toLowerCase();
  return raw === "off" || raw === "code" ? raw : "open";
}

/**
 * Whether an unverified user may use the product.
 *
 * Default: yes (verification is a soft gate). Set SIGNUP_REQUIRE_VERIFIED_EMAIL=on
 * to hard-gate login until the address is confirmed — sensible once SMTP is
 * known to work, hostile before that (nobody could ever log in).
 */
export function requireVerifiedEmail(): boolean {
  return (process.env.SIGNUP_REQUIRE_VERIFIED_EMAIL ?? "").trim().toLowerCase() === "on";
}

/**
 * Normalise an address for storage and comparison.
 *
 * Lowercase + trim only. Deliberately NOT stripping dots or +tags: those rules
 * are provider-specific (Gmail does it, most do not), and applying them
 * globally would merge genuinely different mailboxes into one account.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Deliberately permissive: one @, no spaces, a dot in the domain. Strict
// RFC 5322 regexes reject valid addresses and are a classic source of
// "your email is invalid" support tickets. Real validation is the round-trip.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface Validation {
  ok: boolean;
  error?: string;
}

export function validateEmail(email: string): Validation {
  if (!email) return { ok: false, error: "Укажите email." };
  if (email.length > 254) return { ok: false, error: "Слишком длинный email." };
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Некорректный email." };
  return { ok: true };
}

export function validatePassword(password: string): Validation {
  // Length is the only requirement that reliably correlates with strength.
  // Composition rules ("must contain a digit and a symbol") push people to
  // Password1! and are not enforced here on purpose.
  if (!password) return { ok: false, error: "Укажите пароль." };
  if (password.length < 10) return { ok: false, error: "Пароль должен быть не короче 10 символов." };
  if (password.length > 200) return { ok: false, error: "Пароль слишком длинный (максимум 200 символов)." };
  // scrypt would happily hash a 1 MB password and burn CPU doing it.
  return { ok: true };
}

/** Organization name derived from the email when the user gives none. */
export function defaultOrgName(email: string): string {
  const local = email.split("@")[0] ?? "";
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  const name = cleaned.length >= 2 ? cleaned : email;
  return name.length > 60 ? name.slice(0, 60) : name;
}

export interface SignupResult {
  userId: number;
  orgId: number;
  /** Raw verification token — returned so the caller can email it. Never stored. */
  verificationToken: string;
}

export type SignupOutcome =
  | { ok: true; value: SignupResult }
  | { ok: false; code: "email_taken" | "invalid" | "signup_disabled" | "bad_code"; error: string };

/** Hash used for verification tokens (fast by design: the token is high-entropy). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Create user + organization + owner membership + a verification token.
 *
 * Runs in ONE transaction: a half-created account (a user with no org, or an
 * org with no owner) would be unusable and invisible to every repair path.
 */
export async function registerAccount(input: {
  email: string;
  password: string;
  name?: string;
  orgName?: string;
  inviteCode?: string;
}): Promise<SignupOutcome> {
  const mode = signupMode();
  if (mode === "off") {
    return { ok: false, code: "signup_disabled", error: "Регистрация закрыта. Обратитесь к администратору." };
  }
  if (mode === "code") {
    const expected = process.env.SIGNUP_INVITE_CODE ?? "";
    // Fail closed: mode=code without a configured secret must not accept
    // everyone (an empty expected value would match an empty submission).
    if (!expected.trim()) {
      log.error("signup.code_mode_without_secret", {});
      return { ok: false, code: "signup_disabled", error: "Регистрация временно недоступна." };
    }
    if (!input.inviteCode || !constantTimeEquals(input.inviteCode.trim(), expected.trim())) {
      return { ok: false, code: "bad_code", error: "Неверный код приглашения." };
    }
  }

  const email = normalizeEmail(input.email ?? "");
  const emailCheck = validateEmail(email);
  if (!emailCheck.ok) return { ok: false, code: "invalid", error: emailCheck.error! };
  const pwCheck = validatePassword(input.password ?? "");
  if (!pwCheck.ok) return { ok: false, code: "invalid", error: pwCheck.error! };

  const orgName = (input.orgName ?? "").trim() || defaultOrgName(email);
  const displayName = (input.name ?? "").trim() || null;
  const passwordHash = hashPassword(input.password);

  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);

  const client = await identityPool.connect();
  try {
    await client.query("BEGIN");

    // The unique index on users.email is the real guard here: two concurrent
    // signups for the same address both pass any SELECT check, and exactly one
    // survives the INSERT. ON CONFLICT turns that race into a clean 409.
    const userRes = await client.query<{ id: number }>(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [email, passwordHash, displayName]
    );
    if (userRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: "email_taken", error: "Пользователь с таким email уже существует." };
    }
    const userId = userRes.rows[0].id;

    const orgRes = await client.query<{ id: number }>(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
      [orgName]
    );
    const orgId = orgRes.rows[0].id;

    // The creator owns their organization: 'owner' is the only role that can
    // manage members and billing, and a self-serve org must have exactly one
    // from the start.
    await client.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [orgId, userId]);

    // Every new org starts on the free plan explicitly, so entitlement checks
    // never have to special-case a missing row.
    await client.query(
      `INSERT INTO subscriptions (org_id, plan, status) VALUES ($1, 'free', 'active')
       ON CONFLICT (org_id) DO NOTHING`,
      [orgId]
    );

    await client.query(
      `INSERT INTO email_verifications (user_id, token_hash, expires_at, sent_to) VALUES ($1, $2, $3, $4)`,
      [userId, tokenHash, expiresAt, email]
    );

    await client.query("COMMIT");
    log.info("signup.created", { userId, orgId });
    return { ok: true, value: { userId, orgId, verificationToken: token } };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    // A unique violation that slipped past ON CONFLICT (e.g. the org name
    // index) still reads as "taken" to the user rather than a 500.
    const code = (e as { code?: string }).code;
    if (code === "23505") {
      return { ok: false, code: "email_taken", error: "Пользователь с таким email уже существует." };
    }
    throw e;
  } finally {
    client.release();
  }
}

export type VerifyOutcome =
  | { ok: true; userId: number; alreadyVerified: boolean }
  | { ok: false; code: "invalid" | "expired"; error: string };

/** Consume a verification token and mark the address confirmed. */
export async function verifyEmailToken(token: string): Promise<VerifyOutcome> {
  const raw = (token ?? "").trim();
  if (!raw) return { ok: false, code: "invalid", error: "Токен не указан." };

  const tokenHash = hashToken(raw);
  const client = await identityPool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<{ id: number; user_id: number; expires_at: Date; consumed_at: Date | null }>(
      `SELECT id, user_id, expires_at, consumed_at FROM email_verifications WHERE token_hash = $1 LIMIT 1 FOR UPDATE`,
      [tokenHash]
    );
    const row = res.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      // Same message for "never existed" and "already used": a probing
      // attacker learns nothing about which tokens are real.
      return { ok: false, code: "invalid", error: "Ссылка недействительна или уже использована." };
    }

    const already = await client.query<{ email_verified_at: Date | null }>(
      `SELECT email_verified_at FROM users WHERE id = $1`,
      [row.user_id]
    );
    const alreadyVerified = Boolean(already.rows[0]?.email_verified_at);

    if (row.consumed_at) {
      await client.query("ROLLBACK");
      // Re-clicking the link in an email is normal behaviour, not an error —
      // if the address is already confirmed, report success.
      if (alreadyVerified) return { ok: true, userId: row.user_id, alreadyVerified: true };
      return { ok: false, code: "invalid", error: "Ссылка недействительна или уже использована." };
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await client.query("ROLLBACK");
      return { ok: false, code: "expired", error: "Срок действия ссылки истёк. Запросите письмо повторно." };
    }

    await client.query(`UPDATE email_verifications SET consumed_at = now() WHERE id = $1`, [row.id]);
    await client.query(`UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1`, [row.user_id]);
    await client.query("COMMIT");
    log.info("signup.email_verified", { userId: row.user_id });
    return { ok: true, userId: row.user_id, alreadyVerified };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Issue a fresh verification token, invalidating any outstanding ones. */
export async function issueVerificationToken(userId: number, email: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const client = await identityPool.connect();
  try {
    await client.query("BEGIN");
    // Old links stop working: a resend must not leave several valid tokens
    // scattered across a mailbox.
    await client.query(
      `UPDATE email_verifications SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL`,
      [userId]
    );
    await client.query(
      `INSERT INTO email_verifications (user_id, token_hash, expires_at, sent_to) VALUES ($1, $2, $3, $4)`,
      [userId, hashToken(token), new Date(Date.now() + VERIFICATION_TTL_MS), normalizeEmail(email)]
    );
    await client.query("COMMIT");
    return token;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
