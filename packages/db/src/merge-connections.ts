import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { createDb } from './index.js';

const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const caPath = process.env.DATABASE_SSL_CA_PATH;
const certPath = process.env.DATABASE_SSL_CERT_PATH;
const keyPath = process.env.DATABASE_SSL_KEY_PATH;
if (Boolean(certPath) !== Boolean(keyPath)) {
  throw new Error('DATABASE_SSL_CERT_PATH and DATABASE_SSL_KEY_PATH must be set together');
}
const ssl =
  caPath || certPath
    ? {
        rejectUnauthorized: true,
        ...(caPath ? { ca: readFileSync(caPath, 'utf8') } : {}),
        ...(certPath && keyPath
          ? { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') }
          : {}),
      }
    : undefined;
const { db, pool } = createDb(url, ssl);

async function main() {
  // 1. Find all connections grouped by normalized base_url
  const allConnections = await db.execute(sql`
    SELECT pc.id, pc.user_id, pc.display_name, pc.base_url, pc.enabled
    FROM provider_connections pc
    ORDER BY pc.base_url, pc.display_name
  `);

  const byUrl = new Map<string, typeof allConnections.rows>();
  for (const row of allConnections.rows) {
    const normalizedUrl = (row.base_url as string).replace(/\/+$/, '');
    if (!byUrl.has(normalizedUrl)) byUrl.set(normalizedUrl, []);
    byUrl.get(normalizedUrl)!.push(row);
  }

  let mergeCount = 0;

  for (const [baseUrl, conns] of byUrl) {
    if (conns.length <= 1) continue;

    console.log(`\nMerging ${conns.length} connections for ${baseUrl}:`);
    for (const c of conns) {
      console.log(`  - "${c.display_name}" (id: ${c.id})`);
    }

    // Keep the first enabled connection, or the first one if all disabled.
    // conns.length >= 2 here (guarded above), so conns[0] is always defined.
    const keep = conns.find((c) => c.enabled) ?? conns[0]!;
    const remove = conns.filter((c) => c.id !== keep.id);

    console.log(`  → Keeping: "${keep.display_name}" (${keep.id})`);
    console.log(`  → Removing: ${remove.map((c) => `"${c.display_name}"`).join(', ')}`);

    for (const dead of remove) {
      // Move tokens from dead connection to kept connection
      // First, rename tokens if name conflicts
      const deadTokens = await db.execute(sql`
        SELECT id, name FROM connection_tokens WHERE connection_id = ${dead.id as string}
      `);
      const keepTokens = await db.execute(sql`
        SELECT name FROM connection_tokens WHERE connection_id = ${keep.id as string}
      `);
      const keepNames = new Set(keepTokens.rows.map((t) => t.name));

      for (const token of deadTokens.rows) {
        let newName = token.name as string;
        if (keepNames.has(newName)) {
          newName = `${newName} (from ${dead.display_name})`;
          // If still conflicts, add number
          if (keepNames.has(newName)) {
            let i = 2;
            while (keepNames.has(`${newName} ${i}`)) i++;
            newName = `${newName} ${i}`;
          }
        }
        keepNames.add(newName);

        await db.execute(sql`
          UPDATE connection_tokens
          SET connection_id = ${keep.id as string}, name = ${newName}, updated_at = now()
          WHERE id = ${token.id as string}
        `);
        console.log(`    Moved token "${token.name}" → "${newName}"`);
      }

      // Move upstream_models from dead connection to kept connection
      // If a model with the same upstream_model_id already exists on the kept connection, delete the duplicate
      const deadModels = await db.execute(sql`
        SELECT id, display_name, upstream_model_id FROM upstream_models WHERE provider_connection_id = ${dead.id as string}
      `);
      let movedCount = 0;
      let deletedCount = 0;
      for (const model of deadModels.rows) {
        // Check if kept connection already has this upstream_model_id
        const existing = await db.execute(sql`
          SELECT id FROM upstream_models
          WHERE provider_connection_id = ${keep.id as string}
            AND upstream_model_id = ${model.upstream_model_id as string}
        `);
        if (existing.rows.length > 0) {
          // Delete the duplicate (mapping_routes will cascade)
          await db.execute(sql`DELETE FROM upstream_models WHERE id = ${model.id as string}`);
          deletedCount++;
        } else {
          // Move to kept connection
          const newName = (model.display_name as string)
            .replace(/\s*\([^)]*\)\s*$/, ` (${keep.display_name})`);
          await db.execute(sql`
            UPDATE upstream_models
            SET provider_connection_id = ${keep.id as string},
                display_name = ${newName},
                updated_at = now()
            WHERE id = ${model.id as string}
          `);
          movedCount++;
        }
      }
      if (movedCount > 0 || deletedCount > 0) {
        console.log(`    Models: ${movedCount} moved, ${deletedCount} deleted (duplicate)`);
      }

      // Move model_bindings from dead connection to kept connection
      await db.execute(sql`
        UPDATE model_bindings
        SET connection_id = ${keep.id as string}, updated_at = now()
        WHERE connection_id = ${dead.id as string}
      `);

      // Delete the dead connection (cascade deletes remaining tokens, etc.)
      await db.execute(sql`DELETE FROM provider_connections WHERE id = ${dead.id as string}`);
      console.log(`  → Deleted "${dead.display_name}"`);
      mergeCount++;
    }
  }

  if (mergeCount === 0) {
    console.log('\nNo duplicate connections found. Nothing to merge.');
  } else {
    console.log(`\nDone. Merged ${mergeCount} duplicate connections.`);
  }

  // Show final state
  const final = await db.execute(sql`
    SELECT
      pc.display_name, pc.base_url,
      (SELECT count(*)::int FROM connection_tokens ct WHERE ct.connection_id = pc.id) as tokens,
      (SELECT count(*)::int FROM upstream_models um WHERE um.provider_connection_id = pc.id) as models
    FROM provider_connections pc
    ORDER BY pc.display_name
  `);
  console.log('\nFinal connections:');
  for (const row of final.rows) {
    console.log(`  ${row.display_name} | ${row.base_url} | tokens: ${row.tokens} | models: ${row.models}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  pool.end();
  process.exit(1);
});
