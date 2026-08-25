// OAuth callback security (review E.1 P1-10): /api/oauth/* is OPEN in the
// proxy (a callback must work without an existing session), so its safety
// rests entirely on state + session + org binding. This test exercises the
// Yandex callback path end-to-end against a real DB (tenant tables + RLS):
//
//   valid state        → success redirect + token stored for the org
//   expired state      → error redirect, no token
//   wrong user (org)   → error redirect, no token
//   wrong org          → error redirect, no token
//   replayed state     → error redirect (single use)
//   tampered state     → error redirect, no token
//
// Each scenario gets its OWN org: oauth_tokens is an upsert keyed by
// (org, platform), so the token slot must be isolated to assert precisely.
//
// The Yandex token endpoint is stubbed (no external network in tests); the
// post-oauth sync() failure is caught by the route by design.

import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db, withTenant, identityPool } from "@/db";
import { oauthTokens } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { createOauthState, consumeOauthState } from "@/lib/oauth-state";
import { GET } from "@/app/api/oauth/yandex/route";

const TOKEN_URL_MARKER = "oauth.yandex.ru/token";
const SID = "agentmr_sid";
const TEST_TOKEN = "tok-e1-security";

interface Scenario {
  org: number;
  userId: number;
  sid: string;
}

const sc: Record<"valid" | "expired" | "wrongUser1" | "wrongUser2" | "wrongOrgState" | "wrongOrgSession" | "replay" | "tampered", Scenario> = {} as never;
const cleanup: { orgs: number[]; users: number[] } = { orgs: [], users: [] };

function makeRequest(opts: { code?: string; state?: string; sid?: string }): Request {
  const u = new URL("http://oauth-test.local/api/oauth/yandex");
  if (opts.code) u.searchParams.set("code", opts.code);
  if (opts.state) u.searchParams.set("state", opts.state);
  return new Request(u, { headers: { cookie: opts.sid ? `${SID}=${opts.sid}` : "" } });
}

function locationOf(res: Response): string {
  return res.headers.get("location") ?? "";
}

/** Decrypted stored access token for (org, yandex), or null when absent. */
async function storedToken(orgId: number): Promise<string | null> {
  const rows = await withTenant(
    { orgId, userId: null, role: "admin" },
    () => db.select().from(oauthTokens)
  );
  const row = rows.find((r) => r.platform === "yandex");
  return row ? decrypt(row.accessToken) : null;
}

function stubTokenEndpoint() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const u = String(input);
      if (u.includes(TOKEN_URL_MARKER)) {
        return new Response(JSON.stringify({ access_token: TEST_TOKEN, refresh_token: "ref-test", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`network blocked in test: ${u}`);
    })
  );
}

async function newOrg(name: string): Promise<number> {
  const r = (await identityPool.query(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [name])) as unknown as {
    rows: { id: number }[];
  };
  cleanup.orgs.push(r.rows[0].id);
  return r.rows[0].id;
}

