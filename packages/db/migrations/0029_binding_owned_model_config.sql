DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM binding_routes left_route
    JOIN binding_routes right_route
      ON right_route.binding_id = left_route.binding_id
     AND right_route.id <> left_route.id
    WHERE left_route.binding_id IS NOT NULL
      AND (
        left_route.upstream_model_id IS DISTINCT FROM right_route.upstream_model_id OR
        left_route.request_path_override IS DISTINCT FROM right_route.request_path_override OR
        left_route.context_length IS DISTINCT FROM right_route.context_length OR
        left_route.max_output_tokens IS DISTINCT FROM right_route.max_output_tokens OR
        left_route.supports_streaming IS DISTINCT FROM right_route.supports_streaming OR
        left_route.supports_tools IS DISTINCT FROM right_route.supports_tools OR
        left_route.supports_images IS DISTINCT FROM right_route.supports_images OR
        left_route.supports_reasoning IS DISTINCT FROM right_route.supports_reasoning
      )
  ) THEN
    RAISE EXCEPTION 'Cannot migrate model config: routes in the same binding have conflicting stable configuration';
  END IF;
END $$;

ALTER TABLE model_bindings
  ADD COLUMN display_name text,
  ADD COLUMN upstream_model_id text,
  ADD COLUMN request_path_override text,
  ADD COLUMN context_length integer,
  ADD COLUMN max_output_tokens integer,
  ADD COLUMN supports_streaming capability,
  ADD COLUMN supports_tools capability,
  ADD COLUMN supports_images capability,
  ADD COLUMN supports_reasoning capability;

UPDATE model_bindings binding
SET
  display_name = (
    SELECT preset.display_name
    FROM model_presets preset
    WHERE preset.id = binding.preset_id
  ),
  upstream_model_id = (
    SELECT route.upstream_model_id
    FROM binding_routes route
    WHERE route.binding_id = binding.id
    ORDER BY route.id
    LIMIT 1
  ),
  request_path_override = (
    SELECT route.request_path_override
    FROM binding_routes route
    WHERE route.binding_id = binding.id
    ORDER BY route.id
    LIMIT 1
  ),
  context_length = (
    SELECT route.context_length
    FROM binding_routes route
    WHERE route.binding_id = binding.id
    ORDER BY route.id
    LIMIT 1
  ),
  max_output_tokens = (
    SELECT route.max_output_tokens
    FROM binding_routes route
    WHERE route.binding_id = binding.id
    ORDER BY route.id
    LIMIT 1
  ),
  supports_streaming = (
    SELECT route.supports_streaming
    FROM binding_routes route
    WHERE route.binding_id = binding.id
    ORDER BY route.id
    LIMIT 1
  ),
  supports_tools = (
    SELECT route.supports_tools
    FROM binding_routes route
    WHERE route.binding_id = binding.id
    ORDER BY route.id
    LIMIT 1
  ),
  supports_images = (
    SELECT route.supports_images
    FROM binding_routes route
    WHERE route.binding_id = binding.id
    ORDER BY route.id
    LIMIT 1
  ),
  supports_reasoning = (
    SELECT route.supports_reasoning
    FROM binding_routes route
    WHERE route.binding_id = binding.id
    ORDER BY route.id
    LIMIT 1
  );

CREATE INDEX model_bindings_upstream_model_idx
  ON model_bindings (user_id, upstream_model_id);
