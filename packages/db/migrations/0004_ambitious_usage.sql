CREATE INDEX "logs_created_idx" ON "request_logs" USING btree ("created_at");--> statement-breakpoint
CREATE TABLE "model_usage_daily" (
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"gateway_model_id" text NOT NULL,
	"usage_date" date NOT NULL,
	"request_count" bigint DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "model_usage_daily_unique" UNIQUE("user_id","gateway_model_id","usage_date")
);--> statement-breakpoint
CREATE INDEX "model_usage_daily_user_model_idx" ON "model_usage_daily" USING btree ("user_id","gateway_model_id");--> statement-breakpoint
INSERT INTO "model_usage_daily" ("user_id", "gateway_model_id", "usage_date", "request_count", "input_tokens", "output_tokens")
SELECT
	"user_id",
	"resolved_gateway_model",
	"created_at"::date,
	count(*)::bigint,
	coalesce(sum("input_tokens"), 0)::bigint,
	coalesce(sum("output_tokens"), 0)::bigint
FROM "request_logs"
WHERE "resolved_gateway_model" IS NOT NULL
GROUP BY "user_id", "resolved_gateway_model", "created_at"::date;
