import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { loginLockout, recordLoginFailure, recordLoginSuccess } from "@/lib/auth/sessions";

describe("password hashing (scrypt)", () => {
  it("hash/verify roundtrip", () => {
    const h = hashPassword("correct-horse-battery");
    expect(h).toMatch(/^scrypt\$\d+\$\d+\$\d+\$/);
    expect(verifyPassword("correct-horse-battery", h)).toBe(true);
  });

  it("rejects wrong password", () => {
    const h = hashPassword("correct-horse-battery");
    expect(verifyPassword("wrong-password", h)).toBe(false);
  });

  it("each hash uses a unique salt", () => {
    const a = hashPassword("same-password");
    const b = hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(verifyPassword("same-password", a)).toBe(true);
    expect(verifyPassword("same-password", b)).toBe(true);
  });

  it("rejects malformed stored values", () => {
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
    expect(verifyPassword("x", "scrypt$bad$format")).toBe(false);
    expect(verifyPassword("x", "")).toBe(false);
  });
});

describe("login brute-force guard", () => {
  const ip = "10.9.8.7-test";

  it("allows login after success", () => {
    recordLoginSuccess(ip);
    expect(loginLockout(ip)).toBe(false);
  });

  it("locks after 5 failures in the window", () => {
    recordLoginSuccess(ip); // reset counter
    for (let i = 0; i < 5; i++) recordLoginFailure(ip);
    expect(loginLockout(ip)).toBe(true);
    // cleanup for other tests
    recordLoginSuccess(ip);
    expect(loginLockout(ip)).toBe(false);
  });

  it("isolates lockouts per IP", () => {
    recordLoginSuccess("other-ip-test");
    for (let i = 0; i < 5; i++) recordLoginFailure(ip);
    expect(loginLockout(ip)).toBe(true);
    expect(loginLockout("other-ip-test")).toBe(false);
    recordLoginSuccess(ip);
  });
});
