import { beforeAll, describe, expect, it } from "vitest";
import { createCipheriv, createHash, randomBytes } from "crypto";
import { decrypt, encrypt, isLegacyCiphertext, secretsEqual } from "@/lib/crypto";

const KEY = "test-encryption-key-0123456789abcdef";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = KEY;
});

/** Reproduces the pre-P3 format exactly: SHA-256 key, no version prefix. */
function encryptLegacy(plain: string, passphrase = KEY): string {
  const key = createHash("sha256").update(passphrase).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

describe("AES-256-GCM encryption for OAuth tokens", () => {
  it("encrypt/decrypt roundtrip", () => {
    const secret = "ya29.test-refresh-token-🔑";
    const enc = encrypt(secret);
    expect(enc).not.toContain(secret);
    expect(decrypt(enc)).toBe(secret);
  });

  it("ciphertext differs per encryption (random IV)", () => {
    const a = encrypt("same-secret");
    const b = encrypt("same-secret");
    expect(a).not.toBe(b);
    expect(decrypt(b)).toBe("same-secret");
  });

  it("tampered ciphertext fails auth", () => {
    const enc = encrypt("secret-value");
    const body = Buffer.from(enc.slice("v2:".length), "base64");
    body[body.length - 1] ^= 0xff;
    expect(() => decrypt("v2:" + body.toString("base64"))).toThrow();
  });
});

describe("key derivation upgraded from SHA-256 to scrypt (review P3)", () => {
  it("new ciphertexts are marked v2", () => {
    expect(encrypt("x").startsWith("v2:")).toBe(true);
    expect(isLegacyCiphertext(encrypt("x"))).toBe(false);
  });

  it("STILL decrypts secrets written by the old SHA-256 build", () => {
    // The upgrade must not brick OAuth tokens already sitting in the database:
    // losing them silently logs every connected account out of every platform.
    const legacy = encryptLegacy("ya29.token-from-before-the-upgrade");
    expect(isLegacyCiphertext(legacy)).toBe(true);
    expect(decrypt(legacy)).toBe("ya29.token-from-before-the-upgrade");
  });

  it("re-encrypting a legacy value upgrades it in place", () => {
    const legacy = encryptLegacy("rotate-me");
    const upgraded = encrypt(decrypt(legacy));
    expect(isLegacyCiphertext(upgraded)).toBe(false);
    expect(decrypt(upgraded)).toBe("rotate-me");
  });

  it("does NOT derive the same key as the old scheme", () => {
    // If scrypt were skipped, a v2 payload would decrypt under the SHA-256 key.
    const enc = encrypt("canary");
    const body = enc.slice("v2:".length);
    expect(() => decrypt(body)).toThrow(); // no prefix => tried as legacy => must fail
  });

  it("accepts a 64-char hex key as raw bytes", () => {
    const prev = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    try {
      expect(decrypt(encrypt("hex-key-secret"))).toBe("hex-key-secret");
    } finally {
      process.env.ENCRYPTION_KEY = prev;
    }
  });

  it("a different passphrase cannot decrypt", () => {
    const enc = encrypt("mine");
    const prev = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "a-completely-different-passphrase-value";
    try {
      expect(() => decrypt(enc)).toThrow();
    } finally {
      process.env.ENCRYPTION_KEY = prev;
    }
  });
});

describe("secretsEqual", () => {
  it("matches equal strings and rejects others", () => {
    expect(secretsEqual("abc123", "abc123")).toBe(true);
    expect(secretsEqual("abc123", "abc124")).toBe(false);
    expect(secretsEqual("abc", "abcdef")).toBe(false);
  });
});
