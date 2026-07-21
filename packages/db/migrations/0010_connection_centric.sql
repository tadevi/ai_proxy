-- ═══════════════════════════════════════════════════════════════
-- Migration: Connection-centric model management
-- ═══════════════════════════════════════════════════════════════

-- 1. Create connection_tokens table
CREATE TABLE "connection_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "name" text NOT NULL,
  "encrypted_api_key" text NOT NULL,
  "encryption_iv" text NOT NULL,
  "encryption_auth_tag" text NOT NULL,
  "encryption_key_version" integer DEFAULT 1 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "connection_tokens" ADD CONSTRAINT "connection_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade;
ALTER TABLE "connection_tokens" ADD CONSTRAINT "connection_tokens_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "provider_connections"("id") ON DELETE cascade;
CREATE INDEX "tokens_user_idx" ON "connection_tokens" USING btree ("user_id");
CREATE INDEX "tokens_connection_idx" ON "connection_tokens" USING btree ("connection_id");
CREATE UNIQUE INDEX "tokens_connection_name_unique" ON "connection_tokens" ("connection_id", "name");

-- 2. Migrate existing API keys from provider_connections to connection_tokens
INSERT INTO "connection_tokens" ("user_id", "connection_id", "name", "encrypted_api_key", "encryption_iv", "encryption_auth_tag", "encryption_key_version")
SELECT "user_id", "id", 'Default', "encrypted_api_key", "encryption_iv", "encryption_auth_tag", "encryption_key_version"
FROM "provider_connections";

-- 3. Create model_bindings table
CREATE TABLE "model_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "preset_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "api_format" "api_format" NOT NULL,
  "provider_base_path" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "model_bindings" ADD CONSTRAINT "model_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade;
ALTER TABLE "model_bindings" ADD CONSTRAINT "model_bindings_preset_id_model_presets_id_fk" FOREIGN KEY ("preset_id") REFERENCES "model_presets"("id") ON DELETE restrict;
ALTER TABLE "model_bindings" ADD CONSTRAINT "model_bindings_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "provider_connections"("id") ON DELETE cascade;
CREATE INDEX "bindings_user_idx" ON "model_bindings" USING btree ("user_id");
CREATE INDEX "bindings_connection_idx" ON "model_bindings" USING btree ("connection_id");
CREATE UNIQUE INDEX "bindings_connection_preset_format_unique" ON "model_bindings" ("connection_id", "preset_id", "api_format");

-- 4. Add binding_id and token_id to upstream_models
ALTER TABLE "upstream_models" ADD COLUMN "binding_id" uuid;
ALTER TABLE "upstream_models" ADD COLUMN "token_id" uuid;
ALTER TABLE "upstream_models" ADD CONSTRAINT "upstream_models_binding_id_model_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "model_bindings"("id") ON DELETE set null;
ALTER TABLE "upstream_models" ADD CONSTRAINT "upstream_models_token_id_connection_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "connection_tokens"("id") ON DELETE set null;

-- 5. Remove API key columns from provider_connections
ALTER TABLE "provider_connections" DROP COLUMN "encrypted_api_key";
ALTER TABLE "provider_connections" DROP COLUMN "encryption_iv";
ALTER TABLE "provider_connections" DROP COLUMN "encryption_auth_tag";
ALTER TABLE "provider_connections" DROP COLUMN "encryption_key_version";
