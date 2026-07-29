ALTER TABLE "upstream_models" DROP CONSTRAINT "upstream_models_binding_id_model_bindings_id_fk";
--> statement-breakpoint
ALTER TABLE "upstream_models" ADD CONSTRAINT "upstream_models_binding_id_model_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."model_bindings"("id") ON DELETE cascade ON UPDATE no action;
