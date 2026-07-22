-- ═══════════════════════════════════════════════════════════════
-- Migration: Route by binding (model + provider), not by a specific
-- token instance; move credential-level health state to connection_tokens
-- ═══════════════════════════════════════════════════════════════

-- 1. connection_tokens: add the cooldown/error tracking that used to live per
--    upstream_models row. A 401/402/403 is a property of the credential, not of
--    whichever model happened to be using it when the failure occurred.
ALTER TABLE "connection_tokens" ADD COLUMN "cooldown_until" timestamp with time zone;
ALTER TABLE "connection_tokens" ADD COLUMN "latest_error" jsonb;
ALTER TABLE "connection_tokens" ADD COLUMN "latest_error_at" timestamp with time zone;

-- 2. upstream_models: drop only cooldown_until, the field that drove routing eligibility
--    and is now superseded by connection_tokens.cooldown_until. latest_error/latest_error_at
--    stay — they're general per-(model,token) request visibility, not routing-affecting,
--    and a 404/format/capability problem is specific to the model, not the credential.
ALTER TABLE "upstream_models" DROP COLUMN "cooldown_until";

-- 3. mapping_routes: switch from referencing one specific (model, token) instance to
--    referencing a binding (model + provider) — the gateway resolves which of the
--    binding's tokens to use at request time, the same way it already does for
--    direct (unmapped) model-id requests.
ALTER TABLE "mapping_routes" ADD COLUMN "binding_id" uuid;
UPDATE "mapping_routes" mr
SET "binding_id" = um.binding_id
FROM "upstream_models" um
WHERE um.id = mr.upstream_model_id;

-- A route whose model never got a binding (fully manual/legacy model with no
-- binding_id) can't be expressed under the new scheme — drop it rather than leave
-- a route with no binding to resolve.
DELETE FROM "mapping_routes" WHERE "binding_id" IS NULL;

-- Multiple routes could point at different tokens of the same binding under the old
-- per-instance scheme; collapse to one route per (mapping, binding), keeping the
-- route with the lowest position (tie-broken by id) and dropping the rest.
DELETE FROM "mapping_routes" mr
USING "mapping_routes" mr2
WHERE mr.mapping_id = mr2.mapping_id
  AND mr.binding_id = mr2.binding_id
  AND (mr2.position < mr.position OR (mr2.position = mr.position AND mr2.id < mr.id));

ALTER TABLE "mapping_routes" ALTER COLUMN "binding_id" SET NOT NULL;
ALTER TABLE "mapping_routes" ADD CONSTRAINT "mapping_routes_binding_id_model_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "model_bindings"("id") ON DELETE cascade;
-- routes_mapping_model_unique is a table constraint (created via drizzle's unique()),
-- not a standalone index — its backing index can only be dropped by dropping the
-- constraint itself, not via DROP INDEX.
ALTER TABLE "mapping_routes" DROP CONSTRAINT IF EXISTS "routes_mapping_model_unique";
ALTER TABLE "mapping_routes" DROP CONSTRAINT IF EXISTS "mapping_routes_upstream_model_id_upstream_models_id_fk";
ALTER TABLE "mapping_routes" DROP COLUMN "upstream_model_id";
CREATE UNIQUE INDEX "routes_mapping_binding_unique" ON "mapping_routes" ("mapping_id", "binding_id");
