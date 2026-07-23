CREATE TABLE "cliproxy_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"prefix" text NOT NULL,
	"file_name" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cliproxy_accounts_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
ALTER TABLE "cliproxy_accounts" ADD CONSTRAINT "cliproxy_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cliproxy_accounts_user_idx" ON "cliproxy_accounts" USING btree ("user_id");