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

export async function handleTokenDeleteRequest(request: Request, env: DashboardWriteEnv) {
  if (request.method !== 'DELETE') return undefined;
  const match = new URL(request.url).pathname.match(/^\/api\/connections\/([^/]+)\/tokens\/([^/]+)$/);
  if (!match) return undefined;

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

    const connection = await client.query<{ base_url: string }>(
      'SELECT base_url FROM provider_connections WHERE id = $1 AND user_id = $2 LIMIT 1',
      [match[1], user.id],
    );
    if (!connection.rows[0]) return json({ error: 'Provider connection not found' }, 404);
    const cliproxyBase = env.CLIPROXY_BASE_URL?.replace(/\/$/, '');
    if (cliproxyBase && connection.rows[0].base_url.replace(/\/$/, '') === cliproxyBase) {
      return json({ error: 'CLIProxyAPI credentials are managed by the server' }, 403);
    }

    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM binding_routes WHERE token_id = $1 AND user_id = $2', [match[2], user.id]);
      const deleted = await client.query(
        'DELETE FROM connection_tokens WHERE id = $1 AND connection_id = $2 AND user_id = $3 RETURNING id',
        [match[2], match[1], user.id],
      );
      if (!deleted.rows[0]) {
        await client.query('ROLLBACK');
        return json({ error: 'Token not found' }, 404);
      }
      await client.query('COMMIT');
      return json({ ok: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}
