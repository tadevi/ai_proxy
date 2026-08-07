import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { createDbClient } from '../../../packages/db/src/index.js';
import {
  anthropicRequestSchema,
  normalizeSystemMessages,
  anthropicToOpenAI,
  openAIToAnthropic,
  openAIStreamToAnthropic,
  parseSSE,
  type AnthropicRequest,
  type StreamUsage,
} from '../../../packages/protocol/src/index.js';
import type { DashboardWriteEnv } from './dashboard-write.js';

export interface GatewayMessageEnv extends DashboardWriteEnv {
  UPSTREAM_TIMEOUT_MS?: string;
}

type Client = ReturnType<typeof createDbClient>;
type Route = {
  id: string;
  binding_id: string | null;
  token_id: string | null;
  display_name: string;
  upstream_model_id: string;
  api_format: 'openai_compatible' | 'anthropic_compatible';
  provider_base_path: string;
  request_path_override: string | null;
  max_output_tokens: number | null;
  connection_id: string;
  connection_name: string;
  base_url: string;
  encrypted_api_key: string | null;
  encryption_iv: string | null;
  encryption_auth_tag: string | null;
  cliproxy_prefix: string | null;
};

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

const errorBody = (type: string, message: string, requestId: string) => ({
  type: 'error',
  error: { type, message },
  request_id: requestId,
});

const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

function gatewayToken(request: Request) {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const xKey = request.headers.get('x-api-key') ?? undefined;
  if (bearer && xKey && bearer !== xKey) return undefined;
  const token = bearer ?? xKey;
  return token?.startsWith('gw_') ? token : undefined;
}

