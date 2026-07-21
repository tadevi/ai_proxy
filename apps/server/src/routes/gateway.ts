import type { FastifyInstance, FastifyReply } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';
import {
  mappingRoutes,
  mappings,
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
import { decryptCredential, validateUpstreamUrl } from '../security.js';

type Model = typeof upstreamModels.$inferSelect;
type ProviderConnection = typeof providerConnections.$inferSelect;
type ResolvedModel = { model: Model; connection: ProviderConnection };
type Attempt = { resolved: ResolvedModel; routeIndex: number };
type ProviderErrorDetails = {
  upstreamStatus: number;
  requestId?: string;
  response?: unknown;
  responseText?: string;
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

function requestContainsImages(request: AnthropicRequest) {
  return request.messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((block) => block.type === 'image'),
  );
}

function isImageCapabilityFailure(failure: UpstreamFailure) {
  if (failure.status !== 404) return false;
  const detail = JSON.stringify(failure.providerError ?? {}).toLowerCase();
  return detail.includes('image') && /(no endpoints?|not support|unsupported)/.test(detail);
}

const secretField = /api[-_]?key|authorization|token|secret|password|cookie/i;

function redactErrorBody(value: unknown, field = '', depth = 0): unknown {
  if (secretField.test(field)) return '[REDACTED]';
  if (depth >= 8) return '[TRUNCATED]';
  if (typeof value === 'string') return value.slice(0, 8_000);
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redactErrorBody(item, '', depth + 1));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => [key, redactErrorBody(item, key, depth + 1)]),
    );
  return value;
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
    details.response = redactErrorBody(JSON.parse(body));
  } catch {
    details.responseText = body.slice(0, 8_000);
  }
  return details;
}

export async function gatewayRoutes(app: FastifyInstance) {
  app.get(
    '/v1/models',
    { preHandler: (req, reply) => gatewayAuth(app, req, reply) },
    async (req) => {
      const models = await app.db
        .select({ id: upstreamModels.gatewayModelId, createdAt: upstreamModels.createdAt })
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
    const test: AnthropicRequest = {
      model: row.model.gatewayModelId,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      stream: false,
    };
    try {
      const result = await callModel(
        app,
        row,
        test,
        row.model.gatewayModelId,
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
    models = rows.map(({ model, connection, position }) => ({
      resolved: { model, connection },
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
          eq(upstreamModels.gatewayModelId, incoming),
          eq(upstreamModels.enabled, true),
          eq(providerConnections.enabled, true),
          or(isNull(upstreamModels.cooldownUntil), lte(upstreamModels.cooldownUntil, new Date())),
        ),
      )
      .limit(1);
    models = rows.map((resolved) => ({ resolved, position: 0 }));
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
    if (reason) skipped.push({ gatewayModelId: row.resolved.model.gatewayModelId, reason });
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
    app.log.warn(
      { requestId, incomingModel, validationErrors },
      'gateway request validation failed',
    );
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
            resolvedGatewayModel: attempt.resolved.model.gatewayModelId,
            apiFormat: attempt.resolved.model.apiFormat,
            status: 200,
            latencyMs: Date.now() - started,
            timeToFirstTokenMs: first ? first - started : null,
            inputTokens: result.usage?.inputTokens,
            outputTokens: result.usage?.outputTokens,
            fallbackCount: index,
            skippedRoutes: skipped,
          });
        } catch {
          reply.raw.destroy();
          await writeLog(app, {
            userId,
            requestId,
            incomingModel: request.model,
            resolvedGatewayModel: attempt.resolved.model.gatewayModelId,
            apiFormat: attempt.resolved.model.apiFormat,
            status: 502,
            latencyMs: Date.now() - started,
            fallbackCount: index,
            errorCategory: 'stream_interrupted',
            skippedRoutes: skipped,
          });
        }
        return;
      }
      const body = result.body as Record<string, unknown>;
      const usage = body.usage as Record<string, number> | undefined;
      await clearModelError(app, attempt.resolved.model.id);
      await writeLog(app, {
        userId,
        requestId,
        incomingModel: request.model,
        resolvedGatewayModel: attempt.resolved.model.gatewayModelId,
        apiFormat: attempt.resolved.model.apiFormat,
        status: 200,
        latencyMs: Date.now() - started,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
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
      app.log.warn(
        {
          requestId,
          incomingModel: request.model,
          resolvedGatewayModel: attempt.resolved.model.gatewayModelId,
          upstreamStatus: failure.status,
          errorCategory: failure.category,
          providerError: failure.providerError,
        },
        'upstream request failed',
      );
      await setModelError(app, attempt.resolved.model.id, failure);
      const imageCapabilityFailure =
        requestContainsImages(request) && isImageCapabilityFailure(failure);
      if (imageCapabilityFailure) {
        await app.db
          .update(upstreamModels)
          .set({ supportsImages: 'no', updatedAt: new Date() })
          .where(eq(upstreamModels.id, attempt.resolved.model.id));
        skipped.push({
          gatewayModelId: attempt.resolved.model.gatewayModelId,
          reason: 'images_unsupported_by_upstream',
        });
        app.log.warn(
          { requestId, resolvedGatewayModel: attempt.resolved.model.gatewayModelId },
          'model disabled for image requests after upstream capability rejection',
        );
      }
      if (cooldownStatuses.has(failure.status)) {
        const cooldownUntil = new Date(Date.now() + cooldownDurationMs);
        await app.db
          .update(upstreamModels)
          .set({ cooldownUntil, updatedAt: new Date() })
          .where(eq(upstreamModels.id, attempt.resolved.model.id));
        app.log.warn(
          {
            requestId,
            resolvedGatewayModel: attempt.resolved.model.gatewayModelId,
            cooldownUntil,
          },
          'model placed in cooldown after upstream quota or access failure',
        );
      }
      if (
        (!failure.fallbackable &&
          !cooldownStatuses.has(failure.status) &&
          !imageCapabilityFailure) ||
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
    resolvedGatewayModel: lastAttempt?.resolved.model.gatewayModelId,
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
  const { model, connection } = resolved;
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
    const key = decryptCredential(connection, app.config.CREDENTIAL_ENCRYPTION_KEY);
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
        fallbackStatuses.has(response.status) || cooldownStatuses.has(response.status),
        response.status === 401 || response.status === 403
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
  await app.db.insert(requestLogs).values(values);
}

function requestSignal(request: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  request.once('aborted', () => controller.abort());
  return controller.signal;
}
