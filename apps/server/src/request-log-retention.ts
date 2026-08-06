import { sql } from 'drizzle-orm';
import { requestLogs } from '@gateway/db';
import type { FastifyInstance } from 'fastify';

export const REQUEST_LOG_LIMIT_PER_USER = 500;
const CLEANUP_INTERVAL_MS = 10 * 60_000;

let nextCleanupAt = 0;
let cleanupInFlight: Promise<void> | null = null;

export async function pruneRequestLogs(app: Pick<FastifyInstance, 'db' | 'config'>) {
  const cutoff = new Date(Date.now() - app.config.LOG_RETENTION_DAYS * 86_400_000);

  await app.db.delete(requestLogs).where(sql`${requestLogs.createdAt} < ${cutoff}`);
  await app.db.execute(sql`
    DELETE FROM request_logs
    WHERE id IN (
      SELECT id
      FROM (
        SELECT
          id,
          row_number() OVER (
            PARTITION BY user_id
            ORDER BY created_at DESC, id DESC
          ) AS row_number
        FROM request_logs
      ) ranked
      WHERE ranked.row_number > ${REQUEST_LOG_LIMIT_PER_USER}
    )
  `);
}

export function maybePruneRequestLogs(app: Pick<FastifyInstance, 'db' | 'config'>) {
  const now = Date.now();
  if (now < nextCleanupAt || cleanupInFlight) return cleanupInFlight;

  nextCleanupAt = now + CLEANUP_INTERVAL_MS;
  cleanupInFlight = pruneRequestLogs(app).finally(() => {
    cleanupInFlight = null;
  });
  return cleanupInFlight;
}
