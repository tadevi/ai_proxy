import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { createDb } from './index.js';

// One-off backfill: (re)builds model_usage_daily from request_logs history.
// model_usage_daily is normally kept correct incrementally as requests are logged
// (see writeLog() in apps/server), so this only needs to run after restoring/importing
// request_logs, or if usage rows ever need to be reconciled from scratch.

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
  const result = await db.execute(sql`
    INSERT INTO model_usage_daily (
      user_id, upstream_model_id, usage_date, request_count, input_tokens, output_tokens
    )
    SELECT
      user_id,
      resolved_upstream_model_id,
      created_at::date,
      count(*)::bigint,
      coalesce(sum(input_tokens), 0)::bigint,
      coalesce(sum(output_tokens), 0)::bigint
    FROM request_logs
    WHERE resolved_upstream_model_id IS NOT NULL
    GROUP BY user_id, resolved_upstream_model_id, created_at::date
    ON CONFLICT (user_id, upstream_model_id, usage_date) DO UPDATE SET
      request_count = EXCLUDED.request_count,
      input_tokens = EXCLUDED.input_tokens,
      output_tokens = EXCLUDED.output_tokens
  `);
  console.log(`model_usage_daily backfilled (${result.rowCount ?? 0} rows affected).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  pool.end();
  process.exit(1);
});
