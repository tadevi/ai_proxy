ALTER TABLE "upstream_models" ADD COLUMN "api_format" "api_format";
--> statement-breakpoint
ALTER TABLE "upstream_models" ADD COLUMN "provider_base_path" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "upstream_models" ADD COLUMN "request_path_override" text;
--> statement-breakpoint
UPDATE "upstream_models" AS model
SET
  "api_format" = connection."api_format",
  "provider_base_path" = regexp_replace(connection."base_url", '^https?://[^/]+', ''),
  "request_path_override" = connection."request_path_override"
FROM "provider_connections" AS connection
WHERE connection."id" = model."provider_connection_id";
--> statement-breakpoint
UPDATE "provider_connections"
SET "base_url" = regexp_replace("base_url", '^(https?://[^/]+).*$', '\1');
--> statement-breakpoint
ALTER TABLE "upstream_models" ALTER COLUMN "api_format" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_connections" DROP COLUMN "api_format";
--> statement-breakpoint
ALTER TABLE "provider_connections" DROP COLUMN "request_path_override";
