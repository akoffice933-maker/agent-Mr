// Encrypted OAuth token store (ТЗ 4.1: oauth_tokens, шифрование на уровне приложения).
import { and, eq } from "drizzle-orm";
import { db, currentTenant } from "@/db";
import { accounts, oauthTokens } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import type { Platform } from "@/lib/agent/types";

export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  extra?: Record<string, unknown>;
}

export type TokenRefresher = (current: StoredToken | null) => Promise<StoredToken>;

// Refresher functions are registered by live clients at module load time,
// which avoids a circular import (store ⇄ clients).
const refreshers = new Map<Platform, TokenRefresher>();

export function registerRefresher(platform: Platform, fn: TokenRefresher): void {
  refreshers.set(platform, fn);
}

export async function storeToken(org: number, platform: Platform, t: StoredToken): Promise<void> {
  await db
    .insert(oauthTokens)
    .values({
      organizationId: org,
      platform,
      accessToken: encrypt(t.accessToken),
      refreshToken: t.refreshToken ? encrypt(t.refreshToken) : null,
      expiresAt: t.expiresAt ?? null,
      extra: (t.extra ?? {}) as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [oauthTokens.organizationId, oauthTokens.platform],
      set: {
        accessToken: encrypt(t.accessToken),
        refreshToken: t.refreshToken ? encrypt(t.refreshToken) : null,
        expiresAt: t.expiresAt ?? null,
        extra: (t.extra ?? {}) as Record<string, unknown>,
        updatedAt: new Date(),
      },
    });
}

export async function getToken(org: number, platform: Platform, allowRefresh = true): Promise<StoredToken | null> {
  // Tenant-scoped: each organization has its own connection per platform.
  const row = (
    await db.select().from(oauthTokens).where(and(eq(oauthTokens.organizationId, org), eq(oauthTokens.platform, platform)))
  )[0];
  if (!row) return null;

  let token: StoredToken = {
    accessToken: decrypt(row.accessToken),
    refreshToken: row.refreshToken ? decrypt(row.refreshToken) : undefined,
    expiresAt: row.expiresAt ?? undefined,
    extra: (row.extra ?? undefined) as Record<string, unknown> | undefined,
  };

  const expires = token.expiresAt ? new Date(token.expiresAt).getTime() : null;
  const expired = expires !== null && expires - 60_000 < Date.now();

  if (expired && allowRefresh) {
    const refresher = refreshers.get(platform);
    if (refresher) {
      try {
        token = await refresher(token);
        await storeToken(org, platform, token);
        return token;
      } catch (e) {
        console.error(`[oauth-store] refresh failed for ${platform}:`, (e as Error).message);
        return null;
      }
    }
  }

  return expired ? null : token;
}

export async function hasToken(org: number, platform: Platform): Promise<boolean> {
  return (
    await db.select({ id: oauthTokens.id }).from(oauthTokens).where(and(eq(oauthTokens.organizationId, org), eq(oauthTokens.platform, platform)))
  ).length > 0;
}

export async function accountMode(platform: Platform): Promise<"sandbox" | "production"> {
  const row = (await db.select().from(accounts).where(eq(accounts.platform, platform)))[0];
  return (row?.mode as "sandbox" | "production") ?? "sandbox";
}

export async function setAccountMode(platform: Platform, mode: "sandbox" | "production"): Promise<void> {
  await db.update(accounts).set({ mode }).where(eq(accounts.platform, platform));
}

/** Production mode is available when the account is in production AND a (refreshable) token exists. */
export async function isProduction(platform: Platform): Promise<boolean> {
  if ((await accountMode(platform)) !== "production") return false;
  const org = currentTenant()?.orgId ?? 1;
  return Boolean(await getToken(org, platform));
}
