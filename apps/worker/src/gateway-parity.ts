import { createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createDbClient } from '../../../packages/db/src/index.js';
import {
  anthropicRequestSchema,
  normalizeSystemMessages,
  anthropicToOpenAI,
  openAIToAnthropic,
  openAIStreamToAnthropic,
  parseSSE,
  applyRules,
  normalizeThinking,
  type AnthropicRequest,
  type Rule,
  type StreamUsage,
  type ReasoningWireFormat,
} from '../../../packages/protocol/src/index.js';
import type { DashboardWriteEnv } from './dashboard-write.js';

export interface GatewayParityEnv extends DashboardWriteEnv {
  UPSTREAM_TIMEOUT_MS?: string;
  ALLOW_PRIVATE_UPSTREAMS?: string;
}

type Client = ReturnType<typeof createDbClient>;
type Route = {
  id: string;
  binding_id: string;
  token_id: string;
  display_name: string;
  upstream_model_id: string;
  api_format: 'openai_compatible' | 'anthropic_compatible';
  provider_base_path: string;
  request_path_override: string | null;
  max_output_tokens: number | null;
  supports_streaming: 'yes' | 'no' | 'unknown';
  supports_tools: 'yes' | 'no' | 'unknown';
  supports_images: 'yes' | 'no' | 'unknown';
  supports_reasoning: 'yes' | 'no' | 'unknown';
  latest_test_status: string | null;
  connection_id: string;
  connection_name: string;
  base_url: string;
  encrypted_api_key: string;
  encryption_iv: string;
  encryption_auth_tag: string;
  cliproxy_account_id: string | null;
  cliproxy_prefix: string | null;
};

type ProviderFailure = {
  status: number;
  category: string;
  fallbackable: boolean;
  providerError: Record<string, unknown>;
};

type ReasoningEntry = {
  data: string;
  format: ReasoningWireFormat | 'unknown';
  userId: string;
  connectionId: string;
  upstreamModelId: string;
  expiresAt: number;
};

const reasoningState = new Map<string, ReasoningEntry>();
const reasoningCodecByBindingId = new Map<string, ReasoningWireFormat>();
const reasoningTtlMs = 30 * 60 * 1000;
const tokenCooldownMs = 60 * 60 * 1000;
const routeCooldownMs = 5 * 60 * 1000;
const fallbackStatuses = new Set([429, 500, 502, 503, 504]);
const cooldownStatuses = new Set([403]);
const disableStatuses = new Set([401, 402]);
const disableTypes = new Set(['insufficient_balance', 'quota_exceeded', 'billing_error']);

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');