async function newUser(org: number, email: string, role = "admin"): Promise<Scenario> {
  const ur = (await identityPool.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'T') RETURNING id`,
    [email]
  )) as unknown as { rows: { id: number }[] };
  const userId = ur.rows[0].id;
  cleanup.users.push(userId);
  await identityPool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)`, [org, userId, role]);
  const sid = `test-${userId}-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  await identityPool.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [sid, userId]);
  return { org, userId, sid };
}

beforeAll(async () => {
  const stamp = Date.now();
  sc.valid = await newUser(await newOrg(`E1 valid ${stamp}`), `e1-valid-${stamp}@test.local`);
  sc.expired = await newUser(await newOrg(`E1 expired ${stamp}`), `e1-expired-${stamp}@test.local`);
  sc.wrongUser1 = await newUser(await newOrg(`E1 wronguser ${stamp}`), `e1-wu1-${stamp}@test.local`);
  sc.wrongUser2 = await newUser(sc.wrongUser1.org, `e1-wu2-${stamp}@test.local`);
  sc.wrongOrgState = await newUser(await newOrg(`E1 wrongorg-state ${stamp}`), `e1-wos-${stamp}@test.local`);
  sc.wrongOrgSession = await newUser(await newOrg(`E1 wrongorg-session ${stamp}`), `e1-wos2-${stamp}@test.local`);
  sc.replay = await newUser(await newOrg(`E1 replay ${stamp}`), `e1-replay-${stamp}@test.local`);
  sc.tampered = await newUser(await newOrg(`E1 tampered ${stamp}`), `e1-tampered-${stamp}@test.local`);
});

afterAll(async () => {
  for (const u of cleanup.users) {
    await identityPool.query(`DELETE FROM sessions WHERE user_id = $1`, [u]).catch(() => undefined);
    await identityPool.query(`DELETE FROM users WHERE id = $1`, [u]).catch(() => undefined);
  }
  for (const o of cleanup.orgs) {
    await identityPool.query(`DELETE FROM organizations WHERE id = $1`, [o]).catch(() => undefined);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("oauth yandex callback security (E.1 P1-10)", () => {
  it("valid state + matching session → success, token stored for the org", async () => {
    stubTokenEndpoint();
    const s = sc.valid;
    const state = createOauthState("yandex", { orgId: s.org, userId: s.userId, role: "admin" });
    expect(await storedToken(s.org)).toBeNull();
    const res = await GET(makeRequest({ code: "code-1", state, sid: s.sid }));
    const loc = locationOf(res);
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(loc).toContain("/agent?onboard=yandex");
    expect(loc).not.toContain("oauth=error");
    expect(await storedToken(s.org)).toBe(TEST_TOKEN);
  });

  it("expired state → error redirect, no token stored", async () => {
    stubTokenEndpoint();
    const s = sc.expired;
    const state = createOauthState("yandex", { orgId: s.org, userId: s.userId, role: "admin" });
    // Force expiry through the in-memory store (same process).
    const store = (globalThis as unknown as { __oauthStates?: Map<string, { exp: number }> }).__oauthStates;
    const entry = store?.get(state);
    if (entry) entry.exp = Date.now() - 1000;
    const res = await GET(makeRequest({ code: "code-2", state, sid: s.sid }));
    expect(locationOf(res)).toContain("oauth=error");
    expect(await storedToken(s.org)).toBeNull();
  });

  it("wrong user (same org) → error redirect, no token", async () => {
    stubTokenEndpoint();
    const s = sc.wrongUser1;
    const state = createOauthState("yandex", { orgId: s.org, userId: s.userId, role: "admin" });
    const res = await GET(makeRequest({ code: "code-3", state, sid: sc.wrongUser2.sid }));
    expect(locationOf(res)).toContain("oauth=error");
    expect(await storedToken(s.org)).toBeNull();
  });

  it("wrong org → error redirect, no token for either org", async () => {
    stubTokenEndpoint();
    const stateOrg = sc.wrongOrgState;
    const state = createOauthState("yandex", { orgId: stateOrg.org, userId: stateOrg.userId, role: "admin" });
    const res = await GET(makeRequest({ code: "code-4", state, sid: sc.wrongOrgSession.sid }));
    expect(locationOf(res)).toContain("oauth=error");
    expect(await storedToken(stateOrg.org)).toBeNull();
    expect(await storedToken(sc.wrongOrgSession.org)).toBeNull();
  });

  it("replayed state (already consumed) → error redirect", async () => {
    stubTokenEndpoint();
    const s = sc.replay;
    const state = createOauthState("yandex", { orgId: s.org, userId: s.userId, role: "admin" });
    // First use: valid.
    const first = await GET(makeRequest({ code: "code-5a", state, sid: s.sid }));
    expect(locationOf(first)).toContain("/agent?onboard=yandex");
    expect(await storedToken(s.org)).toBe(TEST_TOKEN);
    // Second use: the state is gone (single use) — and the token is NOT rewritten.
    const second = await GET(makeRequest({ code: "code-5b", state, sid: s.sid }));
    expect(locationOf(second)).toContain("oauth=error");
    expect(consumeOauthState(state)).toBeNull();
    expect(await storedToken(s.org)).toBe(TEST_TOKEN);
  });

  it("tampered/unknown state → error redirect, no token", async () => {
    stubTokenEndpoint();
    const s = sc.tampered;
    const res = await GET(makeRequest({ code: "code-6", state: "forged-state-0000", sid: s.sid }));
    expect(locationOf(res)).toContain("oauth=error");
    expect(await storedToken(s.org)).toBeNull();
  });
});
