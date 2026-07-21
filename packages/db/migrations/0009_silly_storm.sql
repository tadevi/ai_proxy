-- Drop old constraints and indexes on model_usage_daily
ALTER TABLE "model_usage_daily" DROP CONSTRAINT IF EXISTS "model_usage_daily_unique";
DROP INDEX IF EXISTS "model_usage_daily_user_model_idx";

-- Add new upstream_model_id column to model_usage_daily
ALTER TABLE "model_usage_daily" ADD COLUMN "upstream_model_id" uuid;

-- Backfill upstream_model_id from gateway_model_id
UPDATE "model_usage_daily" m
SET "upstream_model_id" = u."id"
FROM "upstream_models" u
WHERE u."gateway_model_id" = m."gateway_model_id"
  AND u."user_id" = m."user_id";

-- Delete rows that couldn't be backfilled (orphaned data)
DELETE FROM "model_usage_daily" WHERE "upstream_model_id" IS NULL;

-- Make it NOT NULL and add FK
ALTER TABLE "model_usage_daily" ALTER COLUMN "upstream_model_id" SET NOT NULL;
ALTER TABLE "model_usage_daily" ADD CONSTRAINT "model_usage_daily_upstream_model_id_upstream_models_id_fk" FOREIGN KEY ("upstream_model_id") REFERENCES "upstream_models"("id") ON DELETE cascade;

-- Add new constraints and indexes
CREATE UNIQUE INDEX "model_usage_daily_unique" ON "model_usage_daily" ("user_id", "upstream_model_id", "usage_date");
CREATE INDEX "model_usage_daily_user_model_idx" ON "model_usage_daily" ("user_id", "upstream_model_id");

-- Drop old gateway_model_id column
ALTER TABLE "model_usage_daily" DROP COLUMN "gateway_model_id";

-- Update request_logs: rename resolved_gateway_model, add resolved_upstream_model_id
ALTER TABLE "request_logs" RENAME COLUMN "resolved_gateway_model" TO "resolved_upstream_model";
ALTER TABLE "request_logs" ADD COLUMN "resolved_upstream_model_id" uuid;

-- Backfill resolved_upstream_model_id
UPDATE "request_logs" r
SET "resolved_upstream_model_id" = u."id"
FROM "upstream_models" u
WHERE u."upstream_model_id" = r."resolved_upstream_model"
  AND u."user_id" = r."user_id";

-- Drop old gateway_model_id from upstream_models
ALTER TABLE "upstream_models" DROP CONSTRAINT IF EXISTS "models_user_gateway_unique";
ALTER TABLE "upstream_models" DROP COLUMN "gateway_model_id";
