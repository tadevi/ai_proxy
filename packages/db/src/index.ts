import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as coreSchema from './schema.js';
import * as reasoningCodecSchema from './reasoning-codec-schema.js';

const schema = { ...coreSchema, ...reasoningCodecSchema };

export function createDb(url: string, ssl?: pg.PoolConfig['ssl']) {
  const pool = new pg.Pool({
    connectionString: ssl ? withoutSslUrlParameters(url) : url,
    max: 10,
    ...(ssl ? { ssl } : {}),
  });
  return { db: drizzle(pool, { schema }), pool };
}

function withoutSslUrlParameters(value: string) {
  const url = new URL(value);
  for (const parameter of [
    'sslmode',
    'sslrootcert',
    'sslcert',
    'sslkey',
    'sslpassword',
    'sslnegotiation',
    'uselibpqcompat',
  ]) {
    url.searchParams.delete(parameter);
  }
  return url.toString();
}
export * from './schema.js';
export * from './reasoning-codec-schema.js';
export type Database = ReturnType<typeof createDb>['db'];
