import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type MigrationJournal = {
  entries: Array<{ idx: number; tag: string }>;
};

const migrationsDir = resolve(process.cwd(), 'packages/db/migrations');
const readMigration = (tag: string) =>
  readFileSync(resolve(migrationsDir, `${tag}.sql`), 'utf8');

describe('Drizzle migration metadata', () => {
  it('registers every SQL migration in the journal and has no orphan journal entries', () => {
    const journalPath = resolve(migrationsDir, 'meta/_journal.json');
    const sqlTags = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.slice(0, -4))
      .sort();
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as MigrationJournal;
    const journalTags = journal.entries.map((entry) => entry.tag).sort();

    expect(journalTags).toEqual(sqlTags);
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index),
    );
  });

  it('keeps binding-route UUIDs stable during the table rename', () => {
    const sql = readMigration('0025_rename_upstream_models_to_binding_routes');

    expect(sql).toContain('ALTER TABLE "upstream_models" RENAME TO "binding_routes"');
    expect(sql).not.toMatch(/INSERT INTO\s+"?binding_routes"?/i);
    expect(sql).not.toMatch(/DELETE FROM\s+"?binding_routes"?/i);
  });

  it('backfills transformation-rule ownership from the existing route binding', () => {
    const sql = readMigration('0026_binding_owned_transformation_rules');

    expect(sql).toContain('SET "binding_id" = routes."binding_id"');
    expect(sql).toContain('rules."upstream_model_id" = routes."id"');
    expect(sql).toContain('FOREIGN KEY ("binding_id")');
  });

  it('fails closed for unmapped usage and preserves totals when grouping by binding', () => {
    const sql = readMigration('0027_binding_owned_model_usage');

    expect(sql).toContain("RAISE EXCEPTION 'Cannot migrate model_usage_daily");
    expect(sql).toContain('sum(usage.request_count)');
    expect(sql).toContain('sum(usage.input_tokens)');
    expect(sql).toContain('sum(usage.output_tokens)');
    expect(sql).toContain('sum(usage.cache_input_tokens)');
    expect(sql).toContain('GROUP BY usage.user_id, route.binding_id, usage.usage_date');
    expect(sql.indexOf('INSERT INTO model_usage_daily_by_binding')).toBeLessThan(
      sql.indexOf('DROP TABLE model_usage_daily'),
    );
    expect(sql).toContain('CONSTRAINT model_usage_daily_by_binding_unique UNIQUE');
    expect(sql).toContain(
      'RENAME CONSTRAINT model_usage_daily_by_binding_unique TO model_usage_daily_unique',
    );
    expect(sql.indexOf('DROP TABLE model_usage_daily')).toBeLessThan(
      sql.indexOf('RENAME CONSTRAINT model_usage_daily_by_binding_unique'),
    );
  });

  it('allows credential-specific route labels while backfilling stable binding config', () => {
    const sql = readMigration('0029_binding_owned_model_config');
    const conflictCheck = sql.slice(0, sql.indexOf('ALTER TABLE model_bindings'));

    expect(conflictCheck).not.toContain('left_route.display_name');
    expect(sql).toContain('SELECT preset.display_name');
    expect(sql).toContain('WHERE preset.id = binding.preset_id');
    expect(sql).toContain('left_route.upstream_model_id IS DISTINCT FROM right_route.upstream_model_id');
  });

  it('requires all binding-owned model config before application cutover', () => {
    const sql = readMigration('0030_require_binding_owned_model_config');

    expect(sql).toContain("RAISE EXCEPTION 'Cannot require binding-owned model config");
    for (const column of [
      'display_name',
      'upstream_model_id',
      'supports_streaming',
      'supports_tools',
      'supports_images',
      'supports_reasoning',
    ]) {
      expect(sql).toContain(`ALTER COLUMN ${column} SET NOT NULL`);
    }
  });

  it('removes the compatibility layer and stable config from binding routes', () => {
    const sql = readMigration('0032_drop_legacy_route_config');

    expect(sql.indexOf('DROP VIEW IF EXISTS upstream_models')).toBeLessThan(
      sql.indexOf('ALTER TABLE binding_routes'),
    );
    expect(sql).toContain(
      'DROP TRIGGER IF EXISTS binding_routes_sync_binding_config ON binding_routes',
    );
    expect(sql).toContain('DROP FUNCTION IF EXISTS sync_binding_config_from_route()');

    for (const column of [
      'display_name',
      'upstream_model_id',
      'provider_connection_id',
      'api_format',
      'provider_base_path',
      'request_path_override',
      'context_length',
      'max_output_tokens',
      'supports_streaming',
      'supports_tools',
      'supports_images',
      'supports_reasoning',
    ]) {
      expect(sql).toContain(`DROP COLUMN ${column}`);
    }
  });
});
