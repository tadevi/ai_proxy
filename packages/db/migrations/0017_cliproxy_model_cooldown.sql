CREATE TABLE "cliproxy_model_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cliproxy_account_id" uuid NOT NULL,
	"upstream_model_id" text NOT NULL,
	"cooldown_until" timestamp with time zone,
	"latest_error" jsonb,
	"latest_error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cliproxy_model_states_account_model_unique" UNIQUE("cliproxy_account_id", "upstream_model_id")
);
--> statement-breakpoint
ALTER TABLE "cliproxy_model_states" ADD CONSTRAINT "cliproxy_model_states_cliproxy_account_id_cliproxy_accounts_id_fk" FOREIGN KEY ("cliproxy_account_id") REFERENCES "public"."cliproxy_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "cliproxy_model_states_cooldown_idx" ON "cliproxy_model_states" USING btree ("cliproxy_account_id", "upstream_model_id", "cooldown_until");
--> statement-breakpoint
ALTER TABLE "cliproxy_accounts" DROP COLUMN "cooldown_until";
--> statement-breakpoint
ALTER TABLE "cliproxy_accounts" DROP COLUMN "latest_error";
--> statement-breakpoint
ALTER TABLE "cliproxy_accounts" DROP COLUMN "latest_error_at";
