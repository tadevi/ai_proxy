CREATE TABLE "model_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"display_name" text NOT NULL,
	"upstream_model_id" text NOT NULL,
	"api_format" "api_format" NOT NULL,
	"supports_images" "capability" DEFAULT 'no' NOT NULL,
	"supports_reasoning" "capability" DEFAULT 'no' NOT NULL,
	"max_output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_presets" ADD CONSTRAINT "model_presets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_presets_user_idx" ON "model_presets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_presets_system_upstream_unique" ON "model_presets" ("upstream_model_id") WHERE "user_id" IS NULL;
