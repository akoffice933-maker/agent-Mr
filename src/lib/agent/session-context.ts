// Session Context: memory of the dialog across turns and platforms (ТЗ 4.3, этап 2).
// Passes the last N messages + mentioned entities (campaigns, platforms, pending
// actions) into the LLM prompt so that "подними ставки как в Google" resolves
// against the previously discussed campaign.

import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { campaigns, messages, pendingActions } from "@/db/schema";
import { PLATFORM_LABEL, type Platform } from "./types";
import { serializeMessage } from "./run";
import type { ChatMessageRow } from "./types";

export interface SessionEntities {
  platforms: Platform[];
  campaignNames: string[];
  lastPendingAction?: { id: number; tool: string };
}

export interface SessionContext {
  block: string; // human/LLM readable context block for the system prompt
  entities: SessionEntities;
  history: ChatMessageRow[]; // last N messages (excluding the current user message)
}

const HISTORY_LIMIT = 10;

const PLATFORM_HINTS: Record<Platform, RegExp> = {
  google: /google|гугл|адвордс|adwords|google\s?ads/i,
  yandex: /яндекс|директ|yandex|direct/i,
  avito: /авито|avito/i,
};

export async function buildSessionContext(): Promise<SessionContext> {
  // Last HISTORY_LIMIT+1 messages; the newest one is the current user message (already inserted).
  const rows = (await db.select().from(messages).orderBy(desc(messages.id)).limit(HISTORY_LIMIT + 1)).reverse();
  const history = rows.slice(0, -1).map(serializeMessage);
  const recentText = history.map((m) => m.content).join("\n");

  // Platforms mentioned in the recent dialog
  const platforms = (Object.keys(PLATFORM_HINTS) as Platform[]).filter((p) => PLATFORM_HINTS[p].test(recentText));

  // Campaign names mentioned in the recent dialog
  const allCamps = await db.select({ id: campaigns.id, name: campaigns.name, platform: campaigns.platform }).from(campaigns);
  const lower = recentText.toLowerCase();
  const campaignNames = allCamps
    .filter((c) => c.name.length > 4 && lower.includes(c.name.toLowerCase()))
    .slice(0, 5)
    .map((c) => `${c.name} (${PLATFORM_LABEL[c.platform as Platform]})`);

  // Latest still-pending action (for "подтверди/отмени" references)
  const pending = (await db.select().from(pendingActions).where(eq(pendingActions.status, "pending")).orderBy(desc(pendingActions.id)).limit(1))[0];

  const lines: string[] = [];
  if (platforms.length) lines.push(`Платформы, о которых шла речь: ${platforms.map((p) => PLATFORM_LABEL[p]).join(", ")}`);
  if (campaignNames.length) lines.push(`Упомянутые кампании: ${campaignNames.join("; ")}`);
  if (pending) lines.push(`Есть неподтверждённое действие #${pending.id} (${pending.tool})`);
  if (history.length) {
    const digest = history
      .slice(-4)
      .map((m) => `${m.role === "user" ? "Пользователь" : "Агент"}: ${m.content.slice(0, 160)}`)
      .join("\n");
    lines.push("Последние реплики:\n" + digest);
  }

  return {
    block: lines.join("\n"),
    entities: { platforms, campaignNames, lastPendingAction: pending ? { id: pending.id, tool: pending.tool } : undefined },
    history,
  };
}

// Helpers reused by the LLM intent mapper for entity resolution.
export function findCampaignByName(name: string, platform?: Platform): Promise<{ id: number; name: string; platform: string; status: string } | null> {
  const norm = name.trim().toLowerCase();
  return (async () => {
    const rows = await db.select().from(campaigns);
    const exact = rows.find((c) => c.name.toLowerCase() === norm);
    if (exact) return exact;
    const partial = rows.filter((c) => c.name.toLowerCase().includes(norm) || norm.includes(c.name.toLowerCase()));
    const pool = platform ? partial.filter((c) => c.platform === platform) : partial;
    return pool[0] ?? null;
  })();
}

export { inArray };
