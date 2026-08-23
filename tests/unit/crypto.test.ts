import { beforeAll, describe, expect, it } from "vitest";
import { decrypt, encrypt } from "@/lib/crypto";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "test-encryption-key-0123456789abcdef";
});

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
    const buf = Buffer.from(enc, "base64");
    buf[buf.length - 1] ^= 0xff;
    expect(() => decrypt(buf.toString("base64"))).toThrow();
  });
});
