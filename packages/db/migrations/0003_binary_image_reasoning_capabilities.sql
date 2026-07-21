UPDATE "upstream_models" SET "supports_images" = 'no' WHERE "supports_images" = 'unknown';
--> statement-breakpoint
UPDATE "upstream_models" SET "supports_reasoning" = 'yes' WHERE "supports_reasoning" = 'unknown';
--> statement-breakpoint
ALTER TABLE "upstream_models" ALTER COLUMN "supports_images" SET DEFAULT 'no';
--> statement-breakpoint
ALTER TABLE "upstream_models" ALTER COLUMN "supports_reasoning" SET DEFAULT 'yes';
