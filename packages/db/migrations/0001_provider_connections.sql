CREATE TABLE "provider_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "display_name" text NOT NULL,
  "api_format" "api_format" NOT NULL,
  "base_url" text NOT NULL,
  "request_path_override" text,
  "encrypted_api_key" text NOT NULL,
  "encryption_iv" text NOT NULL,
  "encryption_auth_tag" text NOT NULL,
  "encryption_key_version" integer DEFAULT 1 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "upstream_models" ADD COLUMN "provider_connection_id" uuid;
--> statement-breakpoint
UPDATE "upstream_models" SET "provider_connection_id" = gen_random_uuid();
--> statement-breakpoint
INSERT INTO "provider_connections" (
  "id", "user_id", "display_name", "api_format", "base_url", "encrypted_api_key",
  "encryption_iv", "encryption_auth_tag", "encryption_key_version", "enabled", "created_at", "updated_at"
)
SELECT
  "provider_connection_id", "user_id", "display_name" || ' connection', "api_format",
  CASE
    WHEN "api_format" = 'openai_compatible' THEN regexp_replace("endpoint", '/chat/completions/?$', '')
    ELSE regexp_replace("endpoint", '/v1/messages/?$', '')
  END,
  "encrypted_api_key",
  "encryption_iv", "encryption_auth_tag", "encryption_key_version", true, "created_at", "updated_at"
FROM "upstream_models";
--> statement-breakpoint
ALTER TABLE "upstream_models" ALTER COLUMN "provider_connection_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "upstream_models" ADD CONSTRAINT "upstream_models_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "upstream_models" DROP COLUMN "api_format";
--> statement-breakpoint
ALTER TABLE "upstream_models" DROP COLUMN "endpoint";
--> statement-breakpoint
ALTER TABLE "upstream_models" DROP COLUMN "encrypted_api_key";
--> statement-breakpoint
ALTER TABLE "upstream_models" DROP COLUMN "encryption_iv";
--> statement-breakpoint
ALTER TABLE "upstream_models" DROP COLUMN "encryption_auth_tag";
--> statement-breakpoint
ALTER TABLE "upstream_models" DROP COLUMN "encryption_key_version";
--> statement-breakpoint
CREATE INDEX "provider_connections_user_idx" ON "provider_connections" USING btree ("user_id");
