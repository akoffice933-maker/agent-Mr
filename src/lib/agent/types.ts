// Shared types between the agent backend and chat UI.

export type Platform = "google" | "yandex" | "avito";

export const PLATFORM_LABEL: Record<Platform, string> = {
  google: "Google Ads",
  yandex: "Яндекс.Директ",
  avito: "Авито",
};

export const PLATFORMS_ALL: Platform[] = ["google", "yandex", "avito"];

export interface TraceStep {
  label: string;
  detail?: string;
  status: "ok" | "warn" | "block";
}

export interface PlatformStat {
  platform: Platform;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cpa: number | null;
}

export interface SpendReportRow extends PlatformStat {
  campaigns: number;
}

export interface CampaignRow {
  id: number;
  platform: Platform;
  kind: string;
  name: string;
  status: string;
  budgetDaily: number;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cpa: number | null;
}

export interface KeywordStat {
  id: number;
  text: string;
  platform: Platform;
  campaign: string;
  bid: number;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  ctr: number;
  cpa: number | null;
}

export interface AuditIssue {
  severity: "high" | "medium" | "low";
  text: string;
}

export interface RecRow {
  id: number;
  platform: Platform;
  type: string;
  description: string;
  impact: string;
  status: string;
  campaign?: string;
}

export interface ChatRow {
  id: number;
  customer: string;
  listing: string;
  startedAt: string;
  messagesCount: number;
  status: string;
  lastMessage: string;
}

export interface PreviewChange {
  entity: string;
  name: string;
  before?: string;
  after?: string;
  note?: string;
}

export type ResultPayload =
  | { kind: "text"; text: string }
  | {
      kind: "spend_report";
      period: { from: string; to: string; days: number };
      rows: SpendReportRow[];
      total: PlatformStat & { campaigns: number };
    }
  | {
      kind: "cpa_compare";
      period: { from: string; to: string; days: number };
      rows: PlatformStat[];
      best: Platform;
      diffPct: number;
      insight: string;
    }
  | { kind: "campaigns"; rows: CampaignRow[]; note?: string }
  | { kind: "keywords"; title: string; rows: KeywordStat[]; note?: string }
  | {
      kind: "audit";
      platforms: { platform: Platform; issues: AuditIssue[] }[];
      score: number;
      recsCreated: number;
    }
  | { kind: "recommendations"; rows: RecRow[] }
  | {
      kind: "chats";
      periodDays: number;
      summary: { total: number; leads: number; convPct: number };
      rows: ChatRow[];
    }
  | {
      kind: "preview";
      title: string;
      changes: PreviewChange[];
      cost?: number;
      verdict: "pending" | "blocked";
      reason?: string;
      pendingActionId?: number;
    };

export interface AgentMeta {
  tool: string;
  toolLabel: string;
  platforms: Platform[];
  trace: TraceStep[];
  durationMs: number;
  result: ResultPayload;
  pendingActionId?: number;
}

export interface ChatMessageRow {
  id: number;
  role: "user" | "agent";
  content: string;
  meta: AgentMeta | null;
  createdAt: string;
}
