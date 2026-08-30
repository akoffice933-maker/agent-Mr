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

// Review P1.3: the guard now runs on the shared RateLimiter (cross-instance
// capable) and is async. Two behavioural notes the tests encode:
//   * a SUCCESSFUL login no longer clears the window — otherwise one correct
//     guess would reset the budget for the whole IP;
//   * checking the lockout must not itself consume budget (peek, not check).
// Each test uses a fresh IP so the sliding windows never interfere.
describe("login brute-force guard", () => {
  let n = 0;
  const freshIp = () => `10.9.8.${++n}-test-${Date.now()}`;

  it("a fresh client is not locked out", async () => {
    expect(await loginLockout(freshIp())).toBe(false);
  });

  it("locks after 5 failures in the window", async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await recordLoginFailure(ip);
    expect(await loginLockout(ip)).toBe(true);
  });

  it("stays unlocked below the threshold", async () => {
    const ip = freshIp();
    for (let i = 0; i < 4; i++) await recordLoginFailure(ip);
    expect(await loginLockout(ip)).toBe(false);
  });

  it("checking the lockout does not consume budget", async () => {
    const ip = freshIp();
    for (let i = 0; i < 4; i++) await recordLoginFailure(ip);
    // Repeated probes must not push the client over the threshold.
    for (let i = 0; i < 10; i++) expect(await loginLockout(ip)).toBe(false);
  });

  it("isolates lockouts per IP", async () => {
    const locked = freshIp();
    const other = freshIp();
    for (let i = 0; i < 5; i++) await recordLoginFailure(locked);
    expect(await loginLockout(locked)).toBe(true);
    expect(await loginLockout(other)).toBe(false);
  });

  it("a successful login does not clear the failure window", async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await recordLoginFailure(ip);
    await recordLoginSuccess(ip);
    expect(await loginLockout(ip)).toBe(true);
  });
});
