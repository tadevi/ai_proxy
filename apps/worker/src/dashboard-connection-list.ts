import { createHash } from 'node:crypto';
import { createDbClient } from '../../../packages/db/src/index.js';
import type { DashboardWriteEnv } from './dashboard-write.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

function sessionToken(request: Request) {
  const cookie = request.headers.get('cookie');
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === 'gateway_session') return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export async function handleConnectionListRequest(request: Request, env: DashboardWriteEnv) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/connections' || request.method !== 'GET') return undefined;

  const token = sessionToken(request);
  if (!token) return json({ error: 'Authentication required' }, 401);
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connectionString) return json({ error: 'Database is not configured' }, 503);

  const client = createDbClient(connectionString);
  try {
    await client.connect();
    const userResult = await client.query<{ id: string }>(
      `SELECT u.id
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > NOW()
        LIMIT 1`,
      [hashSecret(token)],
    );
    const user = userResult.rows[0];
    if (!user) return json({ error: 'Authentication required' }, 401);

    const rows = await client.query(
      `SELECT id, display_name AS "displayName", base_url AS "baseUrl", enabled,
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM provider_connections
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [user.id],
    );
    const cliproxyBase = env.CLIPROXY_BASE_URL?.replace(/\/$/, '');
    return json(
      rows.rows.map((row: any) => ({
        ...row,
        isCliproxy: !!cliproxyBase && String(row.baseUrl).replace(/\/$/, '') === cliproxyBase,
      })),
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
