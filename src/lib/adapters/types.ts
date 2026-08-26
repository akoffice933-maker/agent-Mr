// Platform adapter interface (ТЗ раздел 8 + Phase E execution contract).
//
// Phase E: writes are an EXECUTION, not a fire-and-forget call.
//   execute(op) → write to provider → capture provider response → READ BACK
//   the changed resources → compare desired vs actual → verified | failed.
// The agent marks a pending action VERIFIED only when the read-back matches.

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

export type WriteOp =
  | { kind: "campaign_status"; campaignIds: number[]; status: "active" | "paused" }
  | { kind: "campaign_budget"; campaignId: number; budgetDaily: number }
  | { kind: "bids_factor"; keywordIds: number[]; factor: number }
  | { kind: "negative_keywords"; campaignId: number; words: string[] }
  | { kind: "promote_listings"; campaignIds: number[]; service: string }
  | {
      kind: "create_campaign";
      name: string;
      budgetDaily: number;
      strategy: string;
      url?: string;
      adGroupName?: string;
      title?: string;
      text?: string;
      keywords?: string[];
      negativeKeywords?: string[];
      regionIds?: number[];
      /** Responsive ad headlines (Direct Titles), max 7 × 56 chars.
       *  Legacy `title` is treated as the first headline. */
      titles?: string[];
      /** Callout extensions (Direct «уточнения»), max 5 × 25 chars. */
      callouts?: string[];
      /** Ad price, ₽ (Direct PriceExtension). */
      priceRubles?: number;
      /** Old (strikethrough) price, ₽. */
      priceOldRubles?: number;
      /** Price qualifier → Direct PriceQualifier FROM / UP_TO (default NONE). */
      priceQualifier?: "from" | "up_to";
      /** Campaign-level URL parameters / UTM tags (Direct TrackingParams),
       *  added to every ad link, e.g. "utm_source=agentmr&utm_medium=cpc". */
      trackingParams?: string;
      /** Ad images (public URLs, jpg/png/gif, ≤5): fetched server-side and
       *  uploaded to Direct (adimages) and attached to the ad. */
      images?: { url: string; name?: string }[];
      /** stable id of the pending action — builds the provider-side correlation
       *  tag (agentmr:{org}:{actionId}) so a retried action ADOPTS the already
       *  created campaign instead of duplicating it (E.1 idempotency). */
      correlationId?: number;
      maxCpcRubles?: number;
      maxCpaRubles?: number;
    }
  | {
      /** Saga compensation: delete a (partially) created Yandex campaign tree. */
      kind: "delete_campaign_tree";
      campaignId: number; // local mirror id
    };

/** Result of an executed write with provider verification (Phase E, E4). */
export interface ExecutionResult {
  ok: boolean;
  /** true only when the read-back confirmed the desired state (E4). */
  verified: boolean;
  /** raw provider response for the write (stored in pending_actions.provider_response). */
  providerResponse?: unknown;
  /** state read back from the provider after the write (stored in pending_actions.readback). */
  readback?: unknown;
  error?: string;
  detail?: string;
}

export interface PlatformClient {
  readonly platform: Platform;
  /** True when the client talks to the real provider API (or its simulator). */
  readonly isProduction: boolean;
  /** Pull fresh state (campaigns + metrics) into the local mirror DB. No-op in sandbox. */
  sync(): Promise<void>;
  /**
   * Execute a confirmed write with provider verification (Phase E):
   * write → provider response → read-back → compare → verified/failed.
   */
  execute(op: WriteOp): Promise<ExecutionResult>;
}
