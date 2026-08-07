import { createHash, randomBytes } from 'node:crypto';
import { createDbClient } from '../../../packages/db/src/index.js';
import type { WorkerDbEnv } from './db.js';

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');
const randomToken = (prefix: string) => prefix + randomBytes(32).toString('base64url');

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get('cookie');
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

async function withClient<T>(env: WorkerDbEnv, fn: (client: ReturnType<typeof createDbClient>) => Promise<T>) {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connectionString) throw new Error('Database is not configured');
  const client = createDbClient(connectionString);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function dashboardUser(request: Request, env: WorkerDbEnv) {
  const token = cookieValue(request, 'gateway_session');
  if (!token) return undefined;
  return withClient(env, async (client) => {
    const result = await client.query<{ id: string; username: string }>(
      `SELECT u.id, u.username
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.expires_at > NOW()
        LIMIT 1`,
      [hashSecret(token)],
    );
    return result.rows[0];
  });
}

async function bodyObject(request: Request) {
  try {
    const value = await request.json();
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export async function handleDashboardApiRequest(request: Request, env: WorkerDbEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return undefined;
  if (url.pathname === '/api/auth/login' || url.pathname === '/api/auth/logout' || url.pathname === '/api/me') return undefined;

  const user = await dashboardUser(request, env);
  if (!user) return json({ error: 'Authentication required' }, 401);

  if (url.pathname === '/api/connections' && request.method === 'GET') {
    const rows = await withClient(env, (client) => client.query(
      `SELECT id, display_name AS "displayName", base_url AS "baseUrl", enabled,
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM provider_connections
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [user.id],
    ));
    return json(rows.rows);
  }

  if (url.pathname === '/api/bindings' && request.method === 'GET') {
    const rows = await withClient(env, (client) => client.query(
      `SELECT mb.id,
              mb.preset_id AS "presetId",
              mp.display_name AS "presetDisplayName",
              mp.upstream_model_id AS "presetUpstreamModelId",
              mb.connection_id AS "connectionId",
              pc.display_name AS "connectionName",
              mb.api_format AS "apiFormat",
              mb.provider_base_path AS "providerBasePath",
              mb.cliproxy_account_id AS "cliproxyAccountId",
              ca.label AS "cliproxyAccountLabel",
              ca.prefix AS "cliproxyAccountPrefix",
              mb.created_at AS "createdAt"
         FROM model_bindings mb
         JOIN model_presets mp ON mp.id = mb.preset_id
         JOIN provider_connections pc ON pc.id = mb.connection_id
         LEFT JOIN cliproxy_accounts ca ON ca.id = mb.cliproxy_account_id
        WHERE mb.user_id = $1
        ORDER BY mb.created_at DESC`,
      [user.id],
    ));
    return json(rows.rows);
  }

  if (url.pathname === '/api/models' && request.method === 'GET') {
    const rows = await withClient(env, (client) => client.query(
      `SELECT br.id,
              mb.display_name AS "displayName",
              mb.upstream_model_id AS "upstreamModelId",
              mb.connection_id AS "providerConnectionId",
              pc.display_name AS "providerConnectionName",
              br.binding_id AS "bindingId",
              br.token_id AS "tokenId",
              ct.name AS "tokenName",
              ca.label AS "cliproxyAccountLabel",
              ca.prefix AS "cliproxyAccountPrefix",
              ct.enabled AS "tokenEnabled",
              ct.cooldown_until AS "tokenCooldownUntil",
              mb.api_format AS "apiFormat",
              mb.provider_base_path AS "providerBasePath",
              mb.request_path_override AS "requestPathOverride",
              pc.enabled AS "providerEnabled",
              br.enabled,
              mb.max_output_tokens AS "maxOutputTokens",
              mb.supports_streaming AS "supportsStreaming",
              mb.supports_tools AS "supportsTools",
              mb.supports_images AS "supportsImages",
              mb.supports_reasoning AS "supportsReasoning",
              br.latest_test_status AS "latestTestStatus",
              br.latest_error AS "latestError",
              br.latest_error_at AS "latestErrorAt"
         FROM binding_routes br
         JOIN model_bindings mb ON mb.id = br.binding_id
         JOIN provider_connections pc ON pc.id = mb.connection_id
         LEFT JOIN connection_tokens ct ON ct.id = br.token_id
         LEFT JOIN cliproxy_accounts ca ON ca.id = mb.cliproxy_account_id
        WHERE mb.user_id = $1
        ORDER BY br.created_at DESC`,
      [user.id],
    ));
    return json(rows.rows);
  }

  if (url.pathname === '/api/presets' && request.method === 'GET') {
    const rows = await withClient(env, (client) => client.query(
      `SELECT id, user_id AS "userId", display_name AS "displayName",
              upstream_model_id AS "upstreamModelId", api_format AS "apiFormat",
              supports_images AS "supportsImages", supports_reasoning AS "supportsReasoning",
              max_output_tokens AS "maxOutputTokens", created_at AS "createdAt", updated_at AS "updatedAt"
         FROM model_presets
        WHERE user_id IS NULL OR user_id = $1
        ORDER BY user_id NULLS FIRST, display_name ASC`,
      [user.id],
    ));
    return json(rows.rows);
  }

  if (url.pathname === '/api/mappings' && request.method === 'GET') {
    const rows = await withClient(env, (client) => client.query(
      `SELECT m.alias,
              mr.id AS "routeId",
              mr.binding_id AS "bindingId",
              mr.enabled,
              mr.position,
              mp.display_name AS "presetDisplayName",
              mp.upstream_model_id AS "presetUpstreamModelId",
              pc.display_name AS "providerConnectionName",
              ca.label AS "cliproxyAccountLabel",
              ca.prefix AS "cliproxyAccountPrefix",
              mb.api_format AS "apiFormat"
         FROM mappings m
         LEFT JOIN mapping_routes mr ON mr.mapping_id = m.id
         LEFT JOIN model_bindings mb ON mb.id = mr.binding_id
         LEFT JOIN model_presets mp ON mp.id = mb.preset_id
         LEFT JOIN provider_connections pc ON pc.id = mb.connection_id
         LEFT JOIN cliproxy_accounts ca ON ca.id = mb.cliproxy_account_id
        WHERE m.user_id = $1
        ORDER BY m.alias, mr.position`,
      [user.id],
    ));
    const grouped = new Map<string, unknown[]>();
    for (const row of rows.rows as Array<Record<string, unknown>>) {
      const alias = String(row.alias);
      if (!grouped.has(alias)) grouped.set(alias, []);
      if (row.routeId) {
        const { alias: _alias, ...route } = row;
        grouped.get(alias)!.push(route);
      }
    }
    return json(Array.from(grouped, ([alias, routes]) => ({ alias, routes })));
  }

  if (url.pathname === '/api/keys' && request.method === 'GET') {
    const rows = await withClient(env, (client) => client.query(
      `SELECT id, name, prefix, created_at AS "createdAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"
         FROM gateway_keys
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [user.id],
    ));
    return json(rows.rows);
  }

  if (url.pathname === '/api/keys' && request.method === 'POST') {
    const body = await bodyObject(request);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) return json({ error: 'Invalid key name' }, 400);
    const secret = randomToken('gw_');
    const result = await withClient(env, (client) => client.query(
      `INSERT INTO gateway_keys (user_id, name, prefix, key_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, prefix, created_at AS "createdAt"`,
      [user.id, name, secret.slice(0, 11), hashSecret(secret)],
    ));
    return json({ ...result.rows[0], key: secret }, 201);
  }

  const keyMatch = url.pathname.match(/^\/api\/keys\/([^/]+)$/);
  if (keyMatch && request.method === 'PATCH') {
    const body = await bodyObject(request);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) return json({ error: 'Invalid key name' }, 400);
    const result = await withClient(env, (client) => client.query(
      `UPDATE gateway_keys SET name = $1
        WHERE id = $2 AND user_id = $3
        RETURNING id, name`,
      [name, keyMatch[1], user.id],
    ));
    return result.rows[0] ? json(result.rows[0]) : json({ error: 'Key not found' }, 404);
  }

  if (keyMatch && request.method === 'DELETE') {
    const result = await withClient(env, (client) => client.query(
      `UPDATE gateway_keys SET revoked_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING id`,
      [keyMatch[1], user.id],
    ));
    return result.rows[0] ? json({ ok: true }) : json({ error: 'Key not found' }, 404);
  }

  return undefined;
}
