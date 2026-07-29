ALTER TABLE "model_bindings" ADD COLUMN "cliproxy_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "model_bindings" ADD CONSTRAINT "model_bindings_cliproxy_account_id_cliproxy_accounts_id_fk" FOREIGN KEY ("cliproxy_account_id") REFERENCES "public"."cliproxy_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DROP INDEX "bindings_connection_preset_format_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "bindings_connection_preset_format_no_account_unique" ON "model_bindings" USING btree ("connection_id", "preset_id", "api_format") WHERE "cliproxy_account_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "bindings_connection_preset_format_account_unique" ON "model_bindings" USING btree ("connection_id", "preset_id", "api_format", "cliproxy_account_id") WHERE "cliproxy_account_id" IS NOT NULL;
--> statement-breakpoint
-- Presets define model capabilities and names; account prefixes belong only to bindings.
UPDATE "model_presets"
SET "upstream_model_id" = regexp_replace("upstream_model_id", '^[^/]+/', '')
WHERE "upstream_model_id" LIKE '%/%';
--> statement-breakpoint
-- Preserve existing bindings where their generated model ID can be matched to a tracked account.
UPDATE "model_bindings" AS binding
SET "cliproxy_account_id" = account."id"
FROM "upstream_models" AS model, "cliproxy_accounts" AS account
WHERE model."binding_id" = binding."id"
  AND account."user_id" = binding."user_id"
  AND model."upstream_model_id" LIKE account."prefix" || '/%'
  AND binding."cliproxy_account_id" IS NULL;
