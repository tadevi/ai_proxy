DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM model_usage_daily usage
    LEFT JOIN binding_routes route ON route.id = usage.upstream_model_id
    WHERE route.binding_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot migrate model_usage_daily: one or more usage rows have no model binding';
  END IF;
END $$;

CREATE TABLE model_usage_daily_by_binding (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  binding_id uuid NOT NULL REFERENCES model_bindings(id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  request_count bigint NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_input_tokens bigint NOT NULL DEFAULT 0,
  cache_usage_reported_request_count bigint NOT NULL DEFAULT 0,
  CONSTRAINT model_usage_daily_unique UNIQUE (user_id, binding_id, usage_date)
);

INSERT INTO model_usage_daily_by_binding (
  user_id,
  binding_id,
  usage_date,
  request_count,
  input_tokens,
  output_tokens,
  cache_input_tokens,
  cache_usage_reported_request_count
)
SELECT
  usage.user_id,
  route.binding_id,
  usage.usage_date,
  sum(usage.request_count),
  sum(usage.input_tokens),
  sum(usage.output_tokens),
  sum(usage.cache_input_tokens),
  sum(usage.cache_usage_reported_request_count)
FROM model_usage_daily usage
JOIN binding_routes route ON route.id = usage.upstream_model_id
GROUP BY usage.user_id, route.binding_id, usage.usage_date;

DROP TABLE model_usage_daily;
ALTER TABLE model_usage_daily_by_binding RENAME TO model_usage_daily;
CREATE INDEX model_usage_daily_user_binding_idx
  ON model_usage_daily (user_id, binding_id);
