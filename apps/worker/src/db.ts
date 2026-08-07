import { createDbClient } from '../../../packages/db/src/index.js';

export interface WorkerDbEnv {
  DATABASE_URL?: string;
  HYPERDRIVE?: {
    connectionString: string;
  };
}

export async function checkDatabase(env: WorkerDbEnv) {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connectionString) {
    return {
      ok: false as const,
      status: 503,
      error: 'database_not_configured',
      message: 'Set DATABASE_URL or bind Hyperdrive as HYPERDRIVE.',
    };
  }

  const client = createDbClient(connectionString);
  const startedAt = Date.now();
  try {
    await client.connect();
    await client.query('select 1');
    return {
      ok: true as const,
      status: 200,
      latencyMs: Date.now() - startedAt,
      connection: env.HYPERDRIVE ? 'hyperdrive' : 'database_url',
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}
