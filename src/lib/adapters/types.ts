// Platform adapter interface (ТЗ раздел 8).
// Every platform client implements the same surface; tools.ts stays unified.
// In sandbox mode the client is a no-op wrapper over the local mirror DB
// (seed data). In production it talks to the real platform API and keeps
// the local mirror in sync so unified analytics keep working.

import type { Platform } from "../agent/types";

export interface UnifiedCampaign {
  platform: Platform;
  externalId: string;
  name: string;
  kind: "campaign" | "listing";
  status: "active" | "paused";
  budgetDaily: number;
  strategy?: string;
  price?: number;
  promotion?: string;
}

export interface DailyMetric {
  campaignId: number; // local mirror id
  date: string; // YYYY-MM-DD
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

export interface WriteResult {
  ok: boolean;
  detail?: string; // human-readable confirmation or error
}

export interface PlatformClient {
  readonly platform: Platform;
  /** True when the client talks to the real platform API. */
  readonly isProduction: boolean;
  /** Pull fresh state (campaigns + metrics) into the local mirror DB. */
  sync(): Promise<void>;
  /** Push a confirmed change to the platform. */
  write(op: WriteOp): Promise<WriteResult>;
}

export type WriteOp =
  | { kind: "campaign_status"; campaignIds: number[]; status: "active" | "paused" }
  | { kind: "campaign_budget"; campaignId: number; budgetDaily: number }
  | { kind: "bids_factor"; keywordIds: number[]; factor: number }
  | { kind: "negative_keywords"; campaignId: number; words: string[] }
  | { kind: "promote_listings"; campaignIds: number[]; service: string }
  | { kind: "create_campaign"; name: string; budgetDaily: number; strategy: string };
