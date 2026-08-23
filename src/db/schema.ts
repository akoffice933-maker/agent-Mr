import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── Accounts ────────────────────────────────────────────────────────────────
export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  platform: text("platform").notNull(), // google | yandex | avito
  name: text("name").notNull(),
  login: text("login").notNull(),
  mode: text("mode").notNull().default("sandbox"), // sandbox | production
});

// ── Campaigns & Avito listings (unified entity) ────────────────────────────
export const campaigns = pgTable(
  "campaigns",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id").references(() => accounts.id),
    platform: text("platform").notNull(),
    kind: text("kind").notNull().default("campaign"), // campaign | listing
    externalId: text("external_id"),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"), // active | paused
    budgetDaily: doublePrecision("budget_daily").notNull().default(0),
    strategy: text("strategy").notNull().default("manual"),
    price: doublePrecision("price"), // listings only
    promotion: text("promotion").notNull().default("none"), // listings: none | boost7 | turbo
  },
  (t) => [index("campaigns_platform_idx").on(t.platform)]
);

// ── Daily metrics (unified: impressions→показы/просмотры, clicks→клики/контакты)
export const metricsDaily = pgTable(
  "metrics_daily",
  {
    id: serial("id").primaryKey(),
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    date: text("date").notNull(), // YYYY-MM-DD
    spend: doublePrecision("spend").notNull().default(0),
    impressions: integer("impressions").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    conversions: integer("conversions").notNull().default(0),
  },
  (t) => [index("metrics_campaign_date_idx").on(t.campaignId, t.date)]
);

// ── Keywords (Google / Yandex) ─────────────────────────────────────────────
export const keywords = pgTable(
  "keywords",
  {
    id: serial("id").primaryKey(),
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    externalId: text("external_id"), // platform keyword id (Direct keywordId / Google criterion id)
    text: text("text").notNull(),
    bid: doublePrecision("bid").notNull(),
    impressions: integer("impressions").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    spend: doublePrecision("spend").notNull().default(0),
    conversions: integer("conversions").notNull().default(0),
    qualityScore: integer("quality_score").notNull().default(7),
  },
  (t) => [index("keywords_campaign_idx").on(t.campaignId)]
);

export const negativeKeywords = pgTable("negative_keywords", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id")
    .notNull()
    .references(() => campaigns.id),
  text: text("text").notNull(),
  source: text("source").notNull().default("agent"),
  addedAt: timestamp("added_at").notNull().defaultNow(),
});

// ── Avito chats ────────────────────────────────────────────────────────────
export const chats = pgTable("avito_chats", {
  id: serial("id").primaryKey(),
  listingId: integer("listing_id").references(() => campaigns.id),
  customer: text("customer").notNull(),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  messagesCount: integer("messages_count").notNull().default(0),
  status: text("status").notNull().default("new"), // new | consult | lead | closed
  lastMessage: text("last_message"),
});

// ── Audit log ──────────────────────────────────────────────────────────────
export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  ts: timestamp("ts").notNull().defaultNow(),
  actor: text("actor").notNull().default("chat"), // chat | ui | system
  tool: text("tool").notNull(),
  params: jsonb("params"),
  platforms: text("platforms").notNull().default(""),
  dryRun: boolean("dry_run").notNull().default(false),
  status: text("status").notNull().default("ok"), // ok | blocked | pending | applied | rejected | dry_run
  summary: text("summary").notNull().default(""),
});

// ── Pending actions (safety confirmations) ─────────────────────────────────
export const pendingActions = pgTable("pending_actions", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  tool: text("tool").notNull(),
  params: jsonb("params"),
  preview: jsonb("preview"),
  costDaily: doublePrecision("cost_daily"), // extra ₽/day the action adds, for limit re-check on approve
  status: text("status").notNull().default("pending"), // pending | applied | rejected
  source: text("source").notNull().default("chat"),
});

// ── OAuth tokens for real platform integrations (encrypted at rest) ────────
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: serial("id").primaryKey(),
    platform: text("platform").notNull(), // google | yandex | avito
    accessToken: text("access_token").notNull(), // AES-256-GCM ciphertext
    refreshToken: text("refresh_token"), // AES-256-GCM ciphertext
    expiresAt: timestamp("expires_at"),
    extra: jsonb("extra"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("oauth_tokens_platform_idx").on(t.platform)]
);

// ── Safety settings (key/value) ────────────────────────────────────────────
export const settings = pgTable(
  "settings",
  {
    id: serial("id").primaryKey(),
    key: text("key").notNull(),
    value: jsonb("value"),
  },
  (t) => [uniqueIndex("settings_key_idx").on(t.key)]
);

// ── Recommendations ────────────────────────────────────────────────────────
export const recommendations = pgTable("recommendations", {
  id: serial("id").primaryKey(),
  platform: text("platform").notNull(),
  campaignId: integer("campaign_id").references(() => campaigns.id),
    type: text("type").notNull(),
    description: text("description").notNull(),
    impact: text("impact").notNull().default(""),
    params: jsonb("params"), // machine-readable effect params (e.g. budget_shift {from,to,percent})
    status: text("status").notNull().default("open"), // open | applied | dismissed
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ── Chat messages ──────────────────────────────────────────────────────────
export const messages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  role: text("role").notNull(), // user | agent
  content: text("content").notNull().default(""),
  meta: jsonb("meta"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
