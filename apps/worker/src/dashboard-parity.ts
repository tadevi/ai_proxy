import { createHash } from 'node:crypto';
import bcrypt from '../../server/node_modules/bcryptjs/index.js';
import { createDbClient } from '../../../packages/db/src/index.js';
import { credentialsSchema, ruleInputSchema } from '../../../packages/shared/src/index.js';
import type { GatewayParityEnv } from './gateway-parity.js';

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');

function cookieValue(request: Request, name: string) {
  const raw = request.headers.get('cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

async function withClient<T>(env: GatewayParityEnv, fn: (client: ReturnType<typeof createDbClient>) => Promise<T>) {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connectionString) throw new Error('Database is not configured');
  const client = createDbClient(connectionString);
  try { await client.connect(); return await fn(client); }
  finally { await client.end().catch(() => undefined); }
}

async function userId(request: Request, env: GatewayParityEnv) {
  const token = cookieValue(request, 'gateway_session');
  if (!token) return undefined;
  return withClient(env, async (client) => {
    const result = await client.query<{ user_id: string }>(
      `SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > NOW() LIMIT 1`,
      [hashSecret(token)],
    );
    return result.rows[0]?.user_id;
  });
}

export async function handleDashboardParityRequest(request: Request, env: GatewayParityEnv): Promise<Response | undefined> {
  const url = new URL(request.url);

  if (url.pathname === '/api/auth/register') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { allow: 'POST' });
    const parsed = credentialsSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return json({ error: 'Invalid username or password format' }, 400);
    const result = await withClient(env, async (client) => {
      const exists = await client.query('SELECT 1 FROM users WHERE username = $1 LIMIT 1', [parsed.data.username]);
      if (exists.rowCount) return { conflict: true as const };
      const passwordHash = await bcrypt.hash(parsed.data.password, 12);
      const inserted = await client.query<{ id: string; username: string }>(
        `INSERT INTO users (username, password_hash) VALUES ($1,$2) RETURNING id, username`,
        [parsed.data.username, passwordHash],
      );
      return { user: inserted.rows[0] };
    });
    if ('conflict' in result) return json({ error: 'Username already exists' }, 409);
    return json(result.user, 201);
  }

  const matchRules = url.pathname.match(/^\/api\/models\/([^/]+)\/rules$/);
  const isUsage = url.pathname === '/api/models/usage';
  const deleteModel = url.pathname.match(/^\/api\/models\/([^/]+)$/);
  const legacyModelWrite = url.pathname === '/api/models' && (request.method === 'POST' || request.method === 'PATCH');
  if (!matchRules && !isUsage && !deleteModel && !legacyModelWrite) return undefined;

  const uid = await userId(request, env);
  if (!uid) return json({ error: 'Authentication required' }, 401);

  if (isUsage) {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { allow: 'GET' });
    const rows = await withClient(env, (client) => client.query(
      `SELECT br.id AS "upstreamModelId",
              COALESCE(SUM(mu.request_count),0)::text AS "requestCount",
              COALESCE(SUM(mu.input_tokens),0)::text AS "inputTokens",
              COALESCE(SUM(mu.output_tokens),0)::text AS "outputTokens",
              COALESCE(SUM(mu.cache_input_tokens),0)::text AS "cacheInputTokens",
              COALESCE(SUM(mu.cache_usage_reported_request_count),0)::text AS "cacheInputTokensReportedRequests"
         FROM model_usage_daily mu
         JOIN binding_routes br ON br.binding_id = mu.binding_id AND br.user_id = $1
        WHERE mu.user_id = $1
        GROUP BY br.id`,
      [uid],
    ));
    return json(rows.rows);
  }

  if (matchRules) {
    const routeId = matchRules[1]!;
    const binding = await withClient(env, async (client) => {
      const result = await client.query<{ binding_id: string }>(
        `SELECT binding_id FROM binding_routes WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [routeId, uid],
      );
      return result.rows[0]?.binding_id;
    });
    if (!binding) return json({ error: 'Model binding not found' }, 404);
    if (request.method === 'GET') {
      const rows = await withClient(env, (client) => client.query(
        `SELECT id, binding_id AS "bindingId", upstream_model_id AS "upstreamModelId", type, position, enabled,
                config_json AS "configJson", created_at AS "createdAt", updated_at AS "updatedAt"
           FROM transformation_rules WHERE binding_id = $1 ORDER BY position ASC`,
        [binding],
      ));
      return json(rows.rows);
    }
    if (request.method === 'PUT') {
      const parsed = ruleInputSchema.array().safeParse(await request.json().catch(() => undefined));
      if (!parsed.success) return json({ error: 'Invalid rules' }, 400);
      await withClient(env, async (client) => {
        await client.query('BEGIN');
        try {
          await client.query('DELETE FROM transformation_rules WHERE binding_id = $1', [binding]);
          for (const rule of parsed.data) {
            await client.query(
              `INSERT INTO transformation_rules (binding_id, upstream_model_id, type, position, enabled, config_json)
               VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
              [binding, routeId, rule.type, rule.position, rule.enabled, JSON.stringify(rule.config)],
            );
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      });
      return json({ ok: true });
    }
    return json({ error: 'Method not allowed' }, 405, { allow: 'GET, PUT' });
  }

  if (legacyModelWrite) {
    return json({ error: request.method === 'POST'
      ? 'Direct model-instance creation was removed. Bind a preset to a connection instead.'
      : 'Direct model-instance editing was removed. Update the binding or credential instead.' }, 410);
  }

  if (deleteModel && request.method === 'DELETE') {
    const result = await withClient(env, (client) => client.query(
      `DELETE FROM binding_routes WHERE id = $1 AND user_id = $2 RETURNING id`,
      [deleteModel[1], uid],
    ));
    return result.rows[0] ? json({ ok: true }) : json({ error: 'Model not found' }, 404);
  }

  return undefined;
}
