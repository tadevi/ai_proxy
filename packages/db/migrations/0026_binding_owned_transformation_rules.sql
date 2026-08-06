ALTER TABLE "transformation_rules"
ADD COLUMN "binding_id" uuid;
--> statement-breakpoint
UPDATE "transformation_rules" AS rules
SET "binding_id" = routes."binding_id"
FROM "binding_routes" AS routes
WHERE rules."upstream_model_id" = routes."id"
  AND routes."binding_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "transformation_rules"
ADD CONSTRAINT "transformation_rules_binding_id_model_bindings_id_fk"
FOREIGN KEY ("binding_id") REFERENCES "public"."model_bindings"("id")
ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "transformation_rules_binding_idx"
ON "transformation_rules" USING btree ("binding_id", "position");
