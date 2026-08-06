-- Phase 1: give the executable (binding x credential) relation its domain name.
--
-- PostgreSQL automatically rewrites existing foreign-key references to the renamed
-- table, so transformation rules and usage aggregates continue to reference the
-- same rows and UUIDs. The compatibility view keeps the current application code
-- deployable while imports and query paths are migrated in follow-up commits in
-- this pull request.

ALTER TABLE "upstream_models" RENAME TO "binding_routes";

CREATE VIEW "upstream_models" AS
SELECT *
FROM "binding_routes";
