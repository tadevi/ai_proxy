ALTER TABLE "upstream_models" ADD COLUMN "latest_error" jsonb;--> statement-breakpoint
ALTER TABLE "upstream_models" ADD COLUMN "latest_error_at" timestamp with time zone;