DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM model_bindings
    WHERE display_name IS NULL
       OR upstream_model_id IS NULL
       OR supports_streaming IS NULL
       OR supports_tools IS NULL
       OR supports_images IS NULL
       OR supports_reasoning IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot require binding-owned model config: one or more bindings were not backfilled';
  END IF;
END $$;

ALTER TABLE model_bindings
  ALTER COLUMN display_name SET NOT NULL,
  ALTER COLUMN upstream_model_id SET NOT NULL,
  ALTER COLUMN supports_streaming SET NOT NULL,
  ALTER COLUMN supports_tools SET NOT NULL,
  ALTER COLUMN supports_images SET NOT NULL,
  ALTER COLUMN supports_reasoning SET NOT NULL;