function cookieValue(request: Request, name: string) {
  const raw = request.headers.get('cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

async function withClient<T>(env: GatewayMessageEnv, fn: (client: Client) => Promise<T>) {
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

async function gatewayUser(request: Request, env: GatewayMessageEnv) {
  const token = gatewayToken(request);
  if (!token) return undefined;
  return withClient(env, async (client) => {
    const result = await client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM gateway_keys
       WHERE key_hash = $1 AND revoked_at IS NULL LIMIT 1`,
      [hashSecret(token)],
    );
    const key = result.rows[0];
    if (!key) return undefined;
    await client.query(
      `UPDATE gateway_keys SET last_used_at = NOW()
       WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '5 minutes')`,
      [key.id],
    );
    return key.user_id;
  });
}

async function dashboardUser(request: Request, env: GatewayMessageEnv) {
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

function decrypt(route: Route, keyValue: string) {
  if (!route.encrypted_api_key || !route.encryption_iv || !route.encryption_auth_tag)
    throw new Error('No API token configured for this route');
  const decoded = Buffer.from(keyValue, 'base64');
  const key = decoded.length === 32 ? decoded : createHash('sha256').update(keyValue).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(route.encryption_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(route.encryption_auth_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(route.encrypted_api_key, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

const routeSelection = `br.id, br.binding_id, br.token_id,
       mb.display_name, mb.upstream_model_id, mb.api_format, mb.provider_base_path,
       mb.request_path_override, mb.max_output_tokens,
       pc.id AS connection_id, pc.display_name AS connection_name, pc.base_url,
       ct.encrypted_api_key, ct.encryption_iv, ct.encryption_auth_tag,
       ca.prefix AS cliproxy_prefix`;

async function resolveRoutes(env: GatewayMessageEnv, userId: string, model: string) {
  return withClient(env, async (client) => {
    const mapped = await client.query<Route>(
      `SELECT ${routeSelection}
         FROM mappings m
         JOIN mapping_routes mr ON mr.mapping_id = m.id AND mr.enabled = TRUE
         JOIN model_bindings mb ON mb.id = mr.binding_id
         JOIN binding_routes br ON br.binding_id = mb.id AND br.enabled = TRUE
         JOIN provider_connections pc ON pc.id = mb.connection_id AND pc.enabled = TRUE
         LEFT JOIN connection_tokens ct ON ct.id = br.token_id
         LEFT JOIN cliproxy_accounts ca ON ca.id = mb.cliproxy_account_id
        WHERE m.user_id = $1 AND m.alias = $2
          AND mb.user_id = $1
          AND (ct.id IS NULL OR (ct.enabled = TRUE AND (ct.cooldown_until IS NULL OR ct.cooldown_until <= NOW())))
          AND (br.fallback_cooldown_until IS NULL OR br.fallback_cooldown_until <= NOW())
        ORDER BY mr.position ASC, br.created_at ASC`,
      [userId, model],
    );
    if (mapped.rows.length) return mapped.rows;
    const direct = await client.query<Route>(
      `SELECT ${routeSelection}
         FROM binding_routes br
         JOIN model_bindings mb ON mb.id = br.binding_id
         JOIN provider_connections pc ON pc.id = mb.connection_id AND pc.enabled = TRUE
         LEFT JOIN connection_tokens ct ON ct.id = br.token_id
         LEFT JOIN cliproxy_accounts ca ON ca.id = mb.cliproxy_account_id
        WHERE br.user_id = $1 AND mb.user_id = $1 AND mb.upstream_model_id = $2 AND br.enabled = TRUE
          AND (ct.id IS NULL OR (ct.enabled = TRUE AND (ct.cooldown_until IS NULL OR ct.cooldown_until <= NOW())))
          AND (br.fallback_cooldown_until IS NULL OR br.fallback_cooldown_until <= NOW())
        ORDER BY br.created_at ASC`,
      [userId, model],
    );
    return direct.rows;
  });
}

function endpoint(route: Route, env: GatewayMessageEnv) {
  const base = route.connection_name === 'CLIProxyAPI' && env.CLIPROXY_BASE_URL
    ? env.CLIPROXY_BASE_URL
    : route.base_url;
  const defaultPath = route.api_format === 'openai_compatible' ? '/chat/completions' : '/v1/messages';
  return `${base.replace(/\/+$/, '')}${route.request_path_override ?? `${route.provider_base_path}${defaultPath}`}`;
}

function shouldFallback(status: number) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function logRequest(env: GatewayMessageEnv, input: {
  userId: string; requestId: string; incomingModel: string; route?: Route; status: number;
  latencyMs: number; fallbackCount?: number; errorCategory?: string; providerError?: unknown;
  inputTokens?: number; outputTokens?: number; cacheInputTokens?: number;
}) {
  await withClient(env, async (client) => {
    await client.query(
      `INSERT INTO request_logs
       (user_id, request_id, incoming_model, resolved_upstream_model, binding_route_id,
        api_format, status, latency_ms, input_tokens, output_tokens, cache_input_tokens,
        fallback_count, error_category, provider_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [input.userId, input.requestId, input.incomingModel, input.route?.display_name ?? null,
       input.route?.id ?? null, input.route?.api_format ?? null, input.status, input.latencyMs,
       input.inputTokens ?? null, input.outputTokens ?? null, input.cacheInputTokens ?? null,
       input.fallbackCount ?? 0, input.errorCategory ?? null,
       input.providerError ? JSON.stringify(input.providerError) : null],
    );
  }).catch(() => undefined);
}

async function cooldown(env: GatewayMessageEnv, route: Route, status: number, providerError: unknown) {
  if (!shouldFallback(status)) return;
  await withClient(env, async (client) => {
    await client.query(
      `UPDATE binding_routes
          SET fallback_cooldown_until = NOW() + INTERVAL '60 seconds', latest_error = $2::jsonb,
              latest_error_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [route.id, JSON.stringify(providerError ?? { status })],
    );
    if (route.token_id && (status === 401 || status === 403 || status === 429)) {
      await client.query(
        `UPDATE connection_tokens
            SET cooldown_until = NOW() + INTERVAL '60 seconds', latest_error = $2::jsonb,
                latest_error_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [route.token_id, JSON.stringify(providerError ?? { status })],
      );
    }
  }).catch(() => undefined);
}

function iterableResponse(iterable: AsyncIterable<string | Uint8Array>, requestId: string) {
  const encoder = new TextEncoder();
  const iterator = iterable[Symbol.asyncIterator]();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) return controller.close();
        controller.enqueue(typeof next.value === 'string' ? encoder.encode(next.value) : next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() { await iterator.return?.(); },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-request-id': requestId,
    },
  });
}

