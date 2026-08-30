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
  foreignKey,
} from "drizzle-orm/pg-core";

// ── Accounts ────────────────────────────────────────────────────────────────
export const accounts = pgTable("accounts", {
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
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
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    // Tenant integrity (E.1): (organization_id, account_id) is a COMPOSITE FK
    // to accounts(organization_id, id) — a campaign can never reference an
    // account from another org, even though RLS protects the rows themselves.
    accountId: integer("account_id"),
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
  (t) => [
    index("campaigns_platform_idx").on(t.platform),
    index("campaigns_org_platform_ext_idx").on(t.organizationId, t.platform, t.externalId),
    // ON DELETE SET NULL is set by migration 0004 (drizzle v0.45 foreignKey()
    // helper does not expose onDelete for composite FKs).
    foreignKey({
      name: "campaigns_org_account_fk",
      columns: [t.organizationId, t.accountId],
      foreignColumns: [accounts.organizationId, accounts.id],
    }),
  ]
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
export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    ts: timestamp("ts").notNull().defaultNow(),
    actor: text("actor").notNull().default("chat"), // chat | ui | system
    tool: text("tool").notNull(),
    params: jsonb("params"),
    platforms: text("platforms").notNull().default(""),
    dryRun: boolean("dry_run").notNull().default(false),
    status: text("status").notNull().default("ok"), // ok | blocked | pending | applied | rejected | dry_run
    summary: text("summary").notNull().default(""),
  },
  (t) => [index("audit_log_org_ts_idx").on(t.organizationId, t.ts)]
);

// ── Pending actions (safety confirmations) ─────────────────────────────────
export const pendingActions = pgTable(
  "pending_actions",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    tool: text("tool").notNull(),
    params: jsonb("params"),
    preview: jsonb("preview"),
    costDaily: doublePrecision("cost_daily"), // extra ₽/day the action adds, for limit re-check on approve
    // Lifecycle: pending → executing → verified | failed | rejected.
    status: text("status").notNull().default("pending"),
    // Uniqueness is enforced by a PARTIAL index covering only the active
    // states (migration 0010): a terminal action releases its key so the user
    // can legitimately repeat the same request later. Declared without
    // .unique() here because drizzle-kit cannot express a WHERE clause on a
    // column constraint.
    idempotencyKey: text("idempotency_key"),
    attempts: integer("attempts").notNull().default(0),
    providerResponse: jsonb("provider_response"), // raw provider response for the write
    readback: jsonb("readback"), // state read back from the provider after the write
    lastError: text("last_error"),
    executedAt: timestamp("executed_at"),
    verifiedAt: timestamp("verified_at"),
    source: text("source").notNull().default("chat"),
    // Phase 0.4: optimistic locking — every lifecycle transition bumps version;
    // concurrent approvers are serialized by the atomic claim + version check.
    version: integer("version").notNull().default(0),
    // Phase 0.5: pending actions expire (approval window 48h); failed actions
    // stay retryable (idempotent resume) but are also swept after 14 days.
    expiresAt: timestamp("expires_at"),
  },
  (t) => [index("pending_actions_org_status_idx").on(t.organizationId, t.status)]
);

// ── OAuth state (DB-backed, multi-instance safe) ───────────────────────────
export const oauthStates = pgTable(
  "oauth_states",
  {
    state: text("state").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: integer("user_id"),
    platform: text("platform").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
  },
  (t) => [index("oauth_states_org_idx").on(t.organizationId)]
);

// ── Users (Phase B: identity foundation for multi-tenancy) ─────────────────
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(), // scrypt$N$r$p$salt$hash
  name: text("name"),
  // The effective role is ALWAYS org_members.role (per-tenant membership) — see
  // resolveSessionContext. The legacy `users.role` column was dropped in
  // migration 0008; it was never read for authorization.
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ── Sessions (server-side; HttpOnly cookie carries only the session id) ────
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // 32-byte random hex
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)]
);

// ── Multi-tenancy (Phase C) ───────────────────────────────────────────────
export const organizations = pgTable("organizations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const orgMembers = pgTable(
  "org_members",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // owner | admin | media_buyer | analyst | viewer (Phase D enforces the matrix)
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("org_members_unique_idx").on(t.orgId, t.userId)]
);

// Pending organization invitations. Identity-plane table: access is guarded
// by the members API using the authenticated tenant context.
export const orgInvites = pgTable(
  "org_invites",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("viewer"),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
  },
  (t) => [index("org_invites_org_idx").on(t.orgId), index("org_invites_email_idx").on(t.email)]
);

// Org-scoped machine API keys (MCP / Telegram / scripts).
export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(), // sha256 hex of the key — raw key is never stored
  keyPrefix: text("key_prefix").notNull(), // first 8 chars, for display/revoke
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at"),
  expiresAt: timestamp("expires_at"), // null = no expiration
  revokedAt: timestamp("revoked_at"), // null = active
  // Optional per-key capability scopes. NULL preserves legacy unrestricted keys;
  // newly created keys should always receive explicit scopes.
  scopes: jsonb("scopes").$type<string[] | null>(),
});

// ── OAuth tokens for real platform integrations (encrypted at rest) ────────
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(), // google | yandex | avito
    accessToken: text("access_token").notNull(), // AES-256-GCM ciphertext
    refreshToken: text("refresh_token"), // AES-256-GCM ciphertext
    expiresAt: timestamp("expires_at"),
    extra: jsonb("extra"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("oauth_tokens_org_platform_idx").on(t.organizationId, t.platform)]
);

// ── Safety settings (key/value) ────────────────────────────────────────────
export const settings = pgTable(
  "settings",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value"),
  },
  (t) => [uniqueIndex("settings_org_key_idx").on(t.organizationId, t.key)]
);

// ── Recommendations ────────────────────────────────────────────────────────
export const recommendations = pgTable(
  "recommendations",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    campaignId: integer("campaign_id").references(() => campaigns.id),
    type: text("type").notNull(),
    description: text("description").notNull(),
    impact: text("impact").notNull().default(""),
    params: jsonb("params"), // machine-readable effect params (e.g. budget_shift {from,to,percent})
    status: text("status").notNull().default("open"), // open | applied | dismissed
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("recommendations_org_status_idx").on(t.organizationId, t.status)]
);

// ── Chat messages ──────────────────────────────────────────────────────────
export const messages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // user | agent
  content: text("content").notNull().default(""),
  meta: jsonb("meta"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
