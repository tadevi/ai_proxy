# Architecture and UX Review Checklist

## P0 — Correctness and data integrity

- [x] Scope CLIProxy cooldown by account and model instead of the entire account.
  - [x] Add a model-level state table: `cliproxy_model_states`.
  - [x] Store `cliproxy_account_id` and the unprefixed `upstream_model_id`.
  - [x] Add a unique constraint on `(cliproxy_account_id, upstream_model_id)`.
  - [x] Store `cooldown_until`, `latest_error`, and `latest_error_at`.
  - [x] Update mapping-route and direct-model resolution to filter only the affected account/model pair.
  - [x] Remove the account-wide cooldown fields from `cliproxy_accounts`.

- [x] Change `upstream_models.binding_id` from `ON DELETE SET NULL` to `ON DELETE CASCADE`.
  - [x] Add migration `0019_binding_model_cascade.sql`.
  - [x] Remove redundant manual upstream-model cleanup in binding-delete and account-delete handlers.
  - [x] Verified no orphan models exist (`binding_id IS NULL` count = 0) before migration.
  - [x] Mapping routes, transformation rules, and usage rows cascade correctly via existing FKs.

- [x] Retire Drizzle snapshot generation for this project.
  - [x] Remove stale `*_snapshot.json` metadata and the `db:generate` script.
  - [x] Keep `meta/_journal.json`; the runtime migrator requires it to load reviewed SQL migrations.
  - [x] Use reviewed, explicit SQL migrations and append their journal entries manually.
  - [ ] If generated migrations are ever reconsidered, establish and verify a complete baseline in an isolated environment first.

## P1 — Explicit provider and connection identity

- [ ] Add a structured `kind` field to `provider_connections`.
  - [ ] Define values such as `direct` and `cliproxy`.
  - [ ] Add a migration and backfill the current CLIProxy connection.
  - [ ] Stop detecting CLIProxy by display name.
  - [ ] Stop detecting CLIProxy by comparing stored URLs.
  - [ ] Use `connection.kind` for binding validation.
  - [ ] Use `connection.kind` for request endpoint selection.
  - [ ] Allow users to rename the CLIProxy connection without changing runtime behavior.

- [ ] Add a structured provider field to `model_presets`.
  - [ ] Define supported values such as `codex`, `antigravity`, `claude`, and `direct`.
  - [ ] Backfill existing presets.
  - [ ] Stop inferring provider from `displayName.split('/')`.
  - [ ] Validate account-provider compatibility on the backend.
  - [ ] Prevent a Codex preset from being bound to an Antigravity account.
  - [ ] Filter account and preset choices in the UI using structured provider data.

- [ ] Review ownership guarantees across user-scoped tables.
  - [ ] Ensure a binding cannot reference another user's connection, preset, or CLIProxy account.
  - [ ] Ensure an upstream model cannot reference another user's token or binding.
  - [ ] Consider composite foreign keys or database constraints for cross-table ownership.
  - [ ] Keep backend ownership checks even if database constraints are added.

## P1 — CLIProxy synchronization and lifecycle

- [ ] Add compensation for failed CLIProxy upload workflows.
  - [ ] If DB insertion fails after remote upload, delete the uploaded remote auth file.
  - [ ] If prefix assignment fails, keep the existing orphan-file cleanup behavior.
  - [ ] Return a clear operator-facing error if compensation also fails.

- [ ] Improve failed CLIProxy delete workflows.
  - [ ] Decide how to handle DB cleanup failure after a successful remote deletion.
  - [ ] Add a reconciliation-needed state or operator warning.
  - [ ] Avoid silently showing a DB account whose remote auth file no longer exists.

- [ ] Add CLIProxy reconciliation support.
  - [ ] Compare `/v0/management/auth-files` against `cliproxy_accounts`.
  - [ ] Detect remote orphan files not represented in Passthrough.
  - [ ] Detect DB accounts whose remote files are missing.
  - [ ] Provide an operator endpoint or dashboard action to inspect differences.
  - [ ] Decide whether reconciliation should import, delete, or only report mismatches.

## P1 — Routing and fallback observability

