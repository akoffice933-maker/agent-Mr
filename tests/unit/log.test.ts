// Review P2: structured logging.
//
// The app used bare console.log/console.error with free-form strings, which in
// production is an unsearchable line in a container's stdout — no level, no
// tenant, no way to alert on an error rate. These tests pin the parts that
// matter operationally: machine-readable output, tenant fields, level
// filtering, and — most importantly — that a credential can never reach the
// log stream.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Load the module fresh so env changes (LOG_LEVEL/LOG_FORMAT) take effect. */
async function freshLog(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return (await import("@/lib/log")).log;
}

const originalEnv = { ...process.env };
let out: string[] = [];
let err: string[] = [];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("structured logger (review P2)", () => {
  it("emits one parseable JSON object per line", async () => {
    const log = await freshLog({ LOG_FORMAT: "json", LOG_LEVEL: "info" });
    log.info("campaign paused", { org: 1, campaignId: 42 });

    expect(out).toHaveLength(1);
    const rec = JSON.parse(out[0]);
    expect(rec.level).toBe("info");
    expect(rec.msg).toBe("campaign paused");
    expect(rec.org).toBe(1);
    expect(rec.campaignId).toBe(42);
    expect(typeof rec.ts).toBe("string");
  });

  it("REDACTS credentials instead of logging them", async () => {
    const log = await freshLog({ LOG_FORMAT: "json", LOG_LEVEL: "info" });
    log.info("machine key used", {
      org: 1,
      apiKey: "amr_SUPERSECRET",
      refreshToken: "rt_LEAK",
      client_secret: "cs_LEAK",
      authorization: "Bearer abc",
      cookie: "agentmr_sid=deadbeef",
    });

    const line = out[0];
    // The values must not appear anywhere in the emitted line.
    for (const secret of ["amr_SUPERSECRET", "rt_LEAK", "cs_LEAK", "Bearer abc", "deadbeef"]) {
      expect(line).not.toContain(secret);
    }
    const rec = JSON.parse(line);
    expect(rec.apiKey).toBe("[redacted]");
    expect(rec.refreshToken).toBe("[redacted]");
    expect(rec.client_secret).toBe("[redacted]");
    expect(rec.org).toBe(1); // non-secret fields survive
  });

  it("sends warn/error to stderr and info to stdout", async () => {
    const log = await freshLog({ LOG_FORMAT: "json", LOG_LEVEL: "debug" });
    log.info("fine");
    log.warn("careful");
    log.error("broken");

    expect(out).toHaveLength(1);
    expect(err).toHaveLength(2);
  });

  it("serializes an Error into message + name", async () => {
    const log = await freshLog({ LOG_FORMAT: "json", LOG_LEVEL: "info", NODE_ENV: "production" });
    log.error("oauth exchange failed", { platform: "yandex" }, new Error("invalid_grant"));

    const rec = JSON.parse(err[0]);
    expect(rec.err).toBe("invalid_grant");
    expect(rec.errName).toBe("Error");
    expect(rec.platform).toBe("yandex");
    // Stacks are omitted in production to keep aggregated logs readable.
    expect(rec.stack).toBeUndefined();
  });

  it("handles a non-Error throw without blowing up", async () => {
    const log = await freshLog({ LOG_FORMAT: "json", LOG_LEVEL: "info" });
    log.error("weird failure", {}, "just a string");
    expect(JSON.parse(err[0]).err).toBe("just a string");
  });

  it("respects LOG_LEVEL (debug suppressed at info)", async () => {
    const log = await freshLog({ LOG_FORMAT: "json", LOG_LEVEL: "info" });
    log.debug("noisy detail");
    expect(out).toHaveLength(0);

    const verbose = await freshLog({ LOG_FORMAT: "json", LOG_LEVEL: "debug" });
    verbose.debug("noisy detail");
    expect(out).toHaveLength(1);
  });

  it("drops undefined fields rather than emitting nulls", async () => {
    const log = await freshLog({ LOG_FORMAT: "json", LOG_LEVEL: "info" });
    log.info("partial", { org: 1, userId: undefined });
    const rec = JSON.parse(out[0]);
    expect("userId" in rec).toBe(false);
  });
});
