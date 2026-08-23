CREATE TABLE "oauth_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp,
	"extra" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "keywords" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD COLUMN "cost_daily" double precision;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "params" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_tokens_platform_idx" ON "oauth_tokens" USING btree ("platform");