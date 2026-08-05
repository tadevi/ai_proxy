ALTER TABLE "model_usage_daily" ADD COLUMN "cache_usage_reported_request_count" bigint DEFAULT 0 NOT NULL;

-- Backfill coverage from request_logs so historical aggregates reflect the
-- count of requests whose upstream actually reported cache usage.
UPDATE "model_usage_daily" AS m
SET "cache_usage_reported_request_count" = (
  SELECT count(*)
  FROM "request_logs" AS r
  WHERE r."user_id" = m."user_id"
    AND r."resolved_upstream_model_id" = m."upstream_model_id"
    AND r."created_at"::date = m."usage_date"
    AND r."cache_input_tokens" IS NOT NULL
);