- [ ] Add sanitized route-attempt history to request logs.
  - [ ] Add a `route_attempts JSONB` column or equivalent normalized table.
  - [ ] Record binding/model/account identifiers for each attempt.
  - [ ] Record HTTP status, error category, skip reason, and per-attempt latency.
  - [ ] Record the final successful attempt.
  - [ ] Avoid storing prompts, responses, credentials, or sensitive provider payloads.
  - [ ] Continue tracking `fallback_count` as the number of failed upstream attempts.
  - [ ] Distinguish attempted failures from routes skipped before an upstream call.

- [ ] Improve `skipped_routes` coverage.
  - [ ] Record model-level CLIProxy cooldown skips.
  - [ ] Record disabled accounts, tokens, connections, bindings, and models where useful.
  - [ ] Record image-capability skips without duplicate entries for the same logical route.
  - [ ] Decide whether UI should show skipped count separately from fallback count.

- [ ] Add a fallback-details view in Logs.
  - [ ] Make fallback count clickable.
  - [ ] Show attempt order, selected account, status, latency, and reason.
  - [ ] Show skipped routes separately from attempted routes.
  - [ ] Make it clear when a route was skipped without contacting the upstream provider.

## P1 — CLIProxy account UI/UX

- [x] Show the selected CLIProxy account in Connections → Model bindings.
  - [x] Show account label/email on each CLIProxy binding row.
  - [x] Show a shortened prefix with the full prefix in a tooltip.
  - [x] Ensure two bindings for the same preset but different accounts are clearly distinguishable.

- [x] Show cooldown and latest error state in the Account tab.
  - [x] Return model-level cooldown state from the API.
  - [x] Display the affected model.
  - [x] Display `cooldown_until` in local time.
  - [x] Display the sanitized latest error retained by the gateway.
  - [x] Show available/cooling status clearly.

- [x] Use the existing model Test button as the explicit Retry now action.
  - [x] Test bypasses local cooldown filtering and performs a real upstream request.
  - [x] A successful Test clears cooldown for only the exact CLIProxy account/model pair.
  - [x] A matching CLIProxy cooldown response sets or extends that model-level cooldown.
  - [x] Test does not clear cooldown for another model or another account.
  - [ ] Show in the UI that Test also acts as Retry now while the model is cooling down.

- [ ] Improve the bind-presets flow.
  - [ ] Keep account selection mandatory for CLIProxy connections.
  - [ ] Disable Bind until an account is selected.
  - [ ] Filter presets by structured provider field.
  - [ ] Show how many model instances will be created.
  - [ ] Show already-bound preset/account combinations.
  - [ ] Clearly support binding the same preset to multiple accounts.

## P1 — Automated tests

- [ ] Add integration tests for CLIProxy account isolation.
  - [ ] User A cannot bind User B's account.
  - [ ] User A cannot delete User B's account.
  - [ ] User A cannot see User B's account in account-selection APIs.

- [ ] Add integration tests for multiple accounts of one provider.
  - [ ] The same preset can bind to Codex A and Codex B.
  - [ ] Each binding creates the correct prefixed upstream model ID.
  - [ ] Mappings can include either or both account-specific bindings.
  - [ ] Deleting Codex A preserves Codex B models and routes.

- [ ] Add integration tests for cooldown behavior.
  - [ ] The first matching CLIProxy 429 stores model-level cooldown.
  - [ ] A subsequent request skips only that account/model route.
  - [ ] Another model on the same account remains eligible.
  - [ ] Another account serving the same model remains eligible.
  - [ ] Expired cooldown makes the route eligible again.
  - [ ] Non-matching 429 errors do not incorrectly create CLIProxy cooldown state.

- [ ] Add integration tests for deletion and cascades.
  - [ ] Deleting a binding removes associated upstream models.
  - [ ] Deleting an account removes only its bindings, models, mapping routes, rules, and usage.
  - [ ] No orphan upstream model remains routable.

- [ ] Add tests for fallback logging.
  - [ ] Failed attempts are recorded in order.
  - [ ] Successful final attempt is recorded.
  - [ ] Skipped routes are not counted as upstream attempts.
  - [ ] `fallback_count` matches the number of failed upstream calls.

## P2 — Operations and health

- [ ] Add an operator-facing integration status endpoint.
  - [ ] Report PostgreSQL connectivity.
  - [ ] Report CLIProxy runtime/API reachability.
  - [ ] Report management API authentication status.
  - [ ] Report remote/DB account reconciliation counts.
  - [ ] Keep the existing lightweight `/health` endpoint suitable for Render health checks.