async function callRoute(env: GatewayMessageEnv, route: Route, request: AnthropicRequest, clientModel: string, requestId: string) {
  if (!env.CREDENTIAL_ENCRYPTION_KEY) throw new Error('CREDENTIAL_ENCRYPTION_KEY is not configured');
  const key = decrypt(route, env.CREDENTIAL_ENCRYPTION_KEY);
  const maxTokens = route.max_output_tokens ? Math.min(request.max_tokens, route.max_output_tokens) : request.max_tokens;
  const adjusted = { ...request, max_tokens: maxTokens };
  let body: Record<string, unknown>;
  let headers: Record<string, string>;
  if (route.api_format === 'openai_compatible') {
    body = await anthropicToOpenAI(adjusted, route.cliproxy_prefix ? `${route.cliproxy_prefix}/${route.upstream_model_id}` : route.upstream_model_id, {
      supportsReasoning: true,
      supportsReasoningBudget: true,
      supportsReasoningEffort: true,
      supportsAdaptiveReasoning: true,
    });
    if (adjusted.stream) body.stream_options = { include_usage: true };
    headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: adjusted.stream ? 'text/event-stream' : 'application/json' };
  } else {
    body = { ...adjusted, model: route.cliproxy_prefix ? `${route.cliproxy_prefix}/${route.upstream_model_id}` : route.upstream_model_id } as unknown as Record<string, unknown>;
    headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', accept: adjusted.stream ? 'text/event-stream' : 'application/json' };
  }

  const controller = new AbortController();
  const timeout = Number(env.UPSTREAM_TIMEOUT_MS ?? '60000');
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeout) ? timeout : 60000);
  let response: Response;
  try {
    response = await fetch(endpoint(route, env), { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let providerError: unknown = { status: response.status };
    try { providerError = text ? JSON.parse(text) : providerError; } catch { providerError = { status: response.status, message: 'Upstream returned a non-JSON error response.' }; }
    return { ok: false as const, status: response.status, providerError };
  }
  if (adjusted.stream) {
    if (!response.body) return { ok: false as const, status: 502, providerError: { message: 'Empty upstream stream' } };
    if (route.api_format === 'anthropic_compatible') {
      return { ok: true as const, response: new Response(response.body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-request-id': requestId } }) };
    }
    const usage: StreamUsage = {};
    return { ok: true as const, response: iterableResponse(openAIStreamToAnthropic(parseSSE(response.body), clientModel, undefined, usage), requestId), usage };
  }
  const raw = await response.json() as Record<string, unknown>;
  if (route.api_format === 'anthropic_compatible') return { ok: true as const, body: { ...raw, model: clientModel } };
  return { ok: true as const, body: await openAIToAnthropic(raw, clientModel) };
}

async function execute(env: GatewayMessageEnv, userId: string, raw: unknown, requestId: string) {
  const started = Date.now();
  const parsed = anthropicRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid request';
    await logRequest(env, { userId, requestId, incomingModel: typeof (raw as any)?.model === 'string' ? (raw as any).model : 'unknown', status: 400, latencyMs: Date.now() - started, errorCategory: 'invalid_request' });
    return json(errorBody('invalid_request_error', message, requestId), 400, { 'x-request-id': requestId });
  }
  const request = normalizeSystemMessages(parsed.data);
  const routes = await resolveRoutes(env, userId, request.model);
  if (!routes.length) {
    await logRequest(env, { userId, requestId, incomingModel: request.model, status: 400, latencyMs: Date.now() - started, errorCategory: 'no_eligible_route' });
    return json(errorBody('invalid_request_error', `No eligible ${request.model} route is configured.`, requestId), 400, { 'x-request-id': requestId });
  }
  let lastStatus = 502;
  let lastError: unknown = { message: 'All routes failed' };
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i]!;
    try {
      const result = await callRoute(env, route, request, request.model, requestId);
      if (result.ok) {
        await withClient(env, (client) => client.query(`UPDATE binding_routes SET fallback_cooldown_until = NULL, latest_error = NULL, latest_error_at = NULL WHERE id = $1`, [route.id])).catch(() => undefined);
        await logRequest(env, { userId, requestId, incomingModel: request.model, route, status: 200, latencyMs: Date.now() - started, fallbackCount: i, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens, cacheInputTokens: result.usage?.cacheInputTokens });
        return result.response ?? json(result.body, 200, { 'x-request-id': requestId });
      }
      lastStatus = result.status;
      lastError = result.providerError;
      await cooldown(env, route, result.status, result.providerError);
      if (!shouldFallback(result.status)) break;
    } catch (error) {
      lastStatus = 502;
      lastError = { message: error instanceof Error ? error.message : 'Upstream request failed' };
      await cooldown(env, route, 502, lastError);
    }
  }
  await logRequest(env, { userId, requestId, incomingModel: request.model, route: routes.at(-1), status: lastStatus >= 400 && lastStatus < 600 ? lastStatus : 502, latencyMs: Date.now() - started, fallbackCount: Math.max(0, routes.length - 1), errorCategory: 'upstream_error', providerError: lastError });
  return json(errorBody('api_error', 'All eligible upstream routes failed.', requestId), lastStatus >= 400 && lastStatus < 600 ? lastStatus : 502, { 'x-request-id': requestId });
}

