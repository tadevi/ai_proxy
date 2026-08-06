-- Keep binding-owned configuration authoritative while legacy dashboard and
-- provisioning code paths are migrated. New/updated binding routes may still
-- carry the duplicated columns during the rolling deployment; mirror those
-- values into the owning binding in the same transaction.

CREATE OR REPLACE FUNCTION sync_binding_config_from_route()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.binding_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE model_bindings
  SET
    display_name = NEW.display_name,
    upstream_model_id = NEW.upstream_model_id,
    api_format = NEW.api_format,
    provider_base_path = NEW.provider_base_path,
    request_path_override = NEW.request_path_override,
    context_length = NEW.context_length,
    max_output_tokens = NEW.max_output_tokens,
    supports_streaming = NEW.supports_streaming,
    supports_tools = NEW.supports_tools,
    supports_images = NEW.supports_images,
    supports_reasoning = NEW.supports_reasoning,
    updated_at = now()
  WHERE id = NEW.binding_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER binding_routes_sync_binding_config
AFTER INSERT OR UPDATE OF
  binding_id,
  display_name,
  upstream_model_id,
  api_format,
  provider_base_path,
  request_path_override,
  context_length,
  max_output_tokens,
  supports_streaming,
  supports_tools,
  supports_images,
  supports_reasoning
ON binding_routes
FOR EACH ROW
EXECUTE FUNCTION sync_binding_config_from_route();
