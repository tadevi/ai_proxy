import type { FastifyInstance } from 'fastify';
import {
  anthropicToOpenAI,
  applyRules,
  normalizeThinking,
  openAIToAnthropic,
  openAIStreamToAnthropic,
  parseSSE,
  type AnthropicRequest,
  type ReasoningCapabilities,
  type ReasoningWireFormat,
  type StreamUsage,
} from '@gateway/protocol';
import { decryptCredential, validateUpstreamUrl } from '../../security.js';
import { logWarn } from '../../log.js';
import { createReasoningStateStore } from '../../reasoning-state.js';
import {
  type ResolvedModel,
  type ProviderConnection,
  type ProviderErrorDetails,
  UpstreamFailure,
  fallbackStatuses,
  cooldownStatuses,
  isDisableError,
  safeProviderMessage,
  safeProviderErrorBody,
} from './schema.js';
import { managedStream, rawStream } from './stream-handler.js';

const reasoningState = createReasoningStateStore();

export function requestEndpoint(
  model: ResolvedModel['model'],
  connection: ProviderConnection,
  cliproxyBaseUrl?: string,
) {
  const defaultPath = model.apiFormat === 'openai_compatible' ? '/chat/completions' : '/v1/messages';
  const baseUrl =
    connection.displayName === 'CLIProxyAPI' && cliproxyBaseUrl
      ? cliproxyBaseUrl
      : connection.baseUrl;
  return `${baseUrl.replace(/\/+$/, '')}${model.requestPathOverride ?? `${model.providerBasePath}${defaultPath}`}`;
}

export function reasoningWireFormat(connection: ProviderConnection): ReasoningWireFormat {
  try {
    return new URL(connection.baseUrl).hostname.toLowerCase() === 'inference.poolside.ai'
      ? 'reasoning_content'
      : 'reasoning_details';
  } catch {
    return 'reasoning_details';
  }
}

export function resolvedReasoningWireFormat(
  resolved: Pick<ResolvedModel, 'connection' | 'reasoningCodec'>,
  cliproxyBaseUrl?: string,
): ReasoningWireFormat {
  const isCliproxy =
    !!cliproxyBaseUrl &&
    resolved.connection.baseUrl.replace(/\/$/, '') === cliproxyBaseUrl.replace(/\/$/, '');
  if (isCliproxy || !resolved.reasoningCodec || resolved.reasoningCodec === 'auto')
    return reasoningWireFormat(resolved.connection);
  return resolved.reasoningCodec;
}

export async function readProviderError(response: Response): Promise<ProviderErrorDetails> {
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

export async function callModel(
  app: FastifyInstance,
  resolved: ResolvedModel,
  request: AnthropicRequest,
  userId: string,
  clientModel: string,
  clientSignal: AbortSignal,
): Promise<{
  body?: unknown;
  stream?: AsyncIterable<string | Uint8Array>;
  usage?: StreamUsage;
}> {
  const { model, connection, token, rules } = resolved;
  const endpoint = requestEndpoint(model, connection, app.config.CLIPROXY_BASE_URL);
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
      throw new UpstreamFailure(
        'No API token configured for this model.',
        500,
        false,
        'configuration_error',
      );
    const key = decryptCredential(token, app.config.CREDENTIAL_ENCRYPTION_KEY);
    const requestForModel = model.maxOutputTokens
      ? { ...request, max_tokens: Math.min(request.max_tokens, model.maxOutputTokens) }
      : request;
    let body: Record<string, unknown>;
    let headers: Record<string, string>;
    if (model.apiFormat === 'openai_compatible') {
      const capabilities: ReasoningCapabilities = {
        supportsReasoning: model.supportsReasoning === 'yes',
        supportsReasoningBudget: model.supportsReasoning === 'yes',
        supportsReasoningEffort: model.supportsReasoning === 'yes',
        supportsAdaptiveReasoning: model.supportsReasoning === 'yes',
      };
      body = await anthropicToOpenAI(
        requestForModel,
        model.upstreamModelId,
        capabilities,
        async (signature) => {
          const state = await reasoningState.resolve(signature, {
            userId,
            connectionId: connection.id,
            upstreamModelId: model.upstreamModelId,
          });
          logWarn('reasoning proxy signature received', {
            upstreamModelId: model.upstreamModelId,
            resolved: Boolean(state),
          });
          return state ? { data: state.data, format: state.format } : null;
        },
        resolvedReasoningWireFormat(resolved, app.config.CLIPROXY_BASE_URL),
      );
      const signatureCount = Array.isArray(body.messages)
        ? body.messages.reduce((count, message) => {
            if (!message || typeof message !== 'object') return count;
            const details = (message as Record<string, unknown>).reasoning_details;
            return Array.isArray(details)
              ? count +
                details.filter(
                  (detail) =>
                    detail &&
                    typeof detail === 'object' &&
                    typeof (detail as Record<string, unknown>).signature === 'string',
                ).length
              : count;
          }, 0)
        : 0;
      if (signatureCount) {
        logWarn('reasoning provider signatures forwarded', {
          upstreamModelId: model.upstreamModelId,
          signatureCount,
        });
      }
      body = applyRules(
        body,
        rules,
        normalizeThinking(requestForModel.thinking, requestForModel.output_config),
      );
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
        fallbackStatuses.has(response.status) ||
          cooldownStatuses.has(response.status) ||
          isDisableError(response.status, providerError),
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
          ? openAIStreamToAnthropic(
              parseSSE(response.body),
              clientModel,
              undefined,
              usage,
              async (detail) => {
                const handle = await reasoningState.store({
                  data: detail.data,
                  format: detail.format ?? 'unknown',
                  userId,
                  connectionId: connection.id,
                  upstreamModelId: model.upstreamModelId,
                  createdAt: Date.now(),
                });
                logWarn('foreign encrypted reasoning stored (stream)', {
                  upstreamModelId: model.upstreamModelId,
                  format: detail.format,
                });
                return handle;
              },
            )
          : rawStream(response.body, usage);
      streamOwnsCleanup = true;
      return {
        stream: managedStream(source, resetTimeout, cleanup),
        usage,
      };
    }
    const json = (await response.json()) as Record<string, unknown>;
    if (model.apiFormat !== 'openai_compatible') return { body: { ...json, model: clientModel } };
    return {
      body: await openAIToAnthropic(
        json,
        clientModel,
        { upstreamProvider: undefined },
        async (detail) => {
          const handle = await reasoningState.store({
            data: detail.data,
            format: detail.format ?? 'unknown',
            userId,
            connectionId: connection.id,
            upstreamModelId: model.upstreamModelId,
            createdAt: Date.now(),
          });
          logWarn('foreign encrypted reasoning stored', {
            upstreamModelId: model.upstreamModelId,
            format: detail.format,
          });
          return handle;
        },
      ),
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
