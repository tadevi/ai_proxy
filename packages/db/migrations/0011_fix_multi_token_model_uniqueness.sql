-- ═══════════════════════════════════════════════════════════════
-- Migration: Fix upstream_models uniqueness for multi-token connections
-- ═══════════════════════════════════════════════════════════════
-- models_connection_upstream_unique (added in 0008) predates connection_tokens
-- (added in 0010) and only covers (provider_connection_id, upstream_model_id).
-- Since it ignores token_id, every token past the first one configured on a
-- connection silently failed to get its own upstream_models row (the insert hit
-- the unique violation and was swallowed as "already exists").

-- 1. Drop the stale constraint that ignores token_id
ALTER TABLE "upstream_models" DROP CONSTRAINT IF EXISTS "models_connection_upstream_unique";

-- 2. One row per (connection, upstream model, token) when a token is set
CREATE UNIQUE INDEX "models_connection_upstream_token_unique" ON "upstream_models" ("provider_connection_id", "upstream_model_id", "token_id") WHERE "token_id" IS NOT NULL;

-- 3. Manually created models with no token stay unique per connection, as before
CREATE UNIQUE INDEX "models_connection_upstream_no_token_unique" ON "upstream_models" ("provider_connection_id", "upstream_model_id") WHERE "token_id" IS NULL;

-- 4. Backfill the upstream_models rows that were silently dropped for every
--    (binding, enabled token) pair that should already have one.
INSERT INTO "upstream_models" (
  "user_id", "display_name", "upstream_model_id", "provider_connection_id",
  "binding_id", "token_id", "api_format", "provider_base_path",
  "supports_images", "supports_reasoning", "max_output_tokens"
)
SELECT
  mb.user_id,
  mp.display_name || ' (' || ct.name || ' @ ' || pc.display_name || ')',
  mp.upstream_model_id,
  mb.connection_id,
  mb.id,
  ct.id,
  mb.api_format,
  mb.provider_base_path,
  mp.supports_images,
  mp.supports_reasoning,
  mp.max_output_tokens
FROM "model_bindings" mb
JOIN "connection_tokens" ct ON ct.connection_id = mb.connection_id AND ct.enabled = true
JOIN "model_presets" mp ON mp.id = mb.preset_id
JOIN "provider_connections" pc ON pc.id = mb.connection_id
WHERE NOT EXISTS (
  SELECT 1 FROM "upstream_models" um
  WHERE um.binding_id = mb.id AND um.token_id = ct.id
);
