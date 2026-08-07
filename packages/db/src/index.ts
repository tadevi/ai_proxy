import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import * as bindingSchema from './binding-schema.js';
import * as runtimeSchema from './runtime-schema.js';

export function createDb(url: string, ssl?: pg.PoolConfig['ssl']) {
  const pool = new pg.Pool({
    connectionString: ssl ? withoutSslUrlParameters(url) : url,
    max: 10,
    ...(ssl ? { ssl } : {}),
  });
  return {
    db: drizzle(pool, { schema: { ...schema, ...bindingSchema, ...runtimeSchema } }),
    pool,
  };
}

export function createDbClient(url: string, ssl?: pg.ConnectionConfig['ssl']) {
  return new pg.Client({
    connectionString: ssl ? withoutSslUrlParameters(url) : url,
    ...(ssl ? { ssl } : {}),
  });
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
export * from './binding-schema.js';
export * from './runtime-schema.js';
export type Database = ReturnType<typeof createDb>['db'];
