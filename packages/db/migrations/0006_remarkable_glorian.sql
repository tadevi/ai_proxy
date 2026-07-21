ALTER TABLE "model_usage_daily" ADD COLUMN "cache_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "cache_input_tokens" integer;