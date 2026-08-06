import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

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
export type Database = ReturnType<typeof createDb>['db'];
