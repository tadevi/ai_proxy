# Binding route schema refactor

This draft tracks the in-progress database migration that separates stable model configuration from executable credential routes and runtime health.

## Target ownership

- `model_presets`: reusable model defaults
- `model_bindings`: resolved model/provider configuration
- `binding_routes`: one executable `(binding, credential)` route plus runtime health
- `transformation_rules`: owned by `model_bindings`
- `model_usage_daily`: aggregated by `model_bindings`
- `request_logs.binding_route_id`: optional reference to the route used for a request

## Migration constraints

- preserve existing UUIDs while renaming `upstream_models` to `binding_routes`
- backfill binding-owned configuration before dropping duplicated route columns
- preserve usage and request-log history when credentials/routes are deleted
- migrate server and dashboard queries in the same pull request
- keep the pull request in draft until migration, typecheck, build, and unit tests pass
