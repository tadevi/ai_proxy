import {
  type AnthropicRequest,
  type Rule,
  normalizeThinking,
} from '@gateway/protocol';
import {
  bindingRoutes,
  connectionTokens,
  providerConnections,
} from '@gateway/db';

export type BindingRoute = typeof bindingRoutes.$inferSelect;
export type Model = BindingRoute;
export type ProviderConnection = typeof providerConnections.$inferSelect;
export type ConnectionToken = typeof connectionTokens.$inferSelect;

export type ResolvedModel = {
  model: Model;
  connection: ProviderConnection;
  token: ConnectionToken | null;
  rules: Rule[];
};
export type ResolvedModelBase = Omit<ResolvedModel, 'rules'>;
export type Attempt = { resolved: ResolvedModel; routeIndex: number };

export type ProviderErrorDetails = {
  upstreamStatus: number;
  requestId?: string;
  response?: Record<string, unknown>;
};

export const fallbackStatuses = new Set([429, 500, 502, 503, 504]);
export const cooldownStatuses = new Set([403]);
export const disableStatuses = new Set([401, 402]);
export const disableErrorTypes = new Set(['insufficient_balance', 'quota_exceeded', 'billing_error']);

export function isCliproxyCredentialCooldown(failure: UpstreamFailure) {
  const message = failure.providerError?.response?.message;
  return (
    failure.status === 429 &&
    typeof message === 'string' &&
    /^All credentials for model .+ are cooling down$/i.test(message)
  );
}
export const cooldownDurationMs = 60 * 60 * 1_000;
export const fallbackCooldownDurationMs = 5 * 60 * 1_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function safeProviderMessage(status: number) {
  return status === 401 || status === 403
    ? 'The provider rejected the configured API key.'
    : status === 404
      ? 'The upstream endpoint or model was not found.'
      : `The upstream provider returned HTTP ${status}.`;
}

export class UpstreamFailure extends Error {
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

export function isDisableError(
  status: number,
  providerError?: ProviderErrorDetails,
): boolean {
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

export function thinkingLogConfig(request: AnthropicRequest) {
  const normalized = normalizeThinking(request.thinking, request.output_config);
  const raw = isRecord(request.thinking) ? request.thinking : undefined;
  const type = typeof raw?.type === 'string' ? raw.type : undefined;
  if (!normalized.enabled && !type) return null;
  return {
    enabled: normalized.enabled,
    ...(type ? { type } : {}),
    ...(normalized.effort ? { effort: normalized.effort } : {}),
    ...(normalized.budgetTokens ? { budgetTokens: normalized.budgetTokens } : {}),
  };
}

function containsImageContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsImageContent(item));
  if (!isRecord(value)) return false;
  if (value.type === 'image' || value.type === 'image_url' || value.type === 'input_image')
    return true;
  return value.type === 'tool_result' && containsImageContent(value.content);
}

export function requestContainsImages(request: AnthropicRequest) {
  return request.messages.some((message) => containsImageContent(message.content));
}

export function isImageCapabilityFailure(failure: UpstreamFailure) {
  if (failure.status !== 404) return false;
  const detail = JSON.stringify(failure.providerError ?? {}).toLowerCase();
  return detail.includes('image') && /(no endpoints?|not support|unsupported)/.test(detail);
}

