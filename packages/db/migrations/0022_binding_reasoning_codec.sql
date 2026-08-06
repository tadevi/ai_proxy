CREATE TABLE "model_binding_reasoning_codecs" (
  "binding_id" uuid PRIMARY KEY NOT NULL,
  "codec" text DEFAULT 'auto' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_binding_reasoning_codecs_binding_id_model_bindings_id_fk"
    FOREIGN KEY ("binding_id") REFERENCES "public"."model_bindings"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "model_binding_reasoning_codecs_codec_check"
    CHECK ("codec" IN ('auto', 'reasoning_details', 'reasoning_content'))
);
