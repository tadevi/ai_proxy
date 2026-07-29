ALTER TABLE "cliproxy_accounts" ADD COLUMN "cooldown_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "cliproxy_accounts" ADD COLUMN "latest_error" jsonb;
--> statement-breakpoint
ALTER TABLE "cliproxy_accounts" ADD COLUMN "latest_error_at" timestamp with time zone;
