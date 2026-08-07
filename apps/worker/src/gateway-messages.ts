import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
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
} from '../../../packages/protocol/src/index.js';
import type { WorkerDbEnv } from './db.js';

export interface GatewayMessageEnv extends WorkerDbEnv {
  CREDENTIAL_ENCRYPTION_KEY?: string;
  CLIPROXY_BASE_URL?: string;
  UPSTREAM_TIMEOUT_MS?: string | number;
}

type DbClient = ReturnType<typeof createDbClient>;
type Json = Record<string, unknown>;

type GatewayUser = { keyId: string; userId: string };
type Attempt = {
  routeId: string;
  bindingId: string;
  tokenId: string;
  displayName: string;
  upstreamModelId: string;
  apiFormat: 'openai_compatible' | 'anthropic_compatible';
  providerBasePath: string;
  requestPathOverride: string | null;
  maxOutputTokens: number | null;
  supportsReasoning: 'yes' | 'no' | 'unknown';
  connectionId: string;
  connectionName: string;
  baseUrl: string;
  encryptedApiKey: string;
  encryptionIv: string;
  encryptionAuthTag: string;
  rules: Rule[];
};

type Failure = {
  status: number;
  category: string;
  message: string;
  providerError?: Json;
  fallbackable: boolean;
};

const fallbackStatuses = new Set([401, 402, 403, 429, 500, 502, 503, 504]);
const activityWriteInterval = '5 minutes';

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

const anthropicError = (type: string, message: string, requestId: string, status: number) =>
  json(
    { type: 'error', error: { type, message }, request_id: requestId },
    status,
    { 'x-request-id': requestId },
  );

const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

function gatewayToken(request: Request) {
  const authorization = request.headers.get('authorization');
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const xKey = request.headers.get('x-api-key') ?? undefined;
  if (bearer && xKey && bearer !== xKey) return undefined;
  const token = bearer ?? xKey;
  return token?.startsWith('gw_') ? token : undefined;
}

function encryptionKey(value: string) {
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 ? decoded : createHash('sha256').update(value).digest();
}

