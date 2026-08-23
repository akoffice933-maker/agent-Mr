CREATE TABLE "accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"name" text NOT NULL,
	"login" text NOT NULL,
	"mode" text DEFAULT 'sandbox' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp DEFAULT now() NOT NULL,
	"actor" text DEFAULT 'chat' NOT NULL,
	"tool" text NOT NULL,
	"params" jsonb,
	"platforms" text DEFAULT '' NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"summary" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer,
	"platform" text NOT NULL,
	"kind" text DEFAULT 'campaign' NOT NULL,
	"external_id" text,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"budget_daily" double precision DEFAULT 0 NOT NULL,
	"strategy" text DEFAULT 'manual' NOT NULL,
	"price" double precision,
	"promotion" text DEFAULT 'none' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "avito_chats" (
	"id" serial PRIMARY KEY NOT NULL,
	"listing_id" integer,
	"customer" text NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"messages_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"last_message" text
);
--> statement-breakpoint
CREATE TABLE "keywords" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"text" text NOT NULL,
	"bid" double precision NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"spend" double precision DEFAULT 0 NOT NULL,
	"conversions" integer DEFAULT 0 NOT NULL,
	"quality_score" integer DEFAULT 7 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"meta" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metrics_daily" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"date" text NOT NULL,
	"spend" double precision DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"conversions" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "negative_keywords" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"text" text NOT NULL,
	"source" text DEFAULT 'agent' NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"tool" text NOT NULL,
	"params" jsonb,
	"preview" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" text DEFAULT 'chat' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"campaign_id" integer,
	"type" text NOT NULL,
	"description" text NOT NULL,
	"impact" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" jsonb
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "avito_chats" ADD CONSTRAINT "avito_chats_listing_id_campaigns_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keywords" ADD CONSTRAINT "keywords_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_daily" ADD CONSTRAINT "metrics_daily_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negative_keywords" ADD CONSTRAINT "negative_keywords_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaigns_platform_idx" ON "campaigns" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "keywords_campaign_idx" ON "keywords" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "metrics_campaign_date_idx" ON "metrics_daily" USING btree ("campaign_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_key_idx" ON "settings" USING btree ("key");