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
  { displayName: 'Claude Sonnet 4', upstreamModelId: 'claude-sonnet-4-20250514', apiFormat: 'anthropic_compatible', supportsImages: 'yes', supportsReasoning: 'yes', maxOutputTokens: 64000 },
  { displayName: 'Claude Opus 4', upstreamModelId: 'claude-opus-4-20250514', apiFormat: 'anthropic_compatible', supportsImages: 'yes', supportsReasoning: 'yes', maxOutputTokens: 32000 },
  { displayName: 'Claude Haiku 3.5', upstreamModelId: 'claude-3-5-haiku-20241022', apiFormat: 'anthropic_compatible', supportsImages: 'yes', supportsReasoning: 'no', maxOutputTokens: 8192 },
  { displayName: 'GPT-4o', upstreamModelId: 'gpt-4o', apiFormat: 'openai_compatible', supportsImages: 'yes', supportsReasoning: 'no', maxOutputTokens: 16384 },
  { displayName: 'GPT-4o-mini', upstreamModelId: 'gpt-4o-mini', apiFormat: 'openai_compatible', supportsImages: 'yes', supportsReasoning: 'no', maxOutputTokens: 16384 },
  { displayName: 'o3', upstreamModelId: 'o3', apiFormat: 'openai_compatible', supportsImages: 'yes', supportsReasoning: 'yes', maxOutputTokens: 100000 },
  { displayName: 'o4-mini', upstreamModelId: 'o4-mini', apiFormat: 'openai_compatible', supportsImages: 'yes', supportsReasoning: 'yes', maxOutputTokens: 100000 },
  { displayName: 'DeepSeek R1', upstreamModelId: 'deepseek-reasoner', apiFormat: 'openai_compatible', supportsImages: 'no', supportsReasoning: 'yes', maxOutputTokens: 65536 },
  { displayName: 'DeepSeek V3', upstreamModelId: 'deepseek-chat', apiFormat: 'openai_compatible', supportsImages: 'no', supportsReasoning: 'no', maxOutputTokens: 8192 },
  { displayName: 'Gemini 2.5 Pro', upstreamModelId: 'gemini-2.5-pro-preview-05-06', apiFormat: 'openai_compatible', supportsImages: 'yes', supportsReasoning: 'yes', maxOutputTokens: 65536 },
];

for (const preset of systemPresets) {
  await db.execute(sql`
    INSERT INTO model_presets (user_id, display_name, upstream_model_id, api_format, supports_images, supports_reasoning, max_output_tokens)
    VALUES (NULL, ${preset.displayName}, ${preset.upstreamModelId}, ${preset.apiFormat}::api_format, ${preset.supportsImages}::capability, ${preset.supportsReasoning}::capability, ${preset.maxOutputTokens})
    ON CONFLICT DO NOTHING
  `);
}

console.log(`Seeded ${systemPresets.length} system presets.`);
await pool.end();
