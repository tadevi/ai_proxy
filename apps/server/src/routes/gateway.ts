import type { FastifyInstance, FastifyReply } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  connectionTokens,
  mappingRoutes,
  mappings,
  modelUsageDaily,
  providerConnections,
  requestLogs,
  transformationRules,
  upstreamModels,
} from '@gateway/db';
import { anthropicError } from '@gateway/shared';
import {
  anthropicRequestSchema,
  anthropicToOpenAI,
  applyRules,
  normalizeThinking,
  normalizeSystemMessages,
  openAIStreamToAnthropic,
  openAIToAnthropic,
  parseSSE,
  type AnthropicRequest,
  type Rule,
  type StreamUsage,
} from '@gateway/protocol';
import { gatewayAuth } from '../auth.js';
import { logWarn } from '../log.js';
import { decryptCredential, validateUpstreamUrl } from '../security.js';

type Model = typeof upstreamModels.$inferSelect;
type ProviderConnection = typeof providerConnections.$inferSelect;
type ConnectionToken = typeof connectionTokens.$inferSelect;
type ResolvedModel = { model: Model; connection: ProviderConnection; token: ConnectionToken | null };
type Attempt = { resolved: ResolvedModel; routeIndex: number };
type ProviderErrorDetails = {
  upstreamStatus: number;
  requestId?: string;
  response?: Record<string, unknown>;
};
class UpstreamFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fallbackable: boolean,
    readonly category: string,
    readonly providerError?: ProviderErrorDetails,
  ) {
    super(message);
  }
}
const fallbackStatuses = new Set([429, 500, 502, 503, 504]);
const cooldownStatuses = new Set([403]);
const disableStatuses = new Set([401, 402]);
const disableErrorTypes = new Set(['insufficient_balance', 'quota_exceeded', 'billing_error']);
const cooldownDurationMs = 60 * 60 * 1_000;
const safeProviderMessage = (status: number) =>
  status === 401 || status === 403
    ? 'The provider rejected the configured API key.'
    : status === 404
      ? 'The upstream endpoint or model was not found.'
      : `The upstream provider returned HTTP ${status}.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function containsImageContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsImageContent(item));
  if (!isRecord(value)) return false;
  if (value.type === 'image' || value.type === 'image_url' || value.type === 'input_image')
    return true;
  // Claude Code can attach screenshots inside a tool result. Do not inspect
  // arbitrary tool input/metadata: `{ type: 'image' }` may be application data.
  return value.type === 'tool_result' && containsImageContent(value.content);
}

export function requestContainsImages(request: AnthropicRequest) {
  return request.messages.some((message) => containsImageContent(message.content));
}

function isImageCapabilityFailure(failure: UpstreamFailure) {
  if (failure.status !== 404) return false;
  const detail = JSON.stringify(failure.providerError ?? {}).toLowerCase();
  return detail.includes('image') && /(no endpoints?|not support|unsupported)/.test(detail);
}

function isDisableError(status: number, providerError?: ProviderErrorDetails): boolean {
  if (disableStatuses.has(status)) return true;
  const type = (providerError?.response as Record<string, unknown> | undefined)?.type;
  return typeof type === 'string' && disableErrorTypes.has(type);
}

export function safeProviderErrorBody(value: unknown): Record<string, unknown> {
  const root = isRecord(value) ? value : {};
  const error = isRecord(root.error) ? root.error : root;
  const allowed = ['code', 'type', 'param', 'message', 'request_id', 'requestId'];
  const details = Object.fromEntries(
    allowed
      .map((key) => [key, error[key]] as const)
      .filter(([, item]) => typeof item === 'string' || typeof item === 'number'),
  );
  for (const key of ['request_id', 'requestId']) {
    if (
      details[key] === undefined &&
      (typeof root[key] === 'string' || typeof root[key] === 'number')
    )
      details[key] = root[key];
  }
  return Object.keys(details).length
    ? details
    : { message: 'Upstream returned an unstructured error.' };
}

async function readProviderError(response: Response): Promise<ProviderErrorDetails> {
  const details: ProviderErrorDetails = { upstreamStatus: response.status };
  const requestId =
    response.headers.get('request-id') ??
    response.headers.get('x-request-id') ??
    response.headers.get('trace-id');
  if (requestId) details.requestId = requestId.slice(0, 200);
  const body = await response.text();
  if (!body) return details;
  try {
    details.response = safeProviderErrorBody(JSON.parse(body));
  } catch {
    const ssePayload = body.match(/^\s*(?:event:[^\n]*\n)?data:\s*(.+?)(?:\n\n|$)/s)?.[1];
    if (ssePayload) {
      try {
        details.response = safeProviderErrorBody(JSON.parse(ssePayload));
        return details;
      } catch {
        // Fall through to the generic safe message.
      }
    }
    details.response = { message: 'Upstream returned a non-JSON error response.' };
  }
  return details;
}

export async function gatewayRoutes(app: FastifyInstance) {
  app.get(
    '/v1/models',
    { preHandler: (req, reply) => gatewayAuth(app, req, reply) },
    async (req) => {
      const models = await app.db
        .select({ id: upstreamModels.upstreamModelId, createdAt: upstreamModels.createdAt })
        .from(upstreamModels)
        .innerJoin(
          providerConnections,
          eq(providerConnections.id, upstreamModels.providerConnectionId),
        )
        .where(
          and(
            eq(upstreamModels.userId, req.gatewayUserId!),
            eq(upstreamModels.enabled, true),
            eq(providerConnections.enabled, true),
          ),
        );
      return {
        object: 'list',
        data: models.map((m) => ({
          id: m.id,
          type: 'model',
          display_name: m.id,
          created_at: Math.floor(m.createdAt.getTime() / 1000),
        })),
      };
    },
  );
  app.post(
    '/v1/messages',
    { preHandler: (req, reply) => gatewayAuth(app, req, reply) },
    async (req, reply) =>
      handleMessage(app, req.body, req.gatewayUserId!, reply, req.id, requestSignal(req.raw)),
  );
  app.post(
    '/anthropic/v1/messages',
    { preHandler: (req, reply) => gatewayAuth(app, req, reply) },
    async (req, reply) =>
      handleMessage(app, req.body, req.gatewayUserId!, reply, req.id, requestSignal(req.raw)),
  );
  app.post('/api/models/:id/test', async (req, reply) => {
    const userId = req.dashboardUser!.id;
    const id = (req.params as { id: string }).id;
    const [row] = await app.db
      .select({ model: upstreamModels, connection: providerConnections })
      .from(upstreamModels)
      .innerJoin(
        providerConnections,
        eq(providerConnections.id, upstreamModels.providerConnectionId),
      )
      .where(and(eq(upstreamModels.id, id), eq(upstreamModels.userId, userId)))
      .limit(1);
    if (!row) return reply.code(404).send({ error: 'Model not found' });
    let token: ConnectionToken | null = null;
    if (row.model.tokenId) {
      const [t] = await app.db
        .select()
        .from(connectionTokens)
        .where(eq(connectionTokens.id, row.model.tokenId))
        .limit(1);
      token = t ?? null;
    }
    const test: AnthropicRequest = {
      model: row.model.upstreamModelId,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      stream: false,
    };
    try {
      const result = await callModel(
        app,
        { ...row, token },
        test,
        row.model.upstreamModelId,
        requestSignal(req.raw),
      );
      await app.db
        .update(upstreamModels)
        .set({
          latestTestStatus: 'healthy',
          latestTestAt: new Date(),
          cooldownUntil: null,
          latestError: null,
          latestErrorAt: null,
        })
        .where(eq(upstreamModels.id, id));
      return {
        ok: true,
        message: 'Authentication, model access, and response conversion succeeded.',
        response: result.body,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Model test failed';
      const latestError =
        error instanceof UpstreamFailure ? (error.providerError ?? { message }) : { message };
      await app.db
        .update(upstreamModels)
        .set({
          latestTestStatus: 'failed',
          latestTestAt: new Date(),
          latestError,
          latestErrorAt: new Date(),
        })
        .where(eq(upstreamModels.id, id));
      return reply.code(502).send({ ok: false, message });
    }
  });
}

async function resolve(
  app: FastifyInstance,
  userId: string,
  incoming: string,
  request: AnthropicRequest,
): Promise<{ attempts: Attempt[]; skipped: object[] }> {
  const hasImages = requestContainsImages(request);
  const [mapping] = await app.db
    .select({ id: mappings.id })
    .from(mappings)
    .where(and(eq(mappings.userId, userId), eq(mappings.alias, incoming)))
    .limit(1);
  let models: Array<{ resolved: ResolvedModel; position: number }>;
  if (mapping) {
    const rows = await app.db
      .select({
        model: upstreamModels,
        connection: providerConnections,
        position: mappingRoutes.position,
      })
      .from(mappingRoutes)
      .innerJoin(upstreamModels, eq(upstreamModels.id, mappingRoutes.upstreamModelId))
      .innerJoin(
        providerConnections,
        eq(providerConnections.id, upstreamModels.providerConnectionId),
      )
      .where(
        and(
          eq(mappingRoutes.mappingId, mapping.id),
          eq(mappingRoutes.enabled, true),
          eq(upstreamModels.enabled, true),
          eq(providerConnections.enabled, true),
          or(isNull(upstreamModels.cooldownUntil), lte(upstreamModels.cooldownUntil, new Date())),
        ),
      )
      .orderBy(asc(mappingRoutes.position));
    const tokenIds = [...new Set(rows.map((r) => r.model.tokenId).filter((id): id is string => id != null))];
    const tokens = tokenIds.length
      ? await app.db
          .select()
          .from(connectionTokens)
          .where(inArray(connectionTokens.id, tokenIds))
      : [];
    const tokenMap = new Map(tokens.map((t) => [t.id, t]));
    models = rows.map(({ model, connection, position }) => ({
      resolved: { model, connection, token: model.tokenId ? (tokenMap.get(model.tokenId) ?? null) : null },
      position,
    }));
  } else {
    const rows = await app.db
      .select({ model: upstreamModels, connection: providerConnections })
      .from(upstreamModels)
      .innerJoin(
        providerConnections,
        eq(providerConnections.id, upstreamModels.providerConnectionId),
      )
      .where(
        and(
          eq(upstreamModels.userId, userId),
          eq(upstreamModels.upstreamModelId, incoming),
          eq(upstreamModels.enabled, true),
          eq(providerConnections.enabled, true),
          or(isNull(upstreamModels.cooldownUntil), lte(upstreamModels.cooldownUntil, new Date())),
        ),
      )
      .limit(1);
    const tokenIds = [...new Set(rows.map((r) => r.model.tokenId).filter((id): id is string => id != null))];
    const tokens = tokenIds.length
      ? await app.db
          .select()
          .from(connectionTokens)
          .where(inArray(connectionTokens.id, tokenIds))
      : [];
    const tokenMap = new Map(tokens.map((t) => [t.id, t]));
    models = rows.map((resolved) => ({
      resolved: { ...resolved, token: resolved.model.tokenId ? (tokenMap.get(resolved.model.tokenId) ?? null) : null },
      position: 0,
    }));
  }
  const skipped: object[] = [];
  const attempts: Attempt[] = [];
  for (const row of models) {
    const reason =
      hasImages && row.resolved.model.supportsImages !== 'yes'
        ? row.resolved.model.supportsImages === 'no'
          ? 'images_unsupported'
          : 'images_capability_unknown'
        : null;
    if (reason) skipped.push({ upstreamModelId: row.resolved.model.upstreamModelId, reason });
    else attempts.push({ resolved: row.resolved, routeIndex: row.position });
  }
  return { attempts, skipped };
}

async function handleMessage(
  app: FastifyInstance,
  raw: unknown,
  userId: string,
  reply: FastifyReply,
  requestId: string,
  signal: AbortSignal,
) {
  const started = Date.now();
  const incomingModel =
    isRecord(raw) && typeof raw.model === 'string' ? raw.model.slice(0, 200) : 'unknown';
  const parsed = anthropicRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const validationErrors = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    logWarn('gateway request validation failed', { requestId, incomingModel, validationErrors });
    await writeLog(app, {
      userId,
      requestId,
      incomingModel,
      status: 400,
      latencyMs: Date.now() - started,
      errorCategory: 'invalid_request',
      providerError: {
        validationErrors,
      },
    });
    return reply
      .code(400)
      .send(
        anthropicError(
          'invalid_request_error',
          parsed.error.issues[0]?.message ?? 'Invalid request',
          requestId,
        ),
      );
  }
  const request = normalizeSystemMessages(parsed.data);
  const { attempts, skipped } = await resolve(app, userId, request.model, request);
  if (!attempts.length) {
    await writeLog(app, {
      userId,
      requestId,
      incomingModel: request.model,
      status: 400,
      latencyMs: Date.now() - started,
      errorCategory: 'no_eligible_route',
      thinkingConfig: request.thinking ?? null,
      skippedRoutes: skipped,
    });
    return reply
      .code(400)
      .send(
        anthropicError(
          'invalid_request_error',
          `No eligible ${request.model} route is configured.`,
          requestId,
        ),
      );
  }
  let failure: UpstreamFailure | undefined;
  let lastAttempt: Attempt | undefined;
  let attemptedCount = 0;
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index]!;
    try {
      attemptedCount++;
      lastAttempt = attempt;
      const result = await callModel(app, attempt.resolved, request, request.model, signal);
      if (result.stream) {
        reply.hijack();
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-request-id': requestId,
        });
        let first: number | undefined;
        try {
          for await (const chunk of result.stream) {
            first ??= Date.now();
            if (!reply.raw.write(chunk))
              await new Promise<void>((resolve) => reply.raw.once('drain', resolve));
          }
          reply.raw.end();
          await clearModelError(app, attempt.resolved.model.id);
          await writeLog(app, {
            userId,
            requestId,
            incomingModel: request.model,
            resolvedUpstreamModel: attempt.resolved.model.displayName,
            resolvedUpstreamModelId: attempt.resolved.model.id,
            apiFormat: attempt.resolved.model.apiFormat,
            status: 200,
            latencyMs: Date.now() - started,
            timeToFirstTokenMs: first ? first - started : null,
            inputTokens: result.usage?.inputTokens,
            outputTokens: result.usage?.outputTokens,
            cacheInputTokens: result.usage?.cacheInputTokens,
            thinkingConfig: request.thinking ?? null,
            fallbackCount: index,
            skippedRoutes: skipped,
          });
        } catch {
          reply.raw.destroy();
          await writeLog(app, {
            userId,
            requestId,
            incomingModel: request.model,
            resolvedUpstreamModel: attempt.resolved.model.displayName,
            resolvedUpstreamModelId: attempt.resolved.model.id,
            apiFormat: attempt.resolved.model.apiFormat,
            status: 502,
            latencyMs: Date.now() - started,
            fallbackCount: index,
            errorCategory: 'stream_interrupted',
            thinkingConfig: request.thinking ?? null,
            skippedRoutes: skipped,
          });
        }
        return;
      }
      const body = result.body as Record<string, unknown>;
      const usage = body.usage as Record<string, number> | undefined;
      const cacheTokens =
        (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
      await clearModelError(app, attempt.resolved.model.id);
      await writeLog(app, {
        userId,
        requestId,
        incomingModel: request.model,
        resolvedUpstreamModel: attempt.resolved.model.displayName,
            resolvedUpstreamModelId: attempt.resolved.model.id,
        apiFormat: attempt.resolved.model.apiFormat,
        status: 200,
        latencyMs: Date.now() - started,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        cacheInputTokens: cacheTokens || undefined,
        thinkingConfig: request.thinking ?? null,
        fallbackCount: index,
        skippedRoutes: skipped,
      });
      return reply.header('x-request-id', requestId).send(body);
    } catch (error) {
      failure =
        error instanceof UpstreamFailure
          ? error
          : new UpstreamFailure(
              'Could not connect to the upstream provider.',
              502,
              true,
              'network_error',
            );
      logWarn('upstream request failed', {
        requestId,
        incomingModel: request.model,
        resolvedUpstreamModel: attempt.resolved.model.displayName,
            resolvedUpstreamModelId: attempt.resolved.model.id,
        upstreamStatus: failure.status,
        errorCategory: failure.category,
        providerError: failure.providerError,
      });
      await setModelError(app, attempt.resolved.model.id, failure);
      const imageRoutingFailure =
        requestContainsImages(request) && isImageCapabilityFailure(failure);
      if (imageRoutingFailure) {
        skipped.push({
          upstreamModelId: attempt.resolved.model.upstreamModelId,
          reason: 'images_unavailable_upstream',
        });
        logWarn('upstream has no image-capable endpoint available; trying the next image route', {
          requestId,
          resolvedUpstreamModel: attempt.resolved.model.displayName,
            resolvedUpstreamModelId: attempt.resolved.model.id,
        });
      }
      if (cooldownStatuses.has(failure.status)) {
        const cooldownUntil = new Date(Date.now() + cooldownDurationMs);
        await app.db
          .update(upstreamModels)
          .set({ cooldownUntil, updatedAt: new Date() })
          .where(eq(upstreamModels.id, attempt.resolved.model.id));
        logWarn('model placed in cooldown after upstream quota or access failure', {
          requestId,
          resolvedUpstreamModel: attempt.resolved.model.displayName,
            resolvedUpstreamModelId: attempt.resolved.model.id,
          cooldownUntil: cooldownUntil.toISOString(),
        });
      }
      if (isDisableError(failure.status, failure.providerError)) {
        await app.db
          .update(upstreamModels)
          .set({ enabled: false, updatedAt: new Date() })
          .where(eq(upstreamModels.id, attempt.resolved.model.id));
        logWarn('model auto-disabled after upstream payment or auth failure', {
          requestId,
          resolvedUpstreamModel: attempt.resolved.model.displayName,
            resolvedUpstreamModelId: attempt.resolved.model.id,
          status: failure.status,
        });
      }
      if (
        (!failure.fallbackable && !cooldownStatuses.has(failure.status) && !imageRoutingFailure) ||
        index === attempts.length - 1
      )
        break;
    }
  }
  const final =
    failure ?? new UpstreamFailure('No upstream route succeeded.', 502, false, 'upstream_error');
  await writeLog(app, {
    userId,
    requestId,
    incomingModel: request.model,
    resolvedUpstreamModel: lastAttempt?.resolved.model.displayName,
    resolvedUpstreamModelId: lastAttempt?.resolved.model.id,
    apiFormat: lastAttempt?.resolved.model.apiFormat,
    status: final.status,
    latencyMs: Date.now() - started,
    fallbackCount: Math.max(0, attemptedCount - 1),
    errorCategory: final.category,
    providerError: final.providerError,
    skippedRoutes: skipped,
  });
  return reply
    .code(final.status)
    .send(
      anthropicError(
        final.status === 429 ? 'rate_limit_error' : 'api_error',
        final.message,
        requestId,
      ),
    );
}

async function callModel(
  app: FastifyInstance,
  resolved: ResolvedModel,
  request: AnthropicRequest,
  clientModel: string,
  clientSignal: AbortSignal,
): Promise<{
  body?: unknown;
  stream?: AsyncIterable<string | Uint8Array>;
  usage?: StreamUsage;
}> {
  const { model, connection, token } = resolved;
  const endpoint = requestEndpoint(model, connection);
  await validateUpstreamUrl(
    endpoint,
    app.config.ALLOW_PRIVATE_UPSTREAMS,
    app.config.NODE_ENV === 'production',
  );
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetTimeout = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), app.config.UPSTREAM_TIMEOUT_MS);
  };
  const abort = () => controller.abort();
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    clientSignal.removeEventListener('abort', abort);
  };
  let streamOwnsCleanup = false;
  resetTimeout();
  clientSignal.addEventListener('abort', abort, { once: true });
  try {
    if (!token)
      throw new UpstreamFailure('No API token configured for this model.', 500, false, 'configuration_error');
    const key = decryptCredential(token, app.config.CREDENTIAL_ENCRYPTION_KEY);
    const requestForModel = model.maxOutputTokens
      ? { ...request, max_tokens: Math.min(request.max_tokens, model.maxOutputTokens) }
      : request;
    let body: Record<string, unknown>;
    let headers: Record<string, string>;
    if (model.apiFormat === 'openai_compatible') {
      const ruleRows = await app.db
        .select()
        .from(transformationRules)
        .where(eq(transformationRules.upstreamModelId, model.id))
        .orderBy(asc(transformationRules.position));
      const rules = ruleRows.map((r) => ({
        type: r.type,
        enabled: r.enabled,
        position: r.position,
        config: r.configJson as Record<string, unknown>,
      })) satisfies Rule[];
      body = anthropicToOpenAI(requestForModel, model.upstreamModelId);
      body = applyRules(body, rules, normalizeThinking(requestForModel.thinking));
      if (requestForModel.stream) body.stream_options = { include_usage: true };
      headers = {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: requestForModel.stream ? 'text/event-stream' : 'application/json',
      };
    } else {
      body = { ...requestForModel, model: model.upstreamModelId };
      headers = {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        accept: requestForModel.stream ? 'text/event-stream' : 'application/json',
      };
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      const providerError = await readProviderError(response);
      throw new UpstreamFailure(
        safeProviderMessage(response.status),
        response.status,
        fallbackStatuses.has(response.status) || cooldownStatuses.has(response.status) || isDisableError(response.status, providerError),
        isDisableError(response.status, providerError)
          ? 'disabled_upstream'
          : response.status === 401 || response.status === 403
            ? 'authentication_error'
            : `upstream_${response.status}`,
        providerError,
      );
    }
    if (requestForModel.stream) {
      if (!response.body)
        throw new UpstreamFailure(
          'The upstream provider returned an empty stream.',
          502,
          true,
          'empty_stream',
        );
      const usage: StreamUsage = {};
      const source =
        model.apiFormat === 'openai_compatible'
          ? openAIStreamToAnthropic(parseSSE(response.body), clientModel, undefined, usage)
          : rawStream(response.body, usage);
      streamOwnsCleanup = true;
      return {
        stream: managedStream(source, resetTimeout, cleanup),
        usage,
      };
    }
    const json = (await response.json()) as Record<string, unknown>;
    return {
      body:
        model.apiFormat === 'openai_compatible'
          ? openAIToAnthropic(json, clientModel)
          : { ...json, model: clientModel },
    };
  } catch (error) {
    if (error instanceof UpstreamFailure) throw error;
    throw new UpstreamFailure(
      error instanceof Error && error.name === 'AbortError'
        ? 'The upstream provider timed out.'
        : 'Could not connect to the upstream provider.',
      502,
      true,
      error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network_error',
    );
  } finally {
    if (!streamOwnsCleanup) cleanup();
  }
}

async function* managedStream(
  source: AsyncIterable<string | Uint8Array>,
  resetTimeout: () => void,
  cleanup: () => void,
) {
  try {
    for await (const chunk of source) {
      resetTimeout();
      yield chunk;
    }
  } finally {
    cleanup();
  }
}

async function* rawStream(body: ReadableStream<Uint8Array>, usage: StreamUsage) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const readUsage = (payload: string) => {
    try {
      const event = JSON.parse(payload) as Record<string, unknown>;
      const message = event.message as Record<string, unknown> | undefined;
      const eventUsage = (message?.usage ?? event.usage) as Record<string, unknown> | undefined;
      if (typeof eventUsage?.input_tokens === 'number') usage.inputTokens = eventUsage.input_tokens;
      if (typeof eventUsage?.output_tokens === 'number')
        usage.outputTokens = eventUsage.output_tokens;
      if (typeof eventUsage?.cache_creation_input_tokens === 'number')
        usage.cacheInputTokens = (usage.cacheInputTokens ?? 0) + eventUsage.cache_creation_input_tokens;
      if (typeof eventUsage?.cache_read_input_tokens === 'number')
        usage.cacheInputTokens = (usage.cacheInputTokens ?? 0) + eventUsage.cache_read_input_tokens;
    } catch {
      // Preserve malformed or non-JSON SSE data for the client without logging usage.
    }
  };
  const consume = (text: string) => {
    buffer += text;
    const records = buffer.split(/\r?\n\r?\n/);
    buffer = records.pop() ?? '';
    for (const record of records)
      for (const line of record.split(/\r?\n/))
        if (line.startsWith('data:')) readUsage(line.slice(5).trim());
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      consume(decoder.decode(value, { stream: true }));
      yield value;
    }
    consume(decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

function requestEndpoint(model: Model, connection: ProviderConnection) {
  const defaultPath =
    model.apiFormat === 'openai_compatible' ? '/chat/completions' : '/v1/messages';
  return `${connection.baseUrl.replace(/\/+$/, '')}${model.requestPathOverride ?? `${model.providerBasePath}${defaultPath}`}`;
}

async function clearModelError(app: FastifyInstance, modelId: string) {
  await app.db
    .update(upstreamModels)
    .set({ latestError: null, latestErrorAt: null, updatedAt: new Date() })
    .where(eq(upstreamModels.id, modelId));
}

async function setModelError(app: FastifyInstance, modelId: string, failure: UpstreamFailure) {
  await app.db
    .update(upstreamModels)
    .set({
      latestError: failure.providerError ?? {
        upstreamStatus: failure.status,
        errorCategory: failure.category,
        message: failure.message,
      },
      latestErrorAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(upstreamModels.id, modelId));
}

async function writeLog(app: FastifyInstance, values: typeof requestLogs.$inferInsert) {
  await app.db.transaction(async (tx) => {
    await tx.insert(requestLogs).values(values);
    if (!values.resolvedUpstreamModelId) return;
    const usageDate = new Date().toISOString().slice(0, 10);
    await tx
      .insert(modelUsageDaily)
      .values({
        userId: values.userId,
        upstreamModelId: values.resolvedUpstreamModelId,
        usageDate,
        requestCount: 1,
        inputTokens: values.inputTokens ?? 0,
        outputTokens: values.outputTokens ?? 0,
        cacheInputTokens: values.cacheInputTokens ?? 0,
      })
      .onConflictDoUpdate({
        target: [modelUsageDaily.userId, modelUsageDaily.upstreamModelId, modelUsageDaily.usageDate],
        set: {
          requestCount: sql`${modelUsageDaily.requestCount} + 1`,
          inputTokens: sql`${modelUsageDaily.inputTokens} + ${values.inputTokens ?? 0}`,
          outputTokens: sql`${modelUsageDaily.outputTokens} + ${values.outputTokens ?? 0}`,
          cacheInputTokens: sql`${modelUsageDaily.cacheInputTokens} + ${values.cacheInputTokens ?? 0}`,
        },
      });
  });
}

function requestSignal(request: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  request.once('aborted', () => controller.abort());
  return controller.signal;
}