async function withClient<T>(env: GatewayParityEnv, fn: (client: Client) => Promise<T>) {
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

function cookieValue(request: Request, name: string) {
  const raw = request.headers.get('cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

async function dashboardUser(request: Request, env: GatewayParityEnv) {
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

async function gatewayUser(request: Request, env: GatewayParityEnv) {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const xKey = request.headers.get('x-api-key') ?? undefined;
  if (bearer && xKey && bearer !== xKey) return undefined;
  const token = bearer ?? xKey;
  if (!token?.startsWith('gw_')) return undefined;
  return withClient(env, async (client) => {
    const result = await client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM gateway_keys WHERE key_hash = $1 AND revoked_at IS NULL LIMIT 1`,
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

function decrypt(route: Route, keyValue: string) {
  const decoded = Buffer.from(keyValue, 'base64');
  const key = decoded.length === 32 ? decoded : createHash('sha256').update(keyValue).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(route.encryption_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(route.encryption_auth_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(route.encrypted_api_key, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function containsImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImage);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'image' || record.type === 'image_url' || record.type === 'input_image') return true;
  return record.type === 'tool_result' && containsImage(record.content);
}

function requestHasImages(request: AnthropicRequest) {
  return request.messages.some((message) => containsImage(message.content));
}

function thinkingConfig(request: AnthropicRequest) {
  const normalized = normalizeThinking(request.thinking, request.output_config);
  const raw = request.thinking && typeof request.thinking === 'object' ? request.thinking as Record<string, unknown> : undefined;
  const type = typeof raw?.type === 'string' ? raw.type : undefined;
  if (!normalized.enabled && !type) return null;
  return {
    enabled: normalized.enabled,
    ...(type ? { type } : {}),
    ...(normalized.effort ? { effort: normalized.effort } : {}),
    ...(normalized.budgetTokens ? { budgetTokens: normalized.budgetTokens } : {}),
  };
}

const routeSelection = `br.id, br.binding_id, br.token_id,
  mb.display_name, mb.upstream_model_id, mb.api_format, mb.provider_base_path,
  mb.request_path_override, mb.max_output_tokens, mb.supports_streaming,
  mb.supports_tools, mb.supports_images, mb.supports_reasoning,
  br.latest_test_status,
  pc.id AS connection_id, pc.display_name AS connection_name, pc.base_url,
  ct.encrypted_api_key, ct.encryption_iv, ct.encryption_auth_tag,
  mb.cliproxy_account_id, ca.prefix AS cliproxy_prefix`;

async function rulesForBindings(client: Client, bindingIds: string[]) {
  if (!bindingIds.length) return new Map<string, Rule[]>();
  const rows = await client.query<{
    binding_id: string; type: string; enabled: boolean; position: number; config_json: Record<string, unknown>;
  }>(
    `SELECT binding_id, type, enabled, position, config_json
       FROM transformation_rules
      WHERE binding_id = ANY($1::uuid[])
      ORDER BY position ASC`,
    [bindingIds],
  );
  const map = new Map<string, Rule[]>();
  for (const row of rows.rows) {
    const list = map.get(row.binding_id) ?? [];
    list.push({ type: row.type, enabled: row.enabled, position: row.position, config: row.config_json });
    map.set(row.binding_id, list);
  }
  return map;
}

async function resolveRoutes(env: GatewayParityEnv, userId: string, model: string, request: AnthropicRequest) {
  return withClient(env, async (client) => {
    const params = [userId, model];
    const commonEligibility = `
      AND ct.enabled = TRUE
      AND (ct.cooldown_until IS NULL OR ct.cooldown_until <= NOW())
      AND (br.fallback_cooldown_until IS NULL OR br.fallback_cooldown_until <= NOW())
      AND (cms.cooldown_until IS NULL OR cms.cooldown_until <= NOW())
      AND br.enabled = TRUE
      AND pc.enabled = TRUE`;
    const mapped = await client.query<Route>(
      `SELECT ${routeSelection}
         FROM mappings m
         JOIN mapping_routes mr ON mr.mapping_id = m.id AND mr.enabled = TRUE
         JOIN model_bindings mb ON mb.id = mr.binding_id AND mb.user_id = $1
         JOIN binding_routes br ON br.binding_id = mb.id AND br.user_id = $1
         JOIN provider_connections pc ON pc.id = mb.connection_id
         JOIN connection_tokens ct ON ct.id = br.token_id
         LEFT JOIN cliproxy_accounts ca ON ca.id = mb.cliproxy_account_id
         LEFT JOIN cliproxy_model_states cms
           ON cms.cliproxy_account_id = mb.cliproxy_account_id
          AND cms.upstream_model_id = mb.upstream_model_id
        WHERE m.user_id = $1 AND m.alias = $2 ${commonEligibility}
        ORDER BY mr.position ASC,
          CASE br.latest_test_status WHEN 'healthy' THEN 0 WHEN 'failed' THEN 2 ELSE 1 END,
          br.created_at ASC, br.id ASC`,
      params,
    );
    const direct = mapped.rows.length ? mapped : await client.query<Route>(
      `SELECT ${routeSelection}
         FROM binding_routes br
         JOIN model_bindings mb ON mb.id = br.binding_id AND mb.user_id = $1
         JOIN provider_connections pc ON pc.id = mb.connection_id
         JOIN connection_tokens ct ON ct.id = br.token_id
         LEFT JOIN cliproxy_accounts ca ON ca.id = mb.cliproxy_account_id
         LEFT JOIN cliproxy_model_states cms
           ON cms.cliproxy_account_id = mb.cliproxy_account_id
          AND cms.upstream_model_id = mb.upstream_model_id
        WHERE mb.upstream_model_id = $2 ${commonEligibility}
        ORDER BY CASE br.latest_test_status WHEN 'healthy' THEN 0 WHEN 'failed' THEN 2 ELSE 1 END,
          br.created_at ASC, br.id ASC`,
      params,
    );
    const hasImages = requestHasImages(request);
    const skipped: Array<Record<string, unknown>> = [];
    const eligible = direct.rows.filter((route) => {
      if (!hasImages || route.supports_images === 'yes') return true;
      skipped.push({ upstreamModelId: route.upstream_model_id, reason: route.supports_images === 'no' ? 'images_unsupported' : 'images_capability_unknown' });
      return false;
    });
    const rules = await rulesForBindings(client, [...new Set(eligible.map((route) => route.binding_id))]);
    return { routes: eligible, skipped, rules };
  });
}

function endpoint(route: Route, env: GatewayParityEnv) {
  const base = route.connection_name === 'CLIProxyAPI' && env.CLIPROXY_BASE_URL ? env.CLIPROXY_BASE_URL : route.base_url;
  const defaultPath = route.api_format === 'openai_compatible' ? '/chat/completions' : '/v1/messages';
  return `${base.replace(/\/+$/, '')}${route.request_path_override ?? `${route.provider_base_path}${defaultPath}`}`;
}

function safeProviderError(value: unknown) {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const error = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : root;
  const result: Record<string, unknown> = {};
  for (const key of ['code', 'type', 'param', 'message', 'request_id', 'requestId']) {
    const item = error[key] ?? root[key];
    if (typeof item === 'string' || typeof item === 'number') result[key] = item;
  }
  return Object.keys(result).length ? result : { message: 'Upstream returned an unstructured error.' };
}

function isDisableFailure(status: number, providerError: Record<string, unknown>) {
  if (disableStatuses.has(status)) return true;
  const type = providerError.type;
  return typeof type === 'string' && disableTypes.has(type);
}

function isCliproxyCooldown(status: number, providerError: Record<string, unknown>) {
  return status === 429 && typeof providerError.message === 'string' && /^All credentials for model .+ are cooling down$/i.test(providerError.message);
}

async function recordFailure(env: GatewayParityEnv, route: Route, failure: ProviderFailure) {
  await withClient(env, async (client) => {
    await client.query(
      `UPDATE binding_routes
          SET latest_test_status = 'failed', latest_test_at = NOW(), latest_error = $2::jsonb,
              latest_error_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [route.id, JSON.stringify(failure.providerError)],
    );
    if (fallbackStatuses.has(failure.status)) {
      await client.query(
        `UPDATE binding_routes SET fallback_cooldown_until = NOW() + ($2::int * INTERVAL '1 millisecond'), updated_at = NOW() WHERE id = $1`,
        [route.id, routeCooldownMs],
      );
    }
    if (route.token_id && cooldownStatuses.has(failure.status)) {
      await client.query(
        `UPDATE connection_tokens
            SET cooldown_until = NOW() + ($2::int * INTERVAL '1 millisecond'), latest_error = $3::jsonb,
                latest_error_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [route.token_id, tokenCooldownMs, JSON.stringify(failure.providerError)],
      );
    }
    if (route.token_id && isDisableFailure(failure.status, failure.providerError)) {
      await client.query(
        `UPDATE connection_tokens SET enabled = FALSE, latest_error = $2::jsonb, latest_error_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [route.token_id, JSON.stringify(failure.providerError)],
      );
    }
    if (route.cliproxy_account_id && isCliproxyCooldown(failure.status, failure.providerError)) {
      await client.query(
        `INSERT INTO cliproxy_model_states
          (cliproxy_account_id, upstream_model_id, cooldown_until, latest_error, latest_error_at, updated_at)
         VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 millisecond'), $4::jsonb, NOW(), NOW())
         ON CONFLICT (cliproxy_account_id, upstream_model_id)
         DO UPDATE SET cooldown_until = EXCLUDED.cooldown_until, latest_error = EXCLUDED.latest_error,
                       latest_error_at = NOW(), updated_at = NOW()`,
        [route.cliproxy_account_id, route.upstream_model_id, tokenCooldownMs, JSON.stringify(failure.providerError)],
      );
    }
  }).catch(() => undefined);
}

async function recordSuccess(env: GatewayParityEnv, route: Route) {
  await withClient(env, async (client) => {
    await client.query(
      `UPDATE binding_routes SET latest_test_status = 'healthy', latest_test_at = NOW(), latest_error = NULL,
       latest_error_at = NULL, fallback_cooldown_until = NULL, updated_at = NOW() WHERE id = $1`,
      [route.id],
    );
    await client.query(
      `UPDATE connection_tokens SET cooldown_until = NULL, latest_error = NULL, latest_error_at = NULL, updated_at = NOW() WHERE id = $1`,
      [route.token_id],
    );
    if (route.cliproxy_account_id) {
      await client.query(
        `DELETE FROM cliproxy_model_states WHERE cliproxy_account_id = $1 AND upstream_model_id = $2`,
        [route.cliproxy_account_id, route.upstream_model_id],
      );
    }
  }).catch(() => undefined);
}

async function writeLog(env: GatewayParityEnv, input: {
  userId: string; requestId: string; incomingModel: string; route?: Route; status: number; latencyMs: number;
  timeToFirstTokenMs?: number | null; inputTokens?: number; outputTokens?: number; cacheInputTokens?: number;
  fallbackCount?: number; errorCategory?: string; providerError?: unknown; skipped?: unknown; thinking?: unknown;
  reasoningDetails?: boolean | null;
}) {
  await withClient(env, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO request_logs
         (user_id, request_id, incoming_model, resolved_upstream_model, binding_route_id, api_format,
          status, latency_ms, time_to_first_token_ms, input_tokens, output_tokens, cache_input_tokens,
          thinking_config, reasoning_details, fallback_count, error_category, provider_error, skipped_routes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17::jsonb,$18::jsonb)`,
        [input.userId, input.requestId, input.incomingModel, input.route?.display_name ?? null,
         input.route?.id ?? null, input.route?.api_format ?? null, input.status, input.latencyMs,
         input.timeToFirstTokenMs ?? null, input.inputTokens ?? null, input.outputTokens ?? null,
         input.cacheInputTokens ?? null, input.thinking ? JSON.stringify(input.thinking) : null,
         input.reasoningDetails ?? null, input.fallbackCount ?? 0, input.errorCategory ?? null,
         input.providerError ? JSON.stringify(input.providerError) : null,
         input.skipped ? JSON.stringify(input.skipped) : null],
      );
      if (input.route?.binding_id) {
        await client.query(
          `INSERT INTO model_usage_daily
           (user_id, binding_id, usage_date, request_count, input_tokens, output_tokens, cache_input_tokens, cache_usage_reported_request_count)
           VALUES ($1,$2,CURRENT_DATE,1,$3,$4,$5,$6)
           ON CONFLICT (user_id, binding_id, usage_date)
           DO UPDATE SET request_count = model_usage_daily.request_count + 1,
             input_tokens = model_usage_daily.input_tokens + EXCLUDED.input_tokens,
             output_tokens = model_usage_daily.output_tokens + EXCLUDED.output_tokens,
             cache_input_tokens = model_usage_daily.cache_input_tokens + EXCLUDED.cache_input_tokens,
             cache_usage_reported_request_count = model_usage_daily.cache_usage_reported_request_count + EXCLUDED.cache_usage_reported_request_count`,
          [input.userId, input.route.binding_id, input.inputTokens ?? 0, input.outputTokens ?? 0,
           input.cacheInputTokens ?? 0, input.cacheInputTokens == null ? 0 : 1],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }).catch(() => undefined);
}

function reasoningFormat(route: Route): ReasoningWireFormat {
  const cached = reasoningCodecByBindingId.get(route.binding_id);
  if (cached) return cached;
  try {
    return new URL(route.base_url).hostname.toLowerCase() === 'inference.poolside.ai' ? 'reasoning_content' : 'reasoning_details';
  } catch {
    return 'reasoning_details';
  }
}

function resolveReasoning(handle: string, route: Route, userId: string) {
  const entry = reasoningState.get(handle);
  if (!entry || entry.expiresAt <= Date.now()) {
    reasoningState.delete(handle);
    return null;
  }
  if (entry.userId !== userId || entry.connectionId !== route.connection_id || entry.upstreamModelId !== route.upstream_model_id) return null;
  if (entry.format === 'reasoning_details' || entry.format === 'reasoning_content') reasoningCodecByBindingId.set(route.binding_id, entry.format);
  return { data: entry.data, format: entry.format };
}

function storeReasoning(data: string, format: ReasoningWireFormat | 'unknown', route: Route, userId: string) {
  const handle = `proxy:rs_${randomBytes(16).toString('base64url')}`;
  reasoningState.set(handle, { data, format, userId, connectionId: route.connection_id, upstreamModelId: route.upstream_model_id, expiresAt: Date.now() + reasoningTtlMs });
  if (reasoningState.size > 10_000) reasoningState.delete(reasoningState.keys().next().value as string);
  return handle;
}

function iterableResponse(iterable: AsyncIterable<string | Uint8Array>, requestId: string) {
  const encoder = new TextEncoder();
  const iterator = iterable[Symbol.asyncIterator]();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) return controller.close();
        controller.enqueue(typeof next.value === 'string' ? encoder.encode(next.value) : next.value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return?.(); },
  }), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-request-id': requestId } });
}

async function callRoute(env: GatewayParityEnv, route: Route, request: AnthropicRequest, userId: string, clientModel: string, requestId: string) {
  if (!env.CREDENTIAL_ENCRYPTION_KEY) throw new Error('CREDENTIAL_ENCRYPTION_KEY is not configured');
  const key = decrypt(route, env.CREDENTIAL_ENCRYPTION_KEY);
  const adjusted = route.max_output_tokens ? { ...request, max_tokens: Math.min(request.max_tokens, route.max_output_tokens) } : request;
  const rules = await withClient(env, async (client) => {
    const map = await rulesForBindings(client, [route.binding_id]);
    return map.get(route.binding_id) ?? [];
  });
  let body: Record<string, unknown>;
  let headers: Record<string, string>;
  const upstreamModel = route.cliproxy_prefix ? `${route.cliproxy_prefix}/${route.upstream_model_id}` : route.upstream_model_id;
  if (route.api_format === 'openai_compatible') {
    body = await anthropicToOpenAI(
      adjusted,
      upstreamModel,
      {
        supportsReasoning: route.supports_reasoning === 'yes',
        supportsReasoningBudget: route.supports_reasoning === 'yes',
        supportsReasoningEffort: route.supports_reasoning === 'yes',
        supportsAdaptiveReasoning: route.supports_reasoning === 'yes',
      },
      async (signature) => resolveReasoning(signature, route, userId),
      reasoningFormat(route),
    );
    body = applyRules(body, rules, normalizeThinking(adjusted.thinking, adjusted.output_config));
    if (adjusted.stream) body.stream_options = { include_usage: true };
    headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: adjusted.stream ? 'text/event-stream' : 'application/json' };
  } else {
    body = { ...adjusted, model: upstreamModel } as unknown as Record<string, unknown>;
    headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', accept: adjusted.stream ? 'text/event-stream' : 'application/json' };
  }
  const timeoutMs = Number(env.UPSTREAM_TIMEOUT_MS ?? '60000');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 60000);
  let response: Response;
  try {
    response = await fetch(endpoint(route, env), { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'manual' });
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let parsed: unknown = undefined;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    const providerError = safeProviderError(parsed ?? { message: text ? 'Upstream returned a non-JSON error response.' : `HTTP ${response.status}` });
    const disable = isDisableFailure(response.status, providerError);
    const fallbackable = fallbackStatuses.has(response.status) || cooldownStatuses.has(response.status) || disable;
    return { ok: false as const, failure: { status: response.status, category: disable ? 'disabled_upstream' : response.status === 401 || response.status === 403 ? 'authentication_error' : `upstream_${response.status}`, fallbackable, providerError } };
  }
  if (adjusted.stream) {
    if (!response.body) return { ok: false as const, failure: { status: 502, category: 'empty_stream', fallbackable: true, providerError: { message: 'Empty upstream stream' } } };
    if (route.api_format === 'anthropic_compatible') return { ok: true as const, response: new Response(response.body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-request-id': requestId } }) };
    const usage: StreamUsage = {};
    const stream = openAIStreamToAnthropic(parseSSE(response.body), clientModel, undefined, usage, async (detail) => storeReasoning(detail.data, detail.format ?? 'unknown', route, userId));
    return { ok: true as const, response: iterableResponse(stream, requestId), usage };
  }
  const raw = await response.json() as Record<string, unknown>;
  if (route.api_format === 'anthropic_compatible') return { ok: true as const, body: { ...raw, model: clientModel } };
  return { ok: true as const, body: await openAIToAnthropic(raw, clientModel, { upstreamProvider: undefined }, async (detail) => storeReasoning(detail.data, detail.format ?? 'unknown', route, userId)) };
}

async function execute(env: GatewayParityEnv, userId: string, raw: unknown, requestId: string) {
  const started = Date.now();
  const parsed = anthropicRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const incoming = raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).model === 'string' ? String((raw as Record<string, unknown>).model).slice(0, 200) : 'unknown';
    await writeLog(env, { userId, requestId, incomingModel: incoming, status: 400, latencyMs: Date.now() - started, errorCategory: 'invalid_request', providerError: { validationErrors: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } });
    return json({ type: 'error', error: { type: 'invalid_request_error', message: parsed.error.issues[0]?.message ?? 'Invalid request' }, request_id: requestId }, 400, { 'x-request-id': requestId });
  }
  const request = normalizeSystemMessages(parsed.data);
  const resolved = await resolveRoutes(env, userId, request.model, request);
  if (!resolved.routes.length) {
    await writeLog(env, { userId, requestId, incomingModel: request.model, status: 400, latencyMs: Date.now() - started, errorCategory: 'no_eligible_route', skipped: resolved.skipped, thinking: thinkingConfig(request) });
    return json({ type: 'error', error: { type: 'invalid_request_error', message: `No eligible ${request.model} route is configured.` }, request_id: requestId }, 400, { 'x-request-id': requestId });
  }
  let lastFailure: ProviderFailure | undefined;
  let lastRoute: Route | undefined;
  for (let index = 0; index < resolved.routes.length; index++) {
    const route = resolved.routes[index]!;
    lastRoute = route;
    try {
      const result = await callRoute(env, route, request, userId, request.model, requestId);
      if (result.ok) {
        await recordSuccess(env, route);
        await writeLog(env, { userId, requestId, incomingModel: request.model, route, status: 200, latencyMs: Date.now() - started, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens, cacheInputTokens: result.usage?.cacheInputTokens, fallbackCount: index, skipped: resolved.skipped, thinking: thinkingConfig(request), reasoningDetails: result.usage?.reasoningDetails ?? null });
        return result.response ?? json(result.body, 200, { 'x-request-id': requestId });
      }
      lastFailure = result.failure;
      await recordFailure(env, route, result.failure);
      if (!result.failure.fallbackable) break;
    } catch (error) {
      lastFailure = { status: 502, category: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network_error', fallbackable: true, providerError: { message: error instanceof Error ? error.message : 'Could not connect to upstream provider.' } };
      await recordFailure(env, route, lastFailure);
    }
  }
  await writeLog(env, { userId, requestId, incomingModel: request.model, route: lastRoute, status: lastFailure?.status ?? 502, latencyMs: Date.now() - started, fallbackCount: Math.max(0, resolved.routes.length - 1), errorCategory: lastFailure?.category ?? 'upstream_error', providerError: lastFailure?.providerError, skipped: resolved.skipped, thinking: thinkingConfig(request) });
  return json({ type: 'error', error: { type: 'api_error', message: 'All eligible upstream routes failed.' }, request_id: requestId }, lastFailure?.status && lastFailure.status >= 400 && lastFailure.status < 600 ? lastFailure.status : 502, { 'x-request-id': requestId });
}

async function modelForDashboard(env: GatewayParityEnv, userId: string, routeId: string) {
  return withClient(env, async (client) => {
    const result = await client.query<Route>(
      `SELECT ${routeSelection}
         FROM binding_routes br
         JOIN model_bindings mb ON mb.id = br.binding_id AND mb.user_id = $2
         JOIN provider_connections pc ON pc.id = mb.connection_id
         JOIN connection_tokens ct ON ct.id = br.token_id
         LEFT JOIN cliproxy_accounts ca ON ca.id = mb.cliproxy_account_id
        WHERE br.id = $1 AND br.user_id = $2 LIMIT 1`,
      [routeId, userId],
    );
    return result.rows[0];
  });
}

export async function handleGatewayParityRequest(request: Request, env: GatewayParityEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  const isGateway = url.pathname === '/v1/messages' || url.pathname === '/anthropic/v1/messages';
  const isPlayground = url.pathname === '/api/playground/complete';
  const modelTest = url.pathname.match(/^\/api\/models\/([^/]+)\/test$/);
  if (!isGateway && !isPlayground && !modelTest) return undefined;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { allow: 'POST' });
  const requestId = request.headers.get('cf-ray') ?? randomUUID();

  if (isGateway) {
    const userId = await gatewayUser(request, env);
    if (!userId) return json({ type: 'error', error: { type: 'authentication_error', message: 'Valid gateway API key required' }, request_id: requestId }, 401, { 'x-request-id': requestId });
    return execute(env, userId, await request.json().catch(() => undefined), requestId);
  }

  const userId = await dashboardUser(request, env);
  if (!userId) return json({ error: 'Authentication required' }, 401);

  if (modelTest) {
    const route = await modelForDashboard(env, userId, modelTest[1]!);
    if (!route) return json({ error: 'Model not found' }, 404);
    const test = { model: route.upstream_model_id, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false };
    const response = await execute(env, userId, test, requestId);
    const payload = await response.json().catch(() => undefined);
    return response.ok ? json({ ok: true, message: 'Authentication, model access, and response conversion succeeded.', response: payload }) : json({ ok: false, message: (payload as any)?.error?.message ?? 'Model test failed' }, 502);
  }

  const body = await request.json().catch(() => undefined) as Record<string, unknown> | undefined;
  const modelId = typeof body?.modelId === 'string' ? body.modelId : '';
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!modelId || !prompt) return json({ error: 'modelId and prompt are required' }, 400);
  const route = await modelForDashboard(env, userId, modelId);
  if (!route) return json({ error: 'Model not found' }, 404);
  const content: Array<Record<string, unknown>> = [];
  if (typeof body?.imageBase64 === 'string' && typeof body?.imageMediaType === 'string') content.push({ type: 'image', source: { type: 'base64', media_type: body.imageMediaType, data: body.imageBase64 } });
  content.push({ type: 'text', text: prompt });
  const anthropic = {
    model: route.upstream_model_id,
    max_tokens: typeof body?.maxTokens === 'number' && body.maxTokens > 0 ? Math.floor(body.maxTokens) : 1024,
    messages: [{ role: 'user', content }],
    stream: false,
    ...(body?.includeTestTool ? { tools: [{ name: 'web_search', description: 'Search the web for up-to-date information on a topic.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'The search query' } }, required: ['query'] } }] } : {}),
  };
  const response = await execute(env, userId, anthropic, requestId);
  const payload = await response.json().catch(() => undefined);
  return response.ok ? json({ ok: true, response: payload }) : json({ ok: false, message: (payload as any)?.error?.message ?? 'Playground request failed', providerError: payload }, response.status);
}