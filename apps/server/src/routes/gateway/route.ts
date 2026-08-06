import type { FastifyInstance, FastifyReply } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { and, asc, eq } from 'drizzle-orm';
import {
  bindingModelConfigs,
  bindingTransformationRules,
  connectionTokens,
  providerConnections,
  runtimeBindingRoutes,
} from '@gateway/db';
import { anthropicError } from '@gateway/shared';
import {
  anthropicRequestSchema,
  normalizeSystemMessages,
  type AnthropicRequest,
} from '@gateway/protocol';
import { gatewayAuth } from '../../auth.js';
import { logWarn } from '../../log.js';
import {
  type ConnectionToken,
  type Attempt,
  type Model,
  type ProviderConnection,
  UpstreamFailure,
  isRecord,
  isCliproxyCredentialCooldown,
  requestContainsImages,
  isImageCapabilityFailure,
  cooldownStatuses,
  fallbackCooldownDurationMs,
  isDisableError,
  thinkingLogConfig,
} from './schema.js';
import { writeLog } from './request-log.js';
import { extractCacheInputTokens } from './usage.js';
import { resolve, toRule } from './resolver.js';
import { callModel } from './upstream-client.js';
import {
  recordCombinationSuccess,
  recordModelFailure,
  placeTokenInCooldown,
  disableToken,
  setModelFallbackCooldown,
  cooldownCliproxyModel,
} from './provider-health.js';

const bindingConfigSelection = {
  displayName: bindingModelConfigs.displayName,
  upstreamModelId: bindingModelConfigs.upstreamModelId,
  providerConnectionId: bindingModelConfigs.connectionId,
  apiFormat: bindingModelConfigs.apiFormat,
  providerBasePath: bindingModelConfigs.providerBasePath,
  requestPathOverride: bindingModelConfigs.requestPathOverride,
  contextLength: bindingModelConfigs.contextLength,
  maxOutputTokens: bindingModelConfigs.maxOutputTokens,
  supportsStreaming: bindingModelConfigs.supportsStreaming,
  supportsTools: bindingModelConfigs.supportsTools,
  supportsImages: bindingModelConfigs.supportsImages,
  supportsReasoning: bindingModelConfigs.supportsReasoning,
};

type BindingConfig = {
  displayName: string;
  upstreamModelId: string;
  providerConnectionId: string;
  apiFormat: Model['apiFormat'];
  providerBasePath: string;
  requestPathOverride: string | null;
  contextLength: number | null;
  maxOutputTokens: number | null;
  supportsStreaming: Model['supportsStreaming'];
  supportsTools: Model['supportsTools'];
  supportsImages: Model['supportsImages'];
  supportsReasoning: Model['supportsReasoning'];
};

type RuntimeRoute = typeof runtimeBindingRoutes.$inferSelect;

function applyBindingConfig(row: {
  model: RuntimeRoute;
  bindingConfig: BindingConfig;
  connection: ProviderConnection;
}): { model: Model; connection: ProviderConnection } {
  return {
    model: { ...row.model, ...row.bindingConfig },
    connection: row.connection,
  };
}

async function loadDashboardModel(app: FastifyInstance, userId: string, id: string) {
  const [row] = await app.db
    .select({
      model: runtimeBindingRoutes,
      bindingConfig: bindingConfigSelection,
      connection: providerConnections,
    })
    .from(runtimeBindingRoutes)
    .innerJoin(bindingModelConfigs, eq(bindingModelConfigs.id, runtimeBindingRoutes.bindingId))
    .innerJoin(
      providerConnections,
      eq(providerConnections.id, bindingModelConfigs.connectionId),
    )
    .where(and(eq(runtimeBindingRoutes.id, id), eq(bindingModelConfigs.userId, userId)))
    .limit(1);
  return row ? applyBindingConfig(row) : undefined;
}

export function requestSignal(request: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  request.once('aborted', () => controller.abort());
  return controller.signal;
}

