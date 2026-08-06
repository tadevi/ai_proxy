-- Complete the binding-owned configuration cutover.
-- All application readers and writers now use model_bindings for stable model/provider
-- configuration and binding_routes only for credential routing and runtime health.

DROP VIEW IF EXISTS upstream_models;

DROP TRIGGER IF EXISTS binding_routes_sync_binding_config ON binding_routes;
DROP FUNCTION IF EXISTS sync_binding_config_from_route();

ALTER TABLE binding_routes
  DROP COLUMN display_name,
  DROP COLUMN upstream_model_id,
  DROP COLUMN provider_connection_id,
  DROP COLUMN api_format,
  DROP COLUMN provider_base_path,
  DROP COLUMN request_path_override,
  DROP COLUMN context_length,
  DROP COLUMN max_output_tokens,
  DROP COLUMN supports_streaming,
  DROP COLUMN supports_tools,
  DROP COLUMN supports_images,
  DROP COLUMN supports_reasoning;
