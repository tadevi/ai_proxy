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

const systemPresets = [
  { displayName: 'DeepSeek V4 Pro', upstreamModelId: 'deepseek-v4-pro', apiFormat: 'openai_compatible', supportsImages: 'no', supportsReasoning: 'yes', maxOutputTokens: 65536 },
  { displayName: 'Mimo 2.5', upstreamModelId: 'mimo-v2.5', apiFormat: 'openai_compatible', supportsImages: 'yes', supportsReasoning: 'no', maxOutputTokens: 8192 },
  { displayName: 'Mimo 2.5 Pro', upstreamModelId: 'mimo-v2.5-pro', apiFormat: 'openai_compatible', supportsImages: 'no', supportsReasoning: 'yes', maxOutputTokens: 16384 },
];

await db.execute(sql`DELETE FROM model_presets WHERE user_id IS NULL`);

for (const preset of systemPresets) {
  await db.execute(sql`
    INSERT INTO model_presets (user_id, display_name, upstream_model_id, api_format, supports_images, supports_reasoning, max_output_tokens)
    VALUES (NULL, ${preset.displayName}, ${preset.upstreamModelId}, ${preset.apiFormat}::api_format, ${preset.supportsImages}::capability, ${preset.supportsReasoning}::capability, ${preset.maxOutputTokens})
    ON CONFLICT DO NOTHING
  `);
}

console.log(`Seeded ${systemPresets.length} system presets.`);
await pool.end();