export async function gatewayRoutes(app: FastifyInstance) {
  app.get(
    '/v1/models',
    { preHandler: (req, reply) => gatewayAuth(app, req, reply) },
    async (req) => {
      const models = await app.db
        .selectDistinct({
          id: bindingModelConfigs.upstreamModelId,
          createdAt: bindingModelConfigs.createdAt,
        })
        .from(bindingModelConfigs)
        .innerJoin(
          runtimeBindingRoutes,
          eq(runtimeBindingRoutes.bindingId, bindingModelConfigs.id),
        )
        .innerJoin(
          providerConnections,
          eq(providerConnections.id, bindingModelConfigs.connectionId),
        )
        .where(
          and(
            eq(bindingModelConfigs.userId, req.gatewayUserId!),
            eq(runtimeBindingRoutes.enabled, true),
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
    const row = await loadDashboardModel(app, userId, id);
    if (!row) return reply.code(404).send({ error: 'Model not found' });

    let token: ConnectionToken | null = null;
    if (row.model.tokenId) {
      const [t] = await app.db
        .select()
        .from(connectionTokens)
        .where(
          and(
            eq(connectionTokens.id, row.model.tokenId),
            eq(connectionTokens.enabled, true),
          ),
        )
        .limit(1);
      token = t ?? null;
    }
    const ruleRows = row.model.bindingId
      ? await app.db
          .select()
          .from(bindingTransformationRules)
          .where(eq(bindingTransformationRules.bindingId, row.model.bindingId))
          .orderBy(asc(bindingTransformationRules.position))
      : [];
    const rules = ruleRows.map(toRule);
    const test: AnthropicRequest = {
      model: row.model.upstreamModelId,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      stream: false,
    };
    try {
      const result = await callModel(
        app,
        { ...row, token, rules },
        test,
        userId,
        row.model.upstreamModelId,
        requestSignal(req.raw),
      );
      await recordCombinationSuccess(app, {
        id: row.model.id,
        tokenId: token?.id ?? null,
        bindingId: row.model.bindingId,
      });
      return {
        ok: true,
        message: 'Authentication, model access, and response conversion succeeded.',
        response: result.body,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Model test failed';
      const latestError =
        error instanceof UpstreamFailure ? (error.providerError ?? { message }) : { message };
      if (error instanceof UpstreamFailure && isCliproxyCredentialCooldown(error))
        await cooldownCliproxyModel(app, row.model, error);
      await app.db
        .update(runtimeBindingRoutes)
        .set({
          latestTestStatus: 'failed',
          latestTestAt: new Date(),
          latestError,
          latestErrorAt: new Date(),
        })
        .where(eq(runtimeBindingRoutes.id, id));
      return reply.code(502).send({ ok: false, message });
    }
  });

  app.post('/api/playground/complete', async (req, reply) => {
    const userId = req.dashboardUser!.id;
    const body = req.body as {
      modelId?: string;
      prompt?: string;
      maxTokens?: number;
      imageBase64?: string;
      imageMediaType?: string;
      includeTestTool?: boolean;
    };
    const modelId = typeof body.modelId === 'string' ? body.modelId : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const maxTokens =
      typeof body.maxTokens === 'number' && body.maxTokens > 0 ? Math.floor(body.maxTokens) : 1024;
    if (!modelId || !prompt)
      return reply.code(400).send({ error: 'modelId and prompt are required' });

    const row = await loadDashboardModel(app, userId, modelId);
    if (!row) return reply.code(404).send({ error: 'Model not found' });

    let token: ConnectionToken | null = null;
    if (row.model.tokenId) {
      const [t] = await app.db
        .select()
        .from(connectionTokens)
        .where(
          and(
            eq(connectionTokens.id, row.model.tokenId),
            eq(connectionTokens.enabled, true),
          ),
        )
        .limit(1);
      token = t ?? null;
    }
    const ruleRows = row.model.bindingId
      ? await app.db
          .select()
          .from(bindingTransformationRules)
          .where(eq(bindingTransformationRules.bindingId, row.model.bindingId))
          .orderBy(asc(bindingTransformationRules.position))
      : [];
    const rules = ruleRows.map(toRule);
    const content: Array<Record<string, unknown>> = [];
    if (body.imageBase64 && body.imageMediaType) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: body.imageMediaType, data: body.imageBase64 },
      });
    }
    content.push({ type: 'text', text: prompt });
    const request = {
      model: row.model.upstreamModelId,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content }],
      stream: false,
      ...(body.includeTestTool
        ? {
            tools: [
              {
                name: 'web_search',
                description: 'Search the web for up-to-date information on a topic.',
                input_schema: {
                  type: 'object',
                  properties: { query: { type: 'string', description: 'The search query' } },
                  required: ['query'],
                },
              },
            ],
          }
        : {}),
    } as unknown as AnthropicRequest;
    try {
      const result = await callModel(
        app,
        { ...row, token, rules },
        request,
        userId,
        row.model.upstreamModelId,
        requestSignal(req.raw),
      );
      await recordCombinationSuccess(app, {
        id: row.model.id,
        tokenId: token?.id ?? null,
        bindingId: row.model.bindingId,
      });
      return { ok: true, response: result.body };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Playground request failed';
      const providerError = error instanceof UpstreamFailure ? error.providerError : undefined;
      return reply.code(502).send({ ok: false, message, providerError });
    }
  });
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
    isRecord(raw) && typeof raw.model === 'string'
      ? (raw.model as string).slice(0, 200)
      : 'unknown';
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
      thinkingConfig: thinkingLogConfig(request),
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
      const result = await callModel(app, attempt.resolved, request, userId, request.model, signal);
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
          await recordCombinationSuccess(app, {
            id: attempt.resolved.model.id,
            tokenId: attempt.resolved.token?.id ?? null,
            bindingId: attempt.resolved.model.bindingId,
          });
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
            thinkingConfig: thinkingLogConfig(request),
            reasoningDetails: result.usage?.reasoningDetails ?? null,
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
            thinkingConfig: thinkingLogConfig(request),
            skippedRoutes: skipped,
          });
        }
        return;
      }
      const body = result.body as Record<string, unknown>;
      const usage = body.usage as Record<string, unknown> | undefined;
      const cacheInputTokens = extractCacheInputTokens(usage);
      const content = body.content as Array<Record<string, unknown>> | undefined;
      const hasReasoningDetails =
        content?.some(
          (block) => block.type === 'thinking' || block.type === 'redacted_thinking',
        ) ?? false;
      await recordCombinationSuccess(app, {
        id: attempt.resolved.model.id,
        tokenId: attempt.resolved.token?.id ?? null,
        bindingId: attempt.resolved.model.bindingId,
      });
      await writeLog(app, {
        userId,
        requestId,
        incomingModel: request.model,
        resolvedUpstreamModel: attempt.resolved.model.displayName,
        resolvedUpstreamModelId: attempt.resolved.model.id,
        apiFormat: attempt.resolved.model.apiFormat,
        status: 200,
        latencyMs: Date.now() - started,
        inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined,
        outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined,
        cacheInputTokens,
        thinkingConfig: thinkingLogConfig(request),
        reasoningDetails: hasReasoningDetails,
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
      await recordModelFailure(app, attempt.resolved.model.id, failure);
      if (isCliproxyCredentialCooldown(failure))
        await cooldownCliproxyModel(app, attempt.resolved.model, failure);
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
      if (cooldownStatuses.has(failure.status) && attempt.resolved.token) {
        await placeTokenInCooldown(app, attempt.resolved.token.id, failure);
      }
      if (isDisableError(failure.status, failure.providerError) && attempt.resolved.token) {
        await disableToken(app, attempt.resolved.token.id, failure);
      }
      const willFallback =
        index < attempts.length - 1 &&
        (failure.fallbackable || cooldownStatuses.has(failure.status) || imageRoutingFailure);
      if (!willFallback) break;

      await setModelFallbackCooldown(app, attempt.resolved.model.id, fallbackCooldownDurationMs);
      logWarn('model placed in short cooldown before fallback', {
        requestId,
        resolvedUpstreamModel: attempt.resolved.model.displayName,
        resolvedUpstreamModelId: attempt.resolved.model.id,
        fallbackCooldownUntil: new Date(Date.now() + fallbackCooldownDurationMs).toISOString(),
      });
    }
  }
  const finalFail =
    failure ?? new UpstreamFailure('No upstream route succeeded.', 502, false, 'upstream_error');
  await writeLog(app, {
    userId,
    requestId,
    incomingModel: request.model,
    resolvedUpstreamModel: lastAttempt?.resolved.model.displayName,
    resolvedUpstreamModelId: lastAttempt?.resolved.model.id,
    apiFormat: lastAttempt?.resolved.model.apiFormat,
    status: finalFail.status,
    latencyMs: Date.now() - started,
    fallbackCount: Math.max(0, attemptedCount - 1),
    errorCategory: finalFail.category,
    providerError: finalFail.providerError,
    skippedRoutes: skipped,
  });
  return reply
    .code(finalFail.status)
    .send(
      anthropicError(
        finalFail.status === 429 ? 'rate_limit_error' : 'api_error',
        finalFail.message,
        requestId,
      ),
    );
}