function decryptCredential(attempt: Attempt, keyValue: string) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(keyValue),
    Buffer.from(attempt.encryptionIv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(attempt.encryptionAuthTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(attempt.encryptedApiKey, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

async function withClient<T>(env: WorkerDbEnv, fn: (client: DbClient) => Promise<T>) {
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

async function authenticate(client: DbClient, token: string): Promise<GatewayUser | undefined> {
  const auth = await client.query<{ id: string; user_id: string }>(
    `SELECT id, user_id
       FROM gateway_keys
      WHERE key_hash = $1
        AND revoked_at IS NULL
      LIMIT 1`,
    [hashSecret(token)],
  );
  const key = auth.rows[0];
  if (!key) return undefined;
  await client.query(
    `UPDATE gateway_keys
        SET last_used_at = NOW()
      WHERE id = $1
        AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '${activityWriteInterval}')`,
    [key.id],
  );
  return { keyId: key.id, userId: key.user_id };
}

function requestContainsImages(request: AnthropicRequest) {
  const scan = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(scan);
    if (!value || typeof value !== 'object') return false;
    const record = value as Json;
    if (record.type === 'image' || record.type === 'image_url' || record.type === 'input_image') return true;
    return record.type === 'tool_result' && scan(record.content);
  };
  return request.messages.some((message) => scan(message.content));
}

async function resolveAttempts(client: DbClient, userId: string, incoming: string, request: AnthropicRequest) {
  const mapping = await client.query<{ id: string }>(
    'SELECT id FROM mappings WHERE user_id = $1 AND alias = $2 LIMIT 1',
    [userId, incoming],
  );
  const mapped = mapping.rows[0]?.id;
  const commonSelect = `
    SELECT br.id AS "routeId",
           br.binding_id AS "bindingId",
           br.token_id AS "tokenId",
           mb.display_name AS "displayName",
           mb.upstream_model_id AS "upstreamModelId",
           mb.api_format AS "apiFormat",
           mb.provider_base_path AS "providerBasePath",
           mb.request_path_override AS "requestPathOverride",
           mb.max_output_tokens AS "maxOutputTokens",
           mb.supports_reasoning AS "supportsReasoning",
           mb.supports_images AS "supportsImages",
           pc.id AS "connectionId",
           pc.display_name AS "connectionName",
           pc.base_url AS "baseUrl",
           ct.encrypted_api_key AS "encryptedApiKey",
           ct.encryption_iv AS "encryptionIv",
           ct.encryption_auth_tag AS "encryptionAuthTag"
  `;
  const healthOrder = `
    CASE br.latest_test_status WHEN 'healthy' THEN 0 WHEN 'failed' THEN 2 ELSE 1 END,
    br.created_at,
    br.id`;
  const rows = mapped
    ? await client.query<Omit<Attempt, 'rules'>>(
        `${commonSelect}
           FROM mapping_routes mr
           JOIN model_bindings mb ON mb.id = mr.binding_id
           JOIN binding_routes br ON br.binding_id = mb.id
           JOIN provider_connections pc ON pc.id = mb.connection_id
           JOIN connection_tokens ct ON ct.id = br.token_id
           LEFT JOIN cliproxy_model_states cms
             ON cms.cliproxy_account_id = mb.cliproxy_account_id
            AND cms.upstream_model_id = mb.upstream_model_id
          WHERE mr.mapping_id = $1
            AND mb.user_id = $2
            AND mr.enabled = TRUE
            AND br.enabled = TRUE
            AND pc.enabled = TRUE
            AND ct.enabled = TRUE
            AND (ct.cooldown_until IS NULL OR ct.cooldown_until <= NOW())
            AND (br.fallback_cooldown_until IS NULL OR br.fallback_cooldown_until <= NOW())
            AND (cms.id IS NULL OR cms.cooldown_until IS NULL OR cms.cooldown_until <= NOW())
          ORDER BY mr.position, ${healthOrder}`,
        [mapped, userId],
      )
    : await client.query<Omit<Attempt, 'rules'>>(
        `${commonSelect}
           FROM binding_routes br
           JOIN model_bindings mb ON mb.id = br.binding_id
           JOIN provider_connections pc ON pc.id = mb.connection_id
           JOIN connection_tokens ct ON ct.id = br.token_id
           LEFT JOIN cliproxy_model_states cms
             ON cms.cliproxy_account_id = mb.cliproxy_account_id
            AND cms.upstream_model_id = mb.upstream_model_id
          WHERE mb.user_id = $1
            AND mb.upstream_model_id = $2
            AND br.enabled = TRUE
            AND pc.enabled = TRUE
            AND ct.enabled = TRUE
            AND (ct.cooldown_until IS NULL OR ct.cooldown_until <= NOW())
            AND (br.fallback_cooldown_until IS NULL OR br.fallback_cooldown_until <= NOW())
            AND (cms.id IS NULL OR cms.cooldown_until IS NULL OR cms.cooldown_until <= NOW())
          ORDER BY ${healthOrder}`,
        [userId, incoming],
      );

  const hasImages = requestContainsImages(request);
  const skipped: Json[] = [];
  const eligible = rows.rows.filter((row) => {
    const supportsImages = (row as unknown as { supportsImages?: string }).supportsImages;
    if (hasImages && supportsImages !== 'yes') {
      skipped.push({
        upstreamModelId: row.upstreamModelId,
        reason: supportsImages === 'no' ? 'images_unsupported' : 'images_capability_unknown',
      });
      return false;
    }
    return true;
  });
  if (!eligible.length) return { attempts: [] as Attempt[], skipped };

  const bindingIds = [...new Set(eligible.map((row) => row.bindingId))];
  const rules = await client.query<{
    binding_id: string;
    type: string;
    enabled: boolean;
    position: number;
    config_json: Json;
  }>(
    `SELECT binding_id, type, enabled, position, config_json
       FROM binding_transformation_rules
      WHERE binding_id = ANY($1::uuid[])
      ORDER BY binding_id, position`,
    [bindingIds],
  );
  const byBinding = new Map<string, Rule[]>();
  for (const rule of rules.rows) {
    const list = byBinding.get(rule.binding_id) ?? [];
    list.push({ type: rule.type, enabled: rule.enabled, position: rule.position, config: rule.config_json ?? {} });
    byBinding.set(rule.binding_id, list);
  }
  return {
    attempts: eligible.map((row) => ({ ...row, rules: byBinding.get(row.bindingId) ?? [] })),
    skipped,
  };
}

function endpointFor(attempt: Attempt, env: GatewayMessageEnv) {
  const defaultPath = attempt.apiFormat === 'openai_compatible' ? '/chat/completions' : '/v1/messages';
  const base =
    attempt.connectionName === 'CLIProxyAPI' && env.CLIPROXY_BASE_URL
      ? env.CLIPROXY_BASE_URL
      : attempt.baseUrl;
  return `${base.replace(/\/+$/, '')}${attempt.requestPathOverride ?? `${attempt.providerBasePath}${defaultPath}`}`;
}

function safeProviderError(value: unknown): Json {
  const root = value && typeof value === 'object' ? (value as Json) : {};
  const error = root.error && typeof root.error === 'object' ? (root.error as Json) : root;
  const result: Json = {};
  for (const key of ['code', 'type', 'param', 'message', 'request_id', 'requestId']) {
    const item = error[key] ?? root[key];
    if (typeof item === 'string' || typeof item === 'number') result[key] = item;
  }
  return Object.keys(result).length ? result : { message: 'Upstream returned an unstructured error.' };
}

async function providerFailure(response: Response): Promise<Failure> {
  let providerError: Json | undefined;
  const text = await response.text().catch(() => '');
  if (text) {
    try {
      providerError = safeProviderError(JSON.parse(text));
    } catch {
      providerError = { message: 'Upstream returned a non-JSON error response.' };
    }
  }
  return {
    status: response.status,
    category:
      response.status === 401 || response.status === 403
        ? 'authentication_error'
        : `upstream_${response.status}`,
    message:
      response.status === 401 || response.status === 403
        ? 'The provider rejected the configured API key.'
        : response.status === 404
          ? 'The upstream endpoint or model was not found.'
          : `The upstream provider returned HTTP ${response.status}.`,
    providerError,
    fallbackable: fallbackStatuses.has(response.status),
  };
}

async function callAttempt(
  attempt: Attempt,
  request: AnthropicRequest,
  clientModel: string,
  env: GatewayMessageEnv,
  signal: AbortSignal,
): Promise<{ body?: unknown; stream?: ReadableStream<Uint8Array>; usage?: StreamUsage }> {
  if (!env.CREDENTIAL_ENCRYPTION_KEY) throw new Error('CREDENTIAL_ENCRYPTION_KEY is not configured');
  const key = decryptCredential(attempt, env.CREDENTIAL_ENCRYPTION_KEY);
  const requestForModel = attempt.maxOutputTokens
    ? { ...request, max_tokens: Math.min(request.max_tokens, attempt.maxOutputTokens) }
    : request;
  let body: Json;
  let headers: Record<string, string>;
  if (attempt.apiFormat === 'openai_compatible') {
    body = await anthropicToOpenAI(
      requestForModel,
      attempt.upstreamModelId,
      {
        supportsReasoning: attempt.supportsReasoning === 'yes',
        supportsReasoningBudget: attempt.supportsReasoning === 'yes',
        supportsReasoningEffort: attempt.supportsReasoning === 'yes',
        supportsAdaptiveReasoning: attempt.supportsReasoning === 'yes',
      },
    );
    body = applyRules(body, attempt.rules, normalizeThinking(requestForModel.thinking, requestForModel.output_config));
    if (requestForModel.stream) body.stream_options = { include_usage: true };
    headers = {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: requestForModel.stream ? 'text/event-stream' : 'application/json',
    };
  } else {
    body = { ...requestForModel, model: attempt.upstreamModelId } as Json;
    headers = {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      accept: requestForModel.stream ? 'text/event-stream' : 'application/json',
    };
  }

  const timeout = Math.max(1_000, Number(env.UPSTREAM_TIMEOUT_MS ?? 60_000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(endpointFor(attempt, env), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw await providerFailure(response);
    if (requestForModel.stream) {
      if (!response.body) throw { status: 502, category: 'empty_stream', message: 'The upstream provider returned an empty stream.', fallbackable: true } satisfies Failure;
      if (attempt.apiFormat === 'anthropic_compatible') return { stream: response.body };
      const usage: StreamUsage = {};
      const source = openAIStreamToAnthropic(parseSSE(response.body), clientModel, undefined, usage);
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(streamController) {
          try {
            for await (const chunk of source) {
              streamController.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
            }
            streamController.close();
          } catch (error) {
            streamController.error(error);
          }
        },
        cancel() {
          controller.abort();
        },
      });
      return { stream, usage };
    }
    const responseBody = (await response.json()) as Json;
    return attempt.apiFormat === 'openai_compatible'
      ? { body: await openAIToAnthropic(responseBody, clientModel) }
      : { body: { ...responseBody, model: clientModel } };
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && 'fallbackable' in error) throw error;
    throw {
      status: 502,
      category: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network_error',
      message: error instanceof Error && error.name === 'AbortError' ? 'The upstream provider timed out.' : 'Could not connect to the upstream provider.',
      fallbackable: true,
    } satisfies Failure;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

async function markFailure(env: WorkerDbEnv, attempt: Attempt, failure: Failure) {
  await withClient(env, async (client) => {
    await client.query(
      `UPDATE binding_routes
          SET latest_test_status = 'failed', latest_test_at = NOW(), latest_error = $2::jsonb,
              latest_error_at = NOW(),
              fallback_cooldown_until = CASE WHEN $3 THEN NOW() + INTERVAL '5 minutes' ELSE fallback_cooldown_until END
        WHERE id = $1`,
      [attempt.routeId, JSON.stringify(failure.providerError ?? { message: failure.message }), failure.fallbackable],
    );
    if (failure.status === 403) {
      await client.query('UPDATE connection_tokens SET cooldown_until = NOW() + INTERVAL \'1 hour\' WHERE id = $1', [attempt.tokenId]);
    } else if (failure.status === 401 || failure.status === 402) {
      await client.query('UPDATE connection_tokens SET enabled = FALSE, updated_at = NOW() WHERE id = $1', [attempt.tokenId]);
    }
  }).catch(() => undefined);
}

async function markSuccess(env: WorkerDbEnv, attempt: Attempt) {
  await withClient(env, (client) => client.query(
    `UPDATE binding_routes
        SET latest_test_status = 'healthy', latest_test_at = NOW(), latest_error = NULL,
            latest_error_at = NULL, fallback_cooldown_until = NULL
      WHERE id = $1`,
    [attempt.routeId],
  )).catch(() => undefined);
}

async function writeLog(
  env: WorkerDbEnv,
  input: {
    userId: string;
    requestId: string;
    incomingModel: string;
    attempt?: Attempt;
    status: number;
    latencyMs: number;
    timeToFirstTokenMs?: number | null;
    fallbackCount?: number;
    errorCategory?: string;
    providerError?: Json;
    skipped?: Json[];
    usage?: StreamUsage;
  },
) {
  await withClient(env, (client) => client.query(
    `INSERT INTO request_logs (
       user_id, request_id, incoming_model, resolved_upstream_model, binding_route_id,
       api_format, status, latency_ms, time_to_first_token_ms, input_tokens, output_tokens,
       cache_input_tokens, fallback_count, error_category, provider_error, skipped_routes
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb)`,
    [
      input.userId,
      input.requestId,
      input.incomingModel,
      input.attempt?.displayName ?? null,
      input.attempt?.routeId ?? null,
      input.attempt?.apiFormat ?? null,
      input.status,
      input.latencyMs,
      input.timeToFirstTokenMs ?? null,
      input.usage?.inputTokens ?? null,
      input.usage?.outputTokens ?? null,
      input.usage?.cacheInputTokens ?? null,
      input.fallbackCount ?? 0,
      input.errorCategory ?? null,
      input.providerError ? JSON.stringify(input.providerError) : null,
      input.skipped?.length ? JSON.stringify(input.skipped) : null,
    ],
  )).catch(() => undefined);
}

export async function handleMessagesRequest(
  request: Request,
  env: GatewayMessageEnv,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== '/v1/messages' && url.pathname !== '/anthropic/v1/messages') return undefined;
  const requestId = request.headers.get('cf-ray') ?? randomUUID();
  if (request.method !== 'POST') return anthropicError('invalid_request_error', 'Method not allowed', requestId, 405);

  const token = gatewayToken(request);
  if (!token) return anthropicError('authentication_error', 'Valid gateway API key required', requestId, 401);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return anthropicError('invalid_request_error', 'Request body must be valid JSON.', requestId, 400);
  }
  const parsed = anthropicRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return anthropicError('invalid_request_error', parsed.error.issues[0]?.message ?? 'Invalid request', requestId, 400);
  }
  const normalized = normalizeSystemMessages(parsed.data);
  const startedAt = Date.now();

  let user: GatewayUser | undefined;
  let attempts: Attempt[] = [];
  let skipped: Json[] = [];
  try {
    await withClient(env, async (client) => {
      user = await authenticate(client, token);
      if (!user) return;
      const resolved = await resolveAttempts(client, user.userId, normalized.model, normalized);
      attempts = resolved.attempts;
      skipped = resolved.skipped;
    });
  } catch {
    return anthropicError('api_error', 'Database is unavailable.', requestId, 503);
  }
  if (!user) return anthropicError('authentication_error', 'Invalid or revoked gateway API key', requestId, 401);
  if (!attempts.length) {
    await writeLog(env, {
      userId: user.userId,
      requestId,
      incomingModel: normalized.model,
      status: 400,
      latencyMs: Date.now() - startedAt,
      errorCategory: 'no_eligible_route',
      skipped,
    });
    return anthropicError('invalid_request_error', `No eligible ${normalized.model} route is configured.`, requestId, 400);
  }

  let lastFailure: Failure | undefined;
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index]!;
    try {
      const result = await callAttempt(attempt, normalized, normalized.model, env, request.signal);
      if (result.stream) {
        const upstreamStream = result.stream;
        const usage = result.usage;
        let firstAt: number | undefined;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const reader = upstreamStream.getReader();
            try {
              while (true) {
                const next = await reader.read();
                if (next.done) break;
                firstAt ??= Date.now();
                controller.enqueue(next.value);
              }
              controller.close();
              await markSuccess(env, attempt);
              await writeLog(env, {
                userId: user!.userId,
                requestId,
                incomingModel: normalized.model,
                attempt,
                status: 200,
                latencyMs: Date.now() - startedAt,
                timeToFirstTokenMs: firstAt ? firstAt - startedAt : null,
                fallbackCount: index,
                skipped,
                usage,
              });
            } catch (error) {
              controller.error(error);
              await writeLog(env, {
                userId: user!.userId,
                requestId,
                incomingModel: normalized.model,
                attempt,
                status: 502,
                latencyMs: Date.now() - startedAt,
                fallbackCount: index,
                errorCategory: 'stream_interrupted',
                skipped,
              });
            } finally {
              reader.releaseLock();
            }
          },
          cancel(reason) {
            return upstreamStream.cancel(reason);
          },
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

      await markSuccess(env, attempt);
      await writeLog(env, {
        userId: user.userId,
        requestId,
        incomingModel: normalized.model,
        attempt,
        status: 200,
        latencyMs: Date.now() - startedAt,
        fallbackCount: index,
        skipped,
      });
      return json(result.body, 200, { 'x-request-id': requestId });
    } catch (error) {
      const failure = error as Failure;
      lastFailure = failure;
      await markFailure(env, attempt, failure);
      if (!failure.fallbackable || index === attempts.length - 1) break;
    }
  }

  await writeLog(env, {
    userId: user.userId,
    requestId,
    incomingModel: normalized.model,
    attempt: attempts.at(-1),
    status: lastFailure?.status ?? 502,
    latencyMs: Date.now() - startedAt,
    fallbackCount: Math.max(0, attempts.length - 1),
    errorCategory: lastFailure?.category ?? 'upstream_error',
    providerError: lastFailure?.providerError,
    skipped,
  });
  return anthropicError(
    lastFailure?.category === 'authentication_error' ? 'authentication_error' : 'api_error',
    lastFailure?.message ?? 'All configured upstream routes failed.',
    requestId,
    lastFailure?.status && lastFailure.status < 500 ? lastFailure.status : 502,
  );
}