- [ ] Improve request-log cleanup operations.
  - [ ] Keep the current startup and six-hour cleanup behavior.
  - [ ] Add an index on `request_logs.created_at` if one is not already present.
  - [ ] Expose the effective `LOG_RETENTION_DAYS` in operator status/config UI.
  - [ ] Consider batching deletions if request-log volume grows significantly.

- [ ] Define retention for aggregate usage data.
  - [ ] Decide whether `model_usage_daily` is retained forever or for a configurable duration.
  - [ ] Preserve enough history for useful reporting.
  - [ ] Document the storage-growth expectation.

- [ ] Add monitoring for background cleanup and persistence failures.
  - [ ] Track request-log cleanup failures.
  - [ ] Track CLIProxy reconciliation failures.
  - [ ] Track config/auth persistence failures.
  - [ ] Avoid relying only on console logs for recurring operational failures.

## P2 — Backend architecture and maintainability

- [ ] Split `dashboard.ts` into focused modules.
  - [ ] Authentication/account routes.
  - [ ] Connection and token routes.
  - [ ] CLIProxy account routes.
  - [ ] Preset and binding routes.
  - [ ] Mapping routes.
  - [ ] Logs and usage routes.

- [ ] Split `gateway.ts` into focused services.
  - [ ] Request parsing and validation.
  - [ ] Candidate resolution.
  - [ ] Route eligibility and cooldown policy.
  - [ ] Upstream execution.
  - [ ] Fallback orchestration.
  - [ ] Usage and request-log persistence.

- [ ] Centralize provider/connection policy.
  - [ ] One helper for connection kind.
  - [ ] One helper for provider/account compatibility.
  - [ ] One helper for cooldown classification.
  - [ ] One helper for sanitized provider errors.
  - [ ] Avoid repeating URL/name/provider inference across routes.

- [ ] Simplify deletion behavior around database cascades.
  - [ ] Prefer database-enforced cascades for local relational cleanup.
  - [ ] Keep explicit remote CLIProxy deletion separate from local relational deletion.
  - [ ] Document deletion order and compensation behavior.

## P2 — Database performance and consistency

- [ ] Review and add missing indexes based on query patterns.
  - [ ] `request_logs(created_at)` for retention cleanup.
  - [ ] `cliproxy_model_states(cliproxy_account_id, upstream_model_id, cooldown_until)`.
  - [ ] `model_bindings(cliproxy_account_id)` for deletion and resolution joins.
  - [ ] Confirm existing mapping, model, token, and usage indexes match resolver queries.

- [ ] Review timestamp maintenance.
  - [ ] Ensure `updated_at` is updated consistently for every mutable table.
  - [ ] Consider database triggers only if application-level updates remain inconsistent.

- [ ] Review nullable foreign keys.
  - [ ] Remove legacy nullable paths when backward compatibility is no longer required.
  - [ ] Decide whether manually created `upstream_models` without bindings remain supported.
  - [ ] Tighten constraints after legacy data has been migrated.

## P3 — Optional UI polish

- [ ] Make responsive tables usable on narrow screens.
  - [ ] Keep full values available through tooltips.
  - [ ] Avoid truncating the most important binding/account identity first.
  - [ ] Consider a stacked card layout on mobile.

- [ ] Improve empty and disabled states.
  - [ ] Explain when no compatible presets exist for the selected account.
  - [ ] Explain when no account has been uploaded for a CLIProxy provider.
  - [ ] Link users directly to the Account tab to upload an auth JSON.

- [ ] Improve destructive-action confirmations.
  - [ ] Explain which bindings, upstream models, and mappings will be removed.
  - [ ] Show the exact account label and prefix.
  - [ ] Warn when deleting an account currently used in active mappings.

- [x] Add accessible modal behavior.
  - [x] Trap focus inside modals.
  - [x] Close on Escape.
  - [x] Restore focus to the opening button.
  - [x] Add `aria-labelledby` and an accessible modal title.

## Suggested execution order

- [ ] Phase 1: model-level cooldown, cascade FK, migration snapshots.
- [ ] Phase 2: explicit connection kind and preset provider with backend validation.
- [ ] Phase 3: account/model cooldown UI and account identity in binding rows.
- [ ] Phase 4: route-attempt logging and fallback-details UI.
- [ ] Phase 5: integration tests for isolation, cooldown, fallback, and deletion.
- [ ] Phase 6: reconciliation/status tooling and backend module cleanup.
