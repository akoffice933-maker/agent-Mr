// Application-level encryption for secrets at rest (OAuth tokens, API keys).
// AES-256-GCM. The interesting part is how the key is derived from ENCRYPTION_KEY.

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";

const ALGO = "aes-256-gcm";

// Ciphertext layout
//   v2 (current): "v2:" + base64( iv(12) | tag(16) | ciphertext )   — key via scrypt
//   v1 (legacy) :        base64( iv(12) | tag(16) | ciphertext )   — key via SHA-256
// The "v2:" marker is unambiguous: base64 never contains ':'.
const V2_PREFIX = "v2:";

const IV_LEN = 12;
const TAG_LEN = 16;

// scrypt parameters. N=2^15 keeps derivation around 50-100 ms on a server CPU —
// negligible once per process, but it multiplies an offline brute-force of a
// weak passphrase by ~5 orders of magnitude compared to a bare SHA-256.
const SCRYPT_N = 32768;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

// A fixed salt, not a random per-record one. Per-record salts would force a
// fresh scrypt derivation on every single decrypt (~100 ms each, and the token
// store decrypts in loops). The salt's job here is domain separation between
// deployments and against precomputed tables for this specific application;
// the per-record uniqueness that matters for AES-GCM comes from the random IV.
const KDF_SALT = Buffer.from("agent-mr/aes-256-gcm/v2");

/**
 * Derive the 32-byte AES key from ENCRYPTION_KEY.
 *
 * Two accepted forms:
 *   * 64 hex chars — treated as a raw 32-byte key and used as-is. It already
 *     has full entropy, so stretching it would only cost time.
 *   * anything else — a passphrase, stretched with scrypt.
 *
 * Review P3: this used to be `sha256(ENCRYPTION_KEY)` unconditionally. SHA-256
 * is a single fast pass, so an attacker holding the database (the exact
 * scenario encryption-at-rest defends against) can try billions of candidate
 * passphrases per second on a GPU. Operators do set ENCRYPTION_KEY by hand,
 * .env.example does not force hex, and only length is validated — so a
 * guessable passphrase is a realistic input. A KDF is the difference between
 * "cracked over lunch" and "not worth attempting".
 */
let cachedKey: Buffer | null = null;
let cachedFrom: string | null = null;

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY env var is required to store OAuth tokens");

  // Derivation is expensive by design, so it is done once per process and
  // re-done only if the env var itself changes (tests swap it around).
  if (cachedKey && cachedFrom === raw) return cachedKey;

  const key = /^[0-9a-fA-F]{64}$/.test(raw.trim())
    ? Buffer.from(raw.trim(), "hex")
    : scryptSync(raw, KDF_SALT, 32, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: SCRYPT_MAXMEM });

  cachedKey = key;
  cachedFrom = raw;
  return key;
}

/** The pre-P3 key derivation, kept solely to read secrets written before the upgrade. */
function getLegacyKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY env var is required to store OAuth tokens");
  return createHash("sha256").update(raw).digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return V2_PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decrypt(stored: string): string {
  const isV2 = stored.startsWith(V2_PREFIX);
  const buf = Buffer.from(isV2 ? stored.slice(V2_PREFIX.length) : stored, "base64");

  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = buf.subarray(IV_LEN + TAG_LEN);

  const decipher = createDecipheriv(ALGO, isV2 ? getKey() : getLegacyKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/**
 * True when `stored` was written with the superseded SHA-256 derivation.
 *
 * Rotation is a re-encrypt: `encrypt(decrypt(value))` upgrades a record in
 * place, and callers can use this to find the ones still worth rewriting.
 */
export function isLegacyCiphertext(stored: string): boolean {
  return !stored.startsWith(V2_PREFIX);
}

/** Constant-time comparison helper for secret material of equal length. */
export function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
