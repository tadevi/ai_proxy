import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
await migrate(db, { migrationsFolder: 'packages/db/migrations' });
console.log('Database migrations completed.');
await pool.end();
