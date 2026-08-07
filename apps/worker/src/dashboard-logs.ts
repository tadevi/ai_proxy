import { createHash } from 'node:crypto';
import { createDbClient } from '../../../packages/db/src/index.js';
import type { WorkerDbEnv } from './db.js';

const aliases = ['haiku', 'sonnet', 'opus'] as const;
const pageSize = 20;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

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

async function dashboardUserId(request: Request, env: WorkerDbEnv) {
  const token = cookieValue(request, 'gateway_session');
  if (!token) return undefined;
  return withClient(env, async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT u.id
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.expires_at > NOW()
        LIMIT 1`,
      [hashSecret(token)],
    );
    return result.rows[0]?.id;
  });
}

type LogCursor = { createdAt: string; id: string };

function encodeCursor(cursor: LogCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value: string | null): LogCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<LogCursor>;
    if (typeof parsed.createdAt !== 'string' || Number.isNaN(Date.parse(parsed.createdAt))) return undefined;
    if (typeof parsed.id !== 'string' || !parsed.id) return undefined;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return undefined;
  }
}

export async function handleDashboardLogsRequest(
  request: Request,
  env: WorkerDbEnv,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/logs' && url.pathname !== '/api/setup') return undefined;

  const userId = await dashboardUserId(request, env);
  if (!userId) return json({ error: 'Authentication required' }, 401);

  if (url.pathname === '/api/setup') {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const result = await withClient(env, (client) =>
      client.query<{ alias: string; routeId: string | null }>(
        `SELECT m.alias, mr.id AS "routeId"
           FROM mappings m
           LEFT JOIN mapping_routes mr
             ON mr.mapping_id = m.id AND mr.enabled = TRUE
          WHERE m.user_id = $1`,
        [userId],
      ),
    );
    return json({
      baseUrl: url.origin,
      aliases: Object.fromEntries(
        aliases.map((alias) => [alias, result.rows.some((row) => row.alias === alias && row.routeId)]),
      ),
    });
  }

  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const filters: string[] = ['rl.user_id = $1'];
  const values: unknown[] = [userId];
  const addFilter = (sql: string, value: unknown) => {
    values.push(value);
    filters.push(sql.replace('?', `$${values.length}`));
  };

  const requestId = url.searchParams.get('requestId');
  if (requestId) addFilter('rl.request_id = ?', requestId);
  const model = url.searchParams.get('model');
  if (model) addFilter('rl.incoming_model = ?', model);
  const status = url.searchParams.get('status');
  if (status && /^\d{3}$/.test(status)) addFilter('rl.status = ?', Number(status));
  const from = url.searchParams.get('from');
  if (from && !Number.isNaN(Date.parse(from))) addFilter('rl.created_at >= ?', new Date(from));
  const to = url.searchParams.get('to');
  if (to && !Number.isNaN(Date.parse(to))) addFilter('rl.created_at <= ?', new Date(to));

  const baseWhere = filters.join(' AND ');
  const totalResult = await withClient(env, (client) =>
    client.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM request_logs rl WHERE ${baseWhere}`, values),
  );

  const pageFilters = [...filters];
  const pageValues = [...values];
  const cursor = decodeCursor(url.searchParams.get('cursor'));
  if (cursor) {
    pageValues.push(new Date(cursor.createdAt), cursor.id);
    pageFilters.push(
      `(rl.created_at < $${pageValues.length - 1} OR (rl.created_at = $${pageValues.length - 1} AND rl.id < $${pageValues.length}))`,
    );
  }

  pageValues.push(pageSize + 1);
  const rows = await withClient(env, (client) =>
    client.query(
      `SELECT rl.id,
              rl.user_id AS "userId",
              rl.request_id AS "requestId",
              rl.incoming_model AS "incomingModel",
              rl.resolved_upstream_model AS "resolvedUpstreamModel",
              rl.binding_route_id AS "resolvedUpstreamModelId",
              rl.api_format AS "apiFormat",
              rl.status,
              rl.latency_ms AS "latencyMs",
              rl.time_to_first_token_ms AS "timeToFirstTokenMs",
              rl.input_tokens AS "inputTokens",
              rl.output_tokens AS "outputTokens",
              rl.cache_input_tokens AS "cacheInputTokens",
              rl.thinking_config AS "thinkingConfig",
              rl.reasoning_details AS "reasoningDetails",
              rl.fallback_count AS "fallbackCount",
              rl.error_category AS "errorCategory",
              rl.provider_error AS "providerError",
              rl.skipped_routes AS "skippedRoutes",
              rl.created_at AS "createdAt",
              ca.label AS "cliproxyAccountLabel",
              ca.prefix AS "cliproxyAccountPrefix"
         FROM request_logs rl
         LEFT JOIN binding_routes br ON br.id = rl.binding_route_id
         LEFT JOIN model_bindings mb ON mb.id = br.binding_id
         LEFT JOIN cliproxy_accounts ca ON ca.id = mb.cliproxy_account_id
        WHERE ${pageFilters.join(' AND ')}
        ORDER BY rl.created_at DESC, rl.id DESC
        LIMIT $${pageValues.length}`,
      pageValues,
    ),
  );

  const items = rows.rows.slice(0, pageSize) as Array<Record<string, unknown>>;
  const last = items.at(-1);
  const nextCursor =
    rows.rows.length > pageSize && last && last.createdAt instanceof Date && typeof last.id === 'string'
      ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
      : null;

  return json({ items, pageSize, total: totalResult.rows[0]?.total ?? 0, nextCursor });
}