export async function handleGatewayMessageRequest(request: Request, env: GatewayMessageEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== '/v1/messages' && url.pathname !== '/anthropic/v1/messages' && url.pathname !== '/api/playground/complete') return undefined;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { allow: 'POST' });
  const requestId = request.headers.get('cf-ray') ?? randomUUID();

  if (url.pathname === '/api/playground/complete') {
    const userId = await dashboardUser(request, env);
    if (!userId) return json({ error: 'Authentication required' }, 401);
    const body = await request.json().catch(() => undefined) as any;
    if (!body || typeof body.modelId !== 'string' || typeof body.prompt !== 'string' || !body.prompt.trim())
      return json({ error: 'modelId and prompt are required' }, 400);
    const route = await withClient(env, async (client) => {
      const r = await client.query<{ upstream_model_id: string }>(
        `SELECT mb.upstream_model_id
           FROM binding_routes br
           JOIN model_bindings mb ON mb.id = br.binding_id
          WHERE br.id = $1 AND br.user_id = $2 AND mb.user_id = $2
          LIMIT 1`,
        [body.modelId, userId],
      );
      return r.rows[0];
    });
    if (!route) return json({ error: 'Model not found' }, 404);
    const content: Array<Record<string, unknown>> = [];
    if (body.imageBase64 && body.imageMediaType) content.push({ type: 'image', source: { type: 'base64', media_type: body.imageMediaType, data: body.imageBase64 } });
    content.push({ type: 'text', text: body.prompt.trim() });
    const anthropic = {
      model: route.upstream_model_id,
      max_tokens: typeof body.maxTokens === 'number' && body.maxTokens > 0 ? Math.floor(body.maxTokens) : 1024,
      messages: [{ role: 'user', content }],
      stream: false,
      ...(body.includeTestTool ? { tools: [{ name: 'web_search', description: 'Search the web for up-to-date information on a topic.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }] } : {}),
    };
    const response = await execute(env, userId, anthropic, requestId);
    const payload = await response.json().catch(() => undefined);
    return response.ok ? json({ ok: true, response: payload }) : json({ ok: false, message: (payload as any)?.error?.message ?? 'Playground request failed', providerError: payload }, response.status);
  }

  const userId = await gatewayUser(request, env);
  if (!userId) return json(errorBody('authentication_error', 'Valid gateway API key required', requestId), 401, { 'x-request-id': requestId });
  return execute(env, userId, await request.json().catch(() => undefined), requestId);
}