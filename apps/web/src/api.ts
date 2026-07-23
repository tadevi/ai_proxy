export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(path, {
    ...init,
    headers,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      (body as { error?: string; message?: string }).error ??
        (body as { message?: string }).message ??
        `Request failed (${response.status})`,
    );
  return body as T;
}
export type CliproxyAccount = {
  id: string;
  provider: string;
  prefix: string;
  label?: string | null;
  createdAt: string;
};
export type ProviderConnection = {
  id: string;
  displayName: string;
  baseUrl: string;
  enabled: boolean;
};
export type ConnectionToken = {
  id: string;
  connectionId: string;
  name: string;
  keyPreview?: string | null;
  enabled: boolean;
  cooldownUntil?: string | null;
  latestError?: Record<string, unknown> | null;
  latestErrorAt?: string | null;
  createdAt: string;
};
export type ModelBinding = {
  id: string;
  connectionId: string;
  // Only present from /api/bindings (the cross-connection list) — omitted from
  // /api/connections/:id/bindings since the connection is already implied there.
  connectionName?: string;
  presetId: string;
  presetDisplayName: string;
  presetUpstreamModelId: string;
  apiFormat: string;
  providerBasePath: string;
  createdAt: string;
};
export type Model = {
  id: string;
  displayName: string;
  upstreamModelId: string;
  providerConnectionId: string;
  providerConnectionName: string;
  bindingId: string | null;
  tokenId: string | null;
  tokenName: string | null;
  // Read-only — reflects the token's own state, only Tokens (on the connection) can change it.
  tokenEnabled: boolean | null;
  tokenCooldownUntil?: string | null;
  apiFormat: 'openai_compatible' | 'anthropic_compatible';
  providerBasePath: string;
  requestPathOverride?: string | null;
  providerEnabled: boolean;
  enabled: boolean;
  maxOutputTokens?: number | null;
  supportsStreaming: string;
  supportsTools: string;
  supportsImages: string;
  supportsReasoning: string;
  latestTestStatus?: string;
  latestError?: Record<string, unknown> | null;
  latestErrorAt?: string | null;
};
export type MappingRoute = {
  routeId: string;
  bindingId: string;
  enabled: boolean;
  position: number;
  presetDisplayName: string;
  presetUpstreamModelId: string;
  providerConnectionName: string;
  apiFormat: string;
};
export type Mapping = { alias: string; routes: MappingRoute[] };
export type Preset = {
  id: string;
  userId: string | null;
  displayName: string;
  upstreamModelId: string;
  apiFormat: 'openai_compatible' | 'anthropic_compatible';
  supportsImages: string;
  supportsReasoning: string;
  maxOutputTokens?: number | null;
  createdAt: string;
  updatedAt: string;
};
