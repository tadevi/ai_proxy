ALTER TABLE model_bindings
  ALTER COLUMN display_name DROP NOT NULL,
  ALTER COLUMN upstream_model_id DROP NOT NULL,
  ALTER COLUMN supports_streaming DROP NOT NULL,
  ALTER COLUMN supports_tools DROP NOT NULL,
  ALTER COLUMN supports_images DROP NOT NULL,
  ALTER COLUMN supports_reasoning DROP NOT NULL;
